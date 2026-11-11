import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import yauzl from 'yauzl'
import { modGroup } from '../../shared/modinfo'
import type { Preset } from '../../shared/types'
import { downloadFile, fetchText, fileSize, runPool } from '../net'
import { clientKey, type Manifest, type ManifestEntry, parseManifest } from './manifest'
import { DISABLED_SUFFIX } from './sync'

export interface ModMeta {
  ids: string[]
  name: string
  description: string
  /** Путь к логотипу внутри jar; пустой, если логотипа нет. */
  logo: string
  /** modId обязательных зависимостей, кроме самой игры и загрузчика. */
  requires: string[]
}

export interface ModInfo extends ModMeta {
  /** Имя файла без .disabled. */
  file: string
  kind: 'client' | 'user'
  enabled: boolean
}

const BUILTIN = new Set(['minecraft', 'neoforge', 'forge', 'fml', 'java', 'javafml'])

/**
 * Клиентские библиотеки: сами по себе ничего не дают игроку, поэтому в списке не показываются,
 * а лаунчер включает их только для модов, которым они нужны. Серверным модам клиентские библиотеки
 * нужны быть не могут: иначе не запустился бы сам сервер, где этих библиотек нет.
 */
const LIBRARIES = new Set(['toadlib', 'searchables', 'emf_compat_core'])

/**
 * Зависимости, которых нет в описании мода, проверены по содержимому jar и запуском игры:
 * gpu_booster использует классы ToadLib, Iris построен на Sodium, а Draconic Evolution Render Patcher
 * без Sodium роняет запуск игры: «requires either Embeddium OR Sodium».
 */
const UNDECLARED_REQUIRES: Record<string, string[]> = {
  gpu_booster: ['toadlib'],
  iris: ['sodium'],
  derenderpatcher: ['sodium'],
}

function withKnownRequires(meta: ModMeta): ModMeta {
  const extra = meta.ids.flatMap((id) => (Object.hasOwn(UNDECLARED_REQUIRES, id) ? UNDECLARED_REQUIRES[id] : []))
  return extra.length ? { ...meta, requires: [...new Set([...meta.requires, ...extra])] } : meta
}

/** Необязательные моды с повышенным риском: у нового игрока они выключены, но он может включить их сам. */
export const DEFAULT_OFF = ['gpu_booster']

/**
 * Применяет DEFAULT_OFF один раз для каждого мода. Уже применённые не трогает,
 * чтобы не выключать снова то, что игрок включил сам. Возвращает все применённые.
 */
export function applyDefaultOff(disabled: Set<string>, applied: string[]): string[] {
  for (const id of DEFAULT_OFF) {
    if (!applied.includes(id)) disabled.add(id)
  }
  return [...new Set([...applied, ...DEFAULT_OFF])]
}

export const isLibrary = (mod: ModInfo) => mod.kind === 'client' && mod.ids.some((id) => LIBRARIES.has(id))

/** Исправления включены, пока включены моды, которым они нужны: выбирать тут нечего. */
export const isFix = (mod: ModInfo) => mod.kind === 'client' && mod.ids.some((id) => modGroup(id) === 'Исправления')

/** Библиотеки и исправления лаунчер ведёт сам, игрок их не видит. */
export const isHidden = (mod: ModInfo) => isLibrary(mod) || isFix(mod)

/**
 * Должен ли мод быть включён в наборе. WorldMap в сборке обязательный, поэтому отдельно его не упоминаем.
 * Моды из DEFAULT_OFF наборы не включают: игрок может включить их сам.
 */
export function presetWants(preset: Preset, mod: ModInfo): boolean {
  if (preset === 'custom' || mod.ids.some((id) => DEFAULT_OFF.includes(id))) return false
  if (preset === 'quality') return true
  // Моды удобства работают по действиям игрока и на FPS почти не влияют, выключать их незачем.
  return mod.ids.some((id) => modGroup(id) === 'Производительность' || modGroup(id) === 'Удобство')
}

export function parseModsToml(text: string): ModMeta | null {
  let data: Record<string, unknown>
  try {
    data = parseToml(text) as Record<string, unknown>
  } catch {
    return null
  }
  const mods = Array.isArray(data.mods) ? (data.mods as Record<string, unknown>[]) : []
  if (!mods.length) return null
  const ids = mods.map((mod) => String(mod.modId ?? '')).filter(Boolean)
  const requires = new Set<string>()
  const dependencies = (data.dependencies ?? {}) as Record<string, unknown>
  for (const list of Object.values(dependencies)) {
    if (!Array.isArray(list)) continue
    for (const dep of list as Record<string, unknown>[]) {
      const id = String(dep.modId ?? '')
      const type = String(dep.type ?? (dep.mandatory ? 'required' : 'optional')).toLowerCase()
      const side = String(dep.side ?? 'BOTH').toUpperCase()
      if (id && type === 'required' && side !== 'SERVER' && !BUILTIN.has(id) && !ids.includes(id)) requires.add(id)
    }
  }
  const first = mods[0]
  return {
    ids,
    name: String(first.displayName ?? ids[0] ?? ''),
    description: String(first.description ?? '').replace(/\s+/g, ' ').trim(),
    logo: String(first.logoFile ?? data.logoFile ?? '').replace(/^\/+/, ''),
    requires: [...requires],
  }
}

export function readZipEntry(file: string, entryName: string, maxBytes = 2 * 1024 * 1024): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error('zip'))
      zip.on('error', reject)
      zip.on('end', () => resolve(null))
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== entryName) return zip.readEntry()
        if (entry.uncompressedSize > maxBytes) {
          zip.close()
          return resolve(null)
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error('zip'))
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('error', reject)
          stream.on('end', () => {
            zip.close()
            resolve(Buffer.concat(chunks))
          })
        })
      })
      zip.readEntry()
    })
  })
}

type MetaCache = Record<string, { stamp: string; meta: ModMeta }>

const fallbackMeta = (file: string): ModMeta => ({ ids: [], name: file.replace(/\.jar$/i, ''), description: '', logo: '', requires: [] })

/** Файл с исходным логотипом мода рядом с кэшем описаний. */
export const modIconPath = (metaCachePath: string, id: string) => join(dirname(metaCachePath), 'mod-icons', encodeURIComponent(id))

/** Описание мода из jar, без логотипа. */
export async function readJarMeta(jar: string, file: string): Promise<ModMeta> {
  const toml = await readZipEntry(jar, 'META-INF/neoforge.mods.toml').catch(() => null)
  return (toml && parseModsToml(toml.toString('utf8'))) || fallbackMeta(file)
}

/** Есть ли файл в jar. Читается только оглавление архива. */
export function zipHasEntry(file: string, entryName: string): Promise<boolean> {
  return new Promise((resolve) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) return resolve(false)
      zip.on('error', () => resolve(false))
      zip.on('end', () => resolve(false))
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName === entryName) {
          zip.close()
          resolve(true)
        } else {
          zip.readEntry()
        }
      })
      zip.readEntry()
    })
  })
}

/** Читает описание мода из jar и сохраняет его логотип. */
async function readMeta(jar: string, file: string, metaCachePath: string): Promise<ModMeta> {
  const toml = await readZipEntry(jar, 'META-INF/neoforge.mods.toml').catch(() => null)
  const meta = (toml && parseModsToml(toml.toString('utf8'))) || fallbackMeta(file)
  if (meta.logo && meta.ids[0]) {
    const icon = await readZipEntry(jar, meta.logo).catch(() => null)
    if (icon) {
      const target = modIconPath(metaCachePath, meta.ids[0])
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, icon)
    }
  }
  return meta
}

/** Кэш прежних версий лаунчера не знает про логотипы, такие записи читаем заново. */
const validCache = (entry: MetaCache[string] | undefined, stamp: string) => entry?.stamp === stamp && typeof entry.meta.logo === 'string'

/** Показ модов до установки. */
export interface ModPreview {
  /** Папка скачанных файлов сборки: отсюда их потом заберёт установка, повторно качать не придётся. */
  blobDir: string
  disabled: Set<string>
}

/** Свежий манифест для списка модов до установки. */
export async function refreshManifest(manifestUrl: string, manifestCache: string): Promise<void> {
  const url = new URL(manifestUrl)
  url.searchParams.set('t', String(Date.now()))
  const text = await fetchText(url.href)
  parseManifest(text, manifestUrl)
  await mkdir(dirname(manifestCache), { recursive: true })
  await writeFile(manifestCache, text, 'utf8')
}

/**
 * Клиентские и свои моды. Серверные в список не входят: их выключать нельзя. Метаданные кэшируются в metaCachePath.
 * С preview показывает и ещё не установленные клиентские моды: их описания лежат только внутри jar.
 */
export async function listMods(
  gameDir: string,
  manifestUrl: string,
  manifestCache: string,
  metaCachePath: string,
  preview?: ModPreview,
): Promise<ModInfo[]> {
  const manifest = await loadManifest(manifestUrl, manifestCache)
  const modes = new Map(manifest?.entries.map((entry) => [entry.path, entry.mode]) ?? [])
  const modsDir = join(gameDir, 'mods')
  const names = await readdir(modsDir).catch(() => [] as string[])
  let cache: MetaCache = {}
  try {
    cache = JSON.parse(await readFile(metaCachePath, 'utf8'))
  } catch {
    cache = {}
  }
  const nextCache: MetaCache = {}
  const mods: ModInfo[] = []
  for (const name of names) {
    const lower = name.toLowerCase()
    const enabled = lower.endsWith('.jar')
    if (!enabled && !lower.endsWith(`.jar${DISABLED_SUFFIX}`)) continue
    const file = enabled ? name : name.slice(0, -DISABLED_SUFFIX.length)
    const mode = modes.get(`mods/${file}`)
    if (mode && mode !== 'client') continue
    const path = join(modsDir, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) continue
    const stamp = `${info.size}:${Math.trunc(info.mtimeMs)}`
    const meta = validCache(cache[file], stamp) ? cache[file].meta : await readMeta(path, file, metaCachePath)
    nextCache[file] = { stamp, meta }
    mods.push({ ...withKnownRequires(meta), file, kind: mode === 'client' ? 'client' : 'user', enabled })
  }

  if (manifest && preview) {
    const present = new Set(mods.map((mod) => mod.file))
    const absent = manifest.entries.filter(
      (entry) => entry.mode === 'client' && /^mods\/[^/]+$/.test(entry.path) && !present.has(entry.path.slice('mods/'.length)),
    )
    const stampOf = (entry: ManifestEntry) => `sha1:${entry.sha1}`
    const fileOf = (entry: ManifestEntry) => entry.path.slice('mods/'.length)
    const toFetch = absent.filter((entry) => !validCache(cache[fileOf(entry)], stampOf(entry)))
    await runPool(toFetch, 4, async (entry) => {
      const blob = join(preview.blobDir, entry.sha1)
      if ((await fileSize(blob)) !== entry.size) {
        await downloadFile(new URL(entry.sha1, manifest.filesBase).href, blob, { sha1: entry.sha1, size: entry.size })
      }
    })
    for (const entry of absent) {
      const file = fileOf(entry)
      const stamp = stampOf(entry)
      const meta = validCache(cache[file], stamp) ? cache[file].meta : await readMeta(join(preview.blobDir, entry.sha1), file, metaCachePath)
      nextCache[file] = { stamp, meta }
      mods.push({ ...withKnownRequires(meta), file, kind: 'client', enabled: !preview.disabled.has(clientKey(manifest, entry)) })
    }
  }
  await mkdir(dirname(metaCachePath), { recursive: true })
  await writeFile(metaCachePath, JSON.stringify(nextCache), 'utf8')
  return mods.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'ru'))
}

async function loadManifest(manifestUrl: string, manifestCache: string): Promise<Manifest | null> {
  try {
    return parseManifest(await readFile(manifestCache, 'utf8'), manifestUrl)
  } catch {
    return null
  }
}

/** Включённые моды, которые перестанут работать без target. Транзитивно, без самого target. */
export function dependentsOf(mods: ModInfo[], target: ModInfo): ModInfo[] {
  const lost = new Set(target.ids)
  const result: ModInfo[] = []
  for (let changed = true; changed; ) {
    changed = false
    for (const mod of mods) {
      if (mod === target || !mod.enabled || result.includes(mod)) continue
      if (mod.requires.some((id) => lost.has(id))) {
        result.push(mod)
        mod.ids.forEach((id) => lost.add(id))
        changed = true
      }
    }
  }
  return result
}

/** Выключенные моды, без которых target не запустится. Транзитивно, без самого target. */
export function requirementsOf(mods: ModInfo[], target: ModInfo): ModInfo[] {
  const result: ModInfo[] = []
  const visit = (mod: ModInfo) => {
    for (const id of mod.requires) {
      const dep = mods.find((candidate) => candidate.ids.includes(id))
      if (dep && dep !== target && !result.includes(dep)) {
        if (!dep.enabled) result.push(dep)
        visit(dep)
      }
    }
  }
  visit(target)
  return result
}

/** Какие скрытые моды включить и выключить: исправления и библиотеки работают только там, где нужны и могут работать. */
export function libraryChanges(mods: ModInfo[]): { enable: string[]; disable: string[] } {
  const libraries = mods.filter(isLibrary)
  const fixes = mods.filter(isFix)
  // Исправление без нужного ему мода из сборки может уронить запуск игры, поэтому его тоже выключаем.
  const visible = new Set(mods.filter((mod) => mod.kind === 'client' && !isHidden(mod)).flatMap((mod) => mod.ids))
  const running = new Set(mods.filter((mod) => mod.enabled && !isHidden(mod)).flatMap((mod) => mod.ids))
  const fixWorks = (mod: ModInfo) => mod.requires.every((id) => !visible.has(id) || running.has(id))
  const active = mods.filter((mod) => (isFix(mod) ? fixWorks(mod) : !isLibrary(mod) && mod.enabled))
  const needed = new Set<ModInfo>()
  const visit = (requires: string[]) => {
    for (const id of requires) {
      const library = libraries.find((item) => item.ids.includes(id))
      if (library && !needed.has(library)) {
        needed.add(library)
        visit(library.requires)
      }
    }
  }
  active.forEach((mod) => visit(mod.requires))
  // Описание включённого мода не прочиталось: его зависимости неизвестны, поэтому ничего не выключаем.
  const unknown = active.some((mod) => !mod.ids.length)
  return {
    enable: [...libraries.filter((mod) => !mod.enabled && needed.has(mod)), ...fixes.filter((mod) => !mod.enabled && fixWorks(mod))].map((mod) => mod.file),
    disable: [...(unknown ? [] : libraries.filter((mod) => mod.enabled && !needed.has(mod))), ...fixes.filter((mod) => mod.enabled && !fixWorks(mod))].map((mod) => mod.file),
  }
}

/** Приводит библиотеки в соответствие с включёнными модами. */
export async function settleLibraries(gameDir: string, manifestUrl: string, manifestCache: string, disabled: Set<string>, mods: ModInfo[]): Promise<void> {
  const { enable, disable } = libraryChanges(mods)
  if (enable.length) await setModsEnabled(gameDir, manifestUrl, manifestCache, disabled, enable, true)
  if (disable.length) await setModsEnabled(gameDir, manifestUrl, manifestCache, disabled, disable, false)
}

/** Мгновенно переключает моды переименованием и запоминает выбор для будущих версий. */
export async function setModsEnabled(
  gameDir: string,
  manifestUrl: string,
  manifestCache: string,
  disabled: Set<string>,
  files: string[],
  enabled: boolean,
): Promise<void> {
  const manifest = await loadManifest(manifestUrl, manifestCache)
  const modsDir = join(gameDir, 'mods')
  for (const file of files) {
    if (file.includes('/') || file.includes('\\') || file.includes('..')) continue
    const on = join(modsDir, file)
    const off = on + DISABLED_SUFFIX
    const [from, to] = enabled ? [off, on] : [on, off]
    const source = await stat(from).catch(() => null)
    if (source?.isFile()) {
      await rm(to, { force: true })
      await rename(from, to)
    }
    const entry = manifest?.entries.find((item) => item.path === `mods/${file}` && item.mode === 'client')
    if (manifest && entry) {
      const key = clientKey(manifest, entry)
      if (enabled) disabled.delete(key)
      else disabled.add(key)
    }
  }
}
