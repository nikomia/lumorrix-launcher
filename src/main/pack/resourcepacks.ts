import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Manifest } from './manifest'

/** Версия данных 1.21.1: нужна, если options.txt ещё нет. */
const OPTIONS_DATA_VERSION = 3955

async function readLines(file: string): Promise<string[] | null> {
  try {
    return (await readFile(file, 'utf8')).split(/\r?\n/).filter((line, i, all) => line || i < all.length - 1)
  } catch {
    return null
  }
}

/**
 * Включает ресурспаки сборки в options.txt по одному разу (как Updater.enableResourcePacks):
 * если игрок выключит пак сам, обратно он не включится. Новый options.txt сразу на русском.
 */
export async function enableResourcePacks(gameDir: string, home: string, manifest: Manifest): Promise<void> {
  const packs = manifest.entries
    .map((entry) => /^resourcepacks\/([^/]+\.zip)$/.exec(entry.path)?.[1])
    .filter((name): name is string => !!name)
    .map((name) => `file/${name}`)
  const doneFile = join(home, 'resourcepacks.txt')
  const done = new Set(await readLines(doneFile) ?? [])
  const toEnable = packs.filter((pack) => !done.has(pack))
  if (!toEnable.length) return

  const options = join(gameDir, 'options.txt')
  const lines = (await readLines(options)) ?? [`version:${OPTIONS_DATA_VERSION}`, 'lang:ru_ru']
  const index = lines.findIndex((line) => line.startsWith('resourcePacks:'))
  let enabled: unknown[] = []
  if (index >= 0) {
    try {
      const parsed = JSON.parse(lines[index].slice('resourcePacks:'.length))
      if (Array.isArray(parsed)) enabled = parsed
    } catch {
      enabled = []
    }
  }
  if (!enabled.includes('vanilla')) enabled.unshift('vanilla')
  for (const pack of toEnable) {
    if (!enabled.includes(pack)) enabled.push(pack)
  }
  const line = `resourcePacks:${JSON.stringify(enabled)}`
  if (index >= 0) lines[index] = line
  else lines.push(line)

  const tmp = `${options}.lumorrix-tmp`
  await writeFile(tmp, `${lines.join('\n')}\n`, 'utf8')
  await rename(tmp, options)
  for (const pack of toEnable) done.add(pack)
  await writeFile(doneFile, `${[...done].join('\n')}\n`, 'utf8')
}
