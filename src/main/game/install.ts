import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Cancelled, NETWORK_HINT, UserError } from '../errors'
import { log } from '../log'
import { downloadFile, ensureFreeSpace, fileSize, runPool } from '../net'
import { syncPack, type SyncProgress } from '../pack/sync'
import { CLIENT_MANIFEST_URL, paths } from '../paths'
import { IS_MAC, IS_WINDOWS } from '../platform'
import { libraryPath, mergeLibraries, type Artifact, type VersionJson } from './version'

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
  /** Копия jar Minecraft под именем версии NeoForge, см. ensureVersionJar. null — скопировать не удалось. */
  versionJar: string | null
}

export interface EnsureGameOptions {
  /** «Проверить игровые файлы»: считать хеши заново, не доверяя кэшу. */
  rehash?: boolean
  /** Игрок решил играть без обновления: сеть не нужна, берём то, что уже установлено. */
  skipUpdate?: boolean
  onProgress?: (progress: SyncProgress) => void
}

/**
 * Как у обычного лаунчера: копия jar Minecraft лежит в versions/<NeoForge>/<NeoForge>.jar и стоит в classpath.
 * NeoForge её не загружает (ignoreList содержит ${version_name}.jar), но моды читают из неё version.json.
 * Без него CustomSkinLoader не узнаёт версию игры и не включает загрузку скинов.
 */
async function ensureVersionJar(): Promise<string | null> {
  const source = join(paths.minecraft, 'versions', MC_VERSION, `${MC_VERSION}.jar`)
  const target = join(paths.minecraft, 'versions', NEO_ID, `${NEO_ID}.jar`)
  const size = await fileSize(source)
  if (size === null) return null
  if ((await fileSize(target)) === size) return target
  try {
    await copyFile(source, target)
    return target
  } catch (error) {
    log('Не удалось скопировать jar Minecraft для version.json', error)
    return null
  }
}

const JAVA_MAJOR = 21
/** Примерный размер архива Java: настоящий сервер сообщает не всегда, а полосе загрузки нужна длина. */
const JAVA_SIZE_HINT = 55 * 1024 ** 2
const JAVA_SPACE = 400 * 1024 ** 2

const javaHome = (component: string) => join(paths.runtime, `${component}-${process.platform}-${process.arch}`)

function javaBinary(component: string): string {
  if (IS_WINDOWS) return join(paths.runtime, component, 'bin', 'javaw.exe')
  return join(javaHome(component), ...(IS_MAC ? ['Contents', 'Home'] : []), 'bin', 'java')
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} завершился с кодом ${code}`))))
  })
}

/** На Windows Java приходит с нашего VPS вместе с клиентом. На macOS и Linux берём сборку Temurin под систему игрока. */
async function ensureJava(component: string, onProgress?: (progress: SyncProgress) => void): Promise<string> {
  const java = javaBinary(component)
  if (IS_WINDOWS || (await fileSize(java)) !== null) return java
  const home = javaHome(component)
  const archive = join(paths.tmp, `java-${process.platform}-${process.arch}.tar.gz`)
  const os = IS_MAC ? 'mac' : 'linux'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  const url = `https://api.adoptium.net/v3/binary/latest/${JAVA_MAJOR}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`
  let done = 0
  try {
    await ensureFreeSpace(paths.tmp, JAVA_SPACE)
    await downloadFile(url, archive, {
      onBytes: (delta) => {
        done += delta
        onProgress?.({ phase: 'downloading', done: Math.max(0, done), total: Math.max(done, JAVA_SIZE_HINT) })
      },
    })
    onProgress?.({ phase: 'installing' })
    await rm(home, { recursive: true, force: true })
    await mkdir(home, { recursive: true })
    await run('tar', ['-xzf', archive, '-C', home, '--strip-components=1'])
    await chmod(java, 0o755)
  } catch (cause) {
    if (cause instanceof Cancelled || cause instanceof UserError) throw cause
    await rm(home, { recursive: true, force: true }).catch(() => {})
    throw new UserError('Не удалось установить Java', `Java ${JAVA_MAJOR} не скачалась или не распаковалась. ${NETWORK_HINT}`, { cause })
  } finally {
    await rm(archive, { force: true }).catch(() => {})
  }
  return java
}

/** Библиотеки с нативным кодом (LWJGL и другие) на VPS лежат только для Windows. Для остальных систем качаем их у Mojang. */
async function ensurePlatformLibraries(vanilla: VersionJson, neoforge: VersionJson, onProgress?: (progress: SyncProgress) => void): Promise<void> {
  if (IS_WINDOWS) return
  const libraryDir = join(paths.minecraft, 'libraries')
  const missing: { target: string; artifact: Artifact & { url: string } }[] = []
  for (const library of mergeLibraries(neoforge, vanilla)) {
    const target = join(libraryDir, libraryPath(library))
    if ((await fileSize(target)) !== null) continue
    const artifact = library.downloads?.artifact
    if (!artifact?.url) throw new UserError('Игра установлена не полностью', `Не найдена библиотека ${library.name}. Нажмите «Играть» ещё раз.`)
    missing.push({ target, artifact: { ...artifact, url: artifact.url } })
  }
  if (!missing.length) return
  const total = missing.reduce((sum, item) => sum + (item.artifact.size ?? 0), 0)
  let done = 0
  try {
    await runPool(missing, THREADS, (item) =>
      downloadFile(item.artifact.url, item.target, {
        sha1: item.artifact.sha1,
        size: item.artifact.size,
        onBytes: (delta) => {
          done += delta
          onProgress?.({ phase: 'downloading', done, total })
        },
      }),
    )
  } catch (cause) {
    if (cause instanceof Cancelled || cause instanceof UserError) throw cause
    throw new UserError('Не удалось скачать файлы', `Библиотеки игры для этой системы не скачались. ${NETWORK_HINT}`, { cause })
  }
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
      // Java в манифесте собрана под Windows, на других системах она не нужна.
      filter: IS_WINDOWS ? undefined : (entry) => !entry.path.startsWith('runtime/'),
      rehash: options.rehash,
      threads: THREADS,
      onProgress: options.onProgress,
    })
  }
  const vanilla = await readJsonFile<VersionJson>(versionFile(MC_VERSION))
  const neoforge = await readJsonFile<VersionJson>(versionFile(NEO_ID))
  const component = vanilla?.javaVersion?.component ?? 'java-runtime-delta'
  const incomplete = () => new UserError('Игра установлена не полностью', 'Подключитесь к интернету и нажмите «Играть» ещё раз.')
  if (!vanilla || !neoforge) throw incomplete()
  if (!options.skipUpdate) await ensurePlatformLibraries(vanilla, neoforge, options.onProgress)
  const javaw = options.skipUpdate ? javaBinary(component) : await ensureJava(component, options.onProgress)
  if ((await fileSize(javaw)) === null) throw incomplete()
  return { vanilla, neoforge, javaw, versionJar: await ensureVersionJar() }
}
