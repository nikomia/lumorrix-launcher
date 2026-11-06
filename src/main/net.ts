import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Cancelled, UserError } from './errors'

const READ_TIMEOUT_MS = 30_000
const USER_AGENT = 'LumorrixLauncher'

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status}: ${url}`)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let active: AbortController | null = null

/** Текущая установка, которую игрок может отменить. Одновременно идёт только одна. */
export function startCancelable(): void {
  active = new AbortController()
}

export function finishCancelable(): void {
  active = null
}

export const cancelActive = () => active?.abort()
export const cancelSignal = () => active?.signal

export function throwIfCancelled(): void {
  if (active?.signal.aborted) throw new Cancelled()
}

/** Запрос с таймаутом на отсутствие данных: abort() вызывается, если поток молчит дольше READ_TIMEOUT_MS. */
async function request(url: string, onChunk: (chunk: Uint8Array) => Promise<void> | void): Promise<void> {
  throwIfCancelled()
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
  const alive = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
  }
  try {
    const response = await fetch(url, {
      signal: active ? AbortSignal.any([controller.signal, active.signal]) : controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache' },
    })
    if (!response.ok || !response.body) {
      throw new HttpError(response.status, url)
    }
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      alive()
      await onChunk(chunk)
    }
  } catch (error) {
    throwIfCancelled()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchText(url: string, retries = 3): Promise<string> {
  let last: unknown
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const chunks: Uint8Array[] = []
      await request(url, (chunk) => void chunks.push(chunk))
      return Buffer.concat(chunks).toString('utf8')
    } catch (error) {
      last = error
      if (error instanceof Cancelled || (error instanceof HttpError && error.status === 404)) break
      if (attempt < retries) await sleep(1000 * attempt)
    }
  }
  throw last
}

export interface DownloadOptions {
  sha1?: string
  size?: number
  retries?: number
  /** Прирост скачанных байт; при неудачной попытке приходит отрицательное значение. */
  onBytes?: (delta: number) => void
}

/** Скачивает в dest.part и переименовывает только после проверки, поэтому в dest всегда целый файл. */
export async function downloadFile(url: string, dest: string, options: DownloadOptions = {}): Promise<void> {
  const { sha1, size, retries = 5, onBytes } = options
  await mkdir(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  let last: unknown
  for (let attempt = 1; attempt <= retries; attempt++) {
    let counted = 0
    try {
      const hash = createHash('sha1')
      const file = await open(part, 'w')
      try {
        await request(url, async (chunk) => {
          await file.write(chunk)
          hash.update(chunk)
          counted += chunk.length
          onBytes?.(chunk.length)
        })
      } finally {
        await file.close()
      }
      const got = hash.digest('hex')
      if (sha1 && got !== sha1) throw new Error(`Контрольная сумма не совпала: ${url}`)
      if (size !== undefined && counted !== size) throw new Error(`Размер не совпал: ${url}`)
      await rename(part, dest)
      return
    } catch (error) {
      last = error
      onBytes?.(-counted)
      if (error instanceof Cancelled || (error instanceof HttpError && error.status === 404)) break
      if (attempt < retries) await sleep(1000 * attempt)
    }
  }
  await rm(part, { force: true })
  throw last
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** Параллельная обработка с ограничением. После первой ошибки новые задачи не начинаются. */
export async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  let firstError: unknown
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]
      try {
        throwIfCancelled()
        await task(item)
      } catch (error) {
        if (!failed) firstError = error
        failed = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failed) throw firstError
}

export async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

export function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1).replace('.', ',')} ГБ` : `${Math.ceil(bytes / 1024 ** 2)} МБ`
}

export async function ensureFreeSpace(dir: string, needed: number): Promise<void> {
  await mkdir(dir, { recursive: true })
  const info = await statfs(dir)
  const free = info.bavail * info.bsize
  if (free < needed) {
    throw new UserError(
      'Не хватает места на диске',
      `Нужно ${formatSize(needed)}, свободно ${formatSize(free)}. Освободите место и попробуйте ещё раз.`,
    )
  }
}
