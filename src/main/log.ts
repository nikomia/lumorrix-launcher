import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './paths'

const file = join(paths.logs, 'launcher.log')
let ready = false

/** Лог перезаписывается при каждом запуске лаунчера, поэтому не разрастается. */
export function log(message: string, error?: unknown): void {
  const detail = error instanceof Error ? ` ${error.stack ?? error.message}` : error ? ` ${String(error)}` : ''
  const line = `${new Date().toISOString()} ${message}${detail}\n`
  try {
    if (!ready) {
      mkdirSync(paths.logs, { recursive: true })
      writeFileSync(file, '')
      ready = true
    }
    appendFileSync(file, line)
  } catch {
    // Лог не должен мешать запуску.
  }
}
