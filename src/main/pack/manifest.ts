/** Манифест сборки. Формат описан в modpack-updater/src/ru/lumorrix/updater/Manifest.java. */
export interface ManifestEntry {
  sha1: string
  size: number
  mode: string
  path: string
}

export interface Manifest {
  version: string
  filesBase: string
  entries: ManifestEntry[]
  /** Клиентский мод → его modId: выбор игрока переживает смену файла при обновлении. */
  clientIds: Map<string, string>
}

const FORMAT = 1

export function parseManifest(text: string, manifestUrl: string): Manifest {
  const manifest: Manifest = {
    version: '?',
    filesBase: new URL('files/', manifestUrl).href,
    entries: [],
    clientIds: new Map(),
  }
  let format = -1
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (raw.startsWith('C\t')) {
      const parts = raw.split('\t')
      if (parts.length === 3) manifest.clientIds.set(parts[1].replaceAll('\\', '/'), parts[2].trim())
      continue
    }
    if (raw.startsWith('F\t')) {
      const parts = raw.split('\t')
      const sha1 = parts[1]?.toLowerCase() ?? ''
      if (parts.length < 5 || !/^[0-9a-f]{40}$/.test(sha1)) throw new Error(`Битая строка манифеста: ${raw}`)
      manifest.entries.push({
        sha1,
        size: Number(parts[2]),
        mode: parts[3],
        path: parts.slice(4).join('\t').replaceAll('\\', '/'),
      })
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'format') format = Number(value)
    else if (key === 'version') manifest.version = value
    else if (key === 'files') manifest.filesBase = new URL(value.endsWith('/') ? value : `${value}/`, manifestUrl).href
  }
  if (format !== FORMAT) throw new Error(`Неподдерживаемый формат манифеста: ${format}`)
  return manifest
}

/** Ключ для запоминания выбора игрока: modId, а если его нет — путь. */
export function clientKey(manifest: Manifest, entry: ManifestEntry): string {
  return manifest.clientIds.get(entry.path) ?? entry.path
}
