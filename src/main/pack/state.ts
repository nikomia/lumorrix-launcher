import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Формат config/lumorrix/updater/state.tsv совпадает с State.java. */
export interface Installed {
  sha1: string
  mode: string
}

export interface Cached {
  size: number
  mtime: number
  sha1: string
}

export interface PackState {
  installed: Map<string, Installed>
  cache: Map<string, Cached>
}

export async function loadState(file: string): Promise<PackState> {
  const state: PackState = { installed: new Map(), cache: new Map() }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return state
  }
  for (const line of text.split('\n')) {
    const parts = line.split('\t')
    if (parts.length === 4 && parts[0] === 'I') {
      state.installed.set(parts[1], { sha1: parts[2], mode: parts[3] })
    } else if (parts.length === 5 && parts[0] === 'C') {
      const size = Number(parts[2])
      const mtime = Number(parts[3])
      if (Number.isFinite(size) && Number.isFinite(mtime)) state.cache.set(parts[1], { size, mtime, sha1: parts[4] })
    }
  }
  return state
}

export async function saveState(file: string, state: PackState): Promise<void> {
  const lines: string[] = []
  for (const [path, item] of state.installed) lines.push(`I\t${path}\t${item.sha1}\t${item.mode}`)
  for (const [path, item] of state.cache) lines.push(`C\t${path}\t${item.size}\t${item.mtime}\t${item.sha1}`)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${lines.join('\n')}\n`, 'utf8')
  await rename(tmp, file)
}
