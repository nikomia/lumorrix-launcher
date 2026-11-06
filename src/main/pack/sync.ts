import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Cancelled, NETWORK_HINT, UserError } from '../errors'
import { downloadFile, ensureFreeSpace, fetchText, fileSize, hashFile, HttpError, runPool, throwIfCancelled } from '../net'
import { clientKey, type Manifest, type ManifestEntry, parseManifest } from './manifest'
import { enableResourcePacks } from './resourcepacks'
import { loadState, type PackState, saveState } from './state'

export const DISABLED_SUFFIX = '.disabled'
const THREADS = 4
const SPACE_MARGIN = 200 * 1024 * 1024

export type SyncProgress =
  | { phase: 'checking'; done: number; total: number }
  | { phase: 'downloading'; done: number; total: number }
  | { phase: 'installing' }

export interface SyncOptions {
  gameDir: string
  tmpDir: string
  manifestUrl: string
  /** Копия последнего применённого манифеста: по ней работает список модов. */
  manifestCache: string
  /** Выключенные клиентские моды (ключи modId). Обновляется, если игрок переименовал файл сам. */
  disabled: Set<string>
  /** Считать хеши заново, не доверяя кэшу («Проверить игровые файлы»). */
  rehash?: boolean
  /** Папка для состояния и версии. По умолчанию та же, что у мода: config/lumorrix/updater в папке игры. */
  stateDir?: string
  threads?: number
  onProgress?: (progress: SyncProgress) => void
}

export interface SyncResult {
  version: string
  downloaded: number
  removed: number
}

const updaterHome = (gameDir: string) => join(gameDir, 'config', 'lumorrix', 'updater')

/** Путь из манифеста → файл в папке игры; null, если путь пытается выйти за её пределы. */
export function safeTarget(gameDir: string, rel: string): string | null {
  if (!rel || rel.startsWith('/') || rel.includes(':') || rel.includes('..')) return null
  const root = resolve(gameDir)
  const target = resolve(root, rel)
  const fromRoot = relative(root, target)
  const home = resolve(updaterHome(gameDir))
  if (!fromRoot || fromRoot.startsWith('..') || target === home || target.startsWith(home + sep)) return null
  return target
}

const exists = async (path: string) => (await fileSize(path)) !== null

/** Если игрок переименовал клиентский мод сам, верим файлу. Если есть обе копии, выбор игрока важнее. */
async function reconcileDisabled(gameDir: string, manifest: Manifest, disabled: Set<string>): Promise<void> {
  for (const entry of manifest.entries) {
    if (entry.mode !== 'client') continue
    const target = safeTarget(gameDir, entry.path)
    if (!target) continue
    const key = clientKey(manifest, entry)
    const on = await exists(target)
    const off = await exists(target + DISABLED_SUFFIX)
    if (on && off) await rm(disabled.has(key) ? target : target + DISABLED_SUFFIX)
    else if (on) disabled.delete(key)
    else if (off) disabled.add(key)
  }
}

async function cachedHash(state: PackState, gameDir: string, file: string): Promise<string | null> {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return null
  const key = relative(gameDir, file).replaceAll('\\', '/')
  const mtime = Math.trunc(info.mtimeMs)
  const cached = state.cache.get(key)
  if (cached && cached.size === info.size && cached.mtime === mtime) return cached.sha1
  const sha1 = await hashFile(file)
  state.cache.set(key, { size: info.size, mtime, sha1 })
  return sha1
}

function shouldDownload(entry: ManifestEntry, current: string | null, state: PackState): boolean {
  switch (entry.mode) {
    case 'sync':
    case 'self':
    case 'client':
      return current !== entry.sha1
    case 'config': {
      // Игрок поменял конфиг (хеш не совпадает с тем, что мы клали) — не трогаем.
      const record = state.installed.get(entry.path)
      return current === null || (current !== entry.sha1 && (!record || record.sha1 === current))
    }
    case 'once':
      return current === null && !state.installed.has(entry.path)
    default:
      return false
  }
}

async function moveWithRetry(from: string, to: string, keepSource: boolean): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  for (let attempt = 1; ; attempt++) {
    try {
      if (keepSource) await copyFile(from, to)
      else await rename(from, to)
      return
    } catch (error) {
      // Файл может ненадолго держать антивирус или индексатор.
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw error
      await new Promise((done) => setTimeout(done, 500 * attempt))
    }
  }
}

async function runSync(options: SyncOptions, text: string): Promise<SyncResult> {
  const { gameDir, tmpDir, disabled, onProgress } = options
  const manifest = parseManifest(text, options.manifestUrl)
  const home = options.stateDir ?? updaterHome(gameDir)
  await mkdir(home, { recursive: true })
  const stateFile = join(home, 'state.tsv')
  const state = await loadState(stateFile)
  if (options.rehash) state.cache.clear()
  await reconcileDisabled(gameDir, manifest, disabled)

  const physical = (entry: ManifestEntry, target: string) =>
    entry.mode === 'client' && disabled.has(clientKey(manifest, entry)) ? target + DISABLED_SUFFIX : target

  // 1. Что скачать.
  const known = new Set<string>()
  const queue: { entry: ManifestEntry; target: string }[] = []
  let checked = 0
  for (const entry of manifest.entries) {
    throwIfCancelled()
    onProgress?.({ phase: 'checking', done: ++checked, total: manifest.entries.length })
    const base = safeTarget(gameDir, entry.path)
    if (!base) continue
    known.add(entry.path)
    const target = physical(entry, base)
    const current = await cachedHash(state, gameDir, target)
    if (shouldDownload(entry, current, state)) queue.push({ entry, target })
    else if (current === entry.sha1) state.installed.set(entry.path, { sha1: entry.sha1, mode: entry.mode })
  }

  // 2. Что убрать: только файлы, которые клали мы и которых больше нет в сборке.
  const toDelete: string[] = []
  for (const [path, record] of [...state.installed]) {
    if (known.has(path)) continue
    state.installed.delete(path)
    if (record.mode === 'self') continue
    const base = safeTarget(gameDir, path)
    if (!base) continue
    for (const file of [base, base + DISABLED_SUFFIX]) {
      if (!(await exists(file))) continue
      const ours = record.mode === 'sync' || record.mode === 'client' || record.sha1 === (await cachedHash(state, gameDir, file))
      if (ours) toDelete.push(file)
    }
  }

  // 3. Скачиваем во временную папку и пока не трогаем сборку. Проверенные файлы остаются там до успеха,
  //    поэтому после обрыва продолжаем с них.
  const uses = new Map<string, number>()
  for (const { entry } of queue) uses.set(entry.sha1, (uses.get(entry.sha1) ?? 0) + 1)
  const blobs = [...new Map(queue.map(({ entry }) => [entry.sha1, entry])).values()]
  const total = blobs.reduce((sum, entry) => sum + entry.size, 0)
  let done = 0
  const pending: ManifestEntry[] = []
  for (const entry of blobs) {
    throwIfCancelled()
    const blob = join(tmpDir, entry.sha1)
    if ((await fileSize(blob)) === entry.size && (await hashFile(blob)) === entry.sha1) done += entry.size
    else pending.push(entry)
  }
  if (pending.length) {
    const missing = pending.reduce((sum, entry) => sum + entry.size, 0)
    await ensureFreeSpace(tmpDir, missing + SPACE_MARGIN)
    onProgress?.({ phase: 'downloading', done, total })
    await runPool(pending, options.threads ?? THREADS, (entry) =>
      downloadFile(new URL(entry.sha1, manifest.filesBase).href, join(tmpDir, entry.sha1), {
        sha1: entry.sha1,
        size: entry.size,
        onBytes: (delta) => {
          done += delta
          onProgress?.({ phase: 'downloading', done, total })
        },
      }),
    )
  }

  // 4. Применяем. С этого места отмена уже не действует, иначе сборка останется наполовину обновлённой.
  throwIfCancelled()
  onProgress?.({ phase: 'installing' })
  for (const file of toDelete) {
    await rm(file, { force: true })
    state.cache.delete(relative(gameDir, file).replaceAll('\\', '/'))
  }
  for (const { entry, target } of queue) {
    const left = (uses.get(entry.sha1) ?? 1) - 1
    uses.set(entry.sha1, left)
    await moveWithRetry(join(tmpDir, entry.sha1), target, left > 0)
    // Файл только что проверен, поэтому при следующем запуске считать хеш заново не нужно.
    const info = await stat(target)
    state.cache.set(relative(gameDir, target).replaceAll('\\', '/'), {
      size: info.size,
      mtime: Math.trunc(info.mtimeMs),
      sha1: entry.sha1,
    })
    state.installed.set(entry.path, { sha1: entry.sha1, mode: entry.mode })
    // Убираем копию в другом состоянии (включённую или выключенную), чтобы мод не лежал дважды.
    const other = target.endsWith(DISABLED_SUFFIX) ? target.slice(0, -DISABLED_SUFFIX.length) : target + DISABLED_SUFFIX
    if (entry.mode === 'client') await rm(other, { force: true })
  }
  await saveState(stateFile, state)
  await enableResourcePacks(gameDir, home, manifest)
  await mkdir(dirname(options.manifestCache), { recursive: true })
  await writeFile(options.manifestCache, text, 'utf8')
  // Версию пишем последней: по ней сервер решает, актуальна ли сборка.
  await writeFile(join(home, 'version.txt'), `${manifest.version}\n`, 'utf8')
  await rm(tmpDir, { recursive: true, force: true })
  return { version: manifest.version, downloaded: queue.length, removed: toDelete.length }
}

async function readVersion(home: string): Promise<string | null> {
  try {
    return (await readFile(join(home, 'version.txt'), 'utf8')).trim() || null
  } catch {
    return null
  }
}

export const installedVersion = (gameDir: string) => readVersion(updaterHome(gameDir))

/** Приводит файлы к манифесту. При любой ошибке скачивания установленные файлы не меняются. */
export async function syncPack(options: SyncOptions): Promise<SyncResult> {
  const canPlayOld = (await readVersion(options.stateDir ?? updaterHome(options.gameDir))) !== null
  const getManifest = async () => {
    try {
      const url = new URL(options.manifestUrl)
      url.searchParams.set('t', String(Date.now()))
      return await fetchText(url.href)
    } catch (cause) {
      if (cause instanceof Cancelled) throw cause
      throw new UserError('Нет связи с сервером', `Не удалось проверить обновления. ${NETWORK_HINT}`, { canPlayOld, cause })
    }
  }
  const attempt = async () => {
    try {
      return await runSync(options, await getManifest())
    } catch (error) {
      if (error instanceof Cancelled || error instanceof UserError || error instanceof HttpError) throw error
      if ((error as NodeJS.ErrnoException).code) throw error // ошибка диска, а не сети
      throw new UserError('Не удалось скачать файлы', `Загрузка прервалась. Уже скачанное сохранено. ${NETWORK_HINT}`, {
        canPlayOld,
        cause: error,
      })
    }
  }
  try {
    return await attempt()
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    // 404: сборку опубликовали прямо во время скачивания. Перечитываем манифест один раз.
    if (error.status === 404) {
      try {
        return await attempt()
      } catch (retryError) {
        if (!(retryError instanceof HttpError)) throw retryError
      }
    }
    throw new UserError('Не удалось скачать файлы', `Сервер вернул ошибку. Попробуйте ещё раз чуть позже.`, {
      canPlayOld,
      cause: error,
    })
  }
}
