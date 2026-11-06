import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { UserError } from '../errors'
import { fileSize } from '../net'
import { syncPack, type SyncProgress } from '../pack/sync'
import { CLIENT_MANIFEST_URL, paths } from '../paths'
import type { VersionJson } from './version'

export const MC_VERSION = '1.21.1'
export const NEOFORGE = '21.1.265'
export const NEO_ID = `neoforge-${NEOFORGE}`
const THREADS = 8
const clientState = join(paths.data, 'client')

const versionFile = (id: string) => join(paths.minecraft, 'versions', id, `${id}.json`)

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

export interface InstalledGame {
  vanilla: VersionJson
  neoforge: VersionJson
  javaw: string
}

export interface EnsureGameOptions {
  /** «Проверить игровые файлы»: считать хеши заново, не доверяя кэшу. */
  rehash?: boolean
  /** Игрок решил играть без обновления: сеть не нужна, берём то, что уже установлено. */
  skipUpdate?: boolean
  onProgress?: (progress: SyncProgress) => void
}

/**
 * Приводит Minecraft, библиотеки, ассеты и Java к версии на нашем VPS. Там же лежит уже установленный NeoForge,
 * поэтому у игрока установщик не запускается. Пути в манифесте отсчитываются от корня лаунчера: minecraft/… и runtime/….
 */
export async function ensureGame(options: EnsureGameOptions = {}): Promise<InstalledGame> {
  if (!options.skipUpdate) {
    await syncPack({
      gameDir: paths.root,
      tmpDir: join(paths.tmp, 'client'),
      manifestUrl: CLIENT_MANIFEST_URL,
      manifestCache: join(clientState, 'manifest.txt'),
      stateDir: clientState,
      disabled: new Set(),
      rehash: options.rehash,
      threads: THREADS,
      onProgress: options.onProgress,
    })
  }
  const vanilla = await readJsonFile<VersionJson>(versionFile(MC_VERSION))
  const neoforge = await readJsonFile<VersionJson>(versionFile(NEO_ID))
  const component = vanilla?.javaVersion?.component ?? 'java-runtime-delta'
  const javaw = join(paths.runtime, component, 'bin', 'javaw.exe')
  if (!vanilla || !neoforge || (await fileSize(javaw)) === null) {
    throw new UserError('Игра установлена не полностью', 'Подключитесь к интернету и нажмите «Играть» ещё раз.')
  }
  return { vanilla, neoforge, javaw }
}
