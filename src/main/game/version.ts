import { createHash } from 'node:crypto'
import { delimiter, join } from 'node:path'
import type { GameOptions, JvmPreset } from '../../shared/types'
import { MOJANG_OS, type MojangOs } from '../platform'

/** Формат JSON версий Mojang и NeoForge (только используемые поля). */
export interface Rule {
  action: 'allow' | 'disallow'
  os?: { name?: string; arch?: string }
  features?: Record<string, boolean>
}

export interface Artifact {
  path?: string
  sha1?: string
  size?: number
  url?: string
}

export interface Library {
  name: string
  rules?: Rule[]
  downloads?: { artifact?: Artifact }
}

export type Argument = string | { rules?: Rule[]; value: string | string[] }

export interface VersionJson {
  id: string
  inheritsFrom?: string
  mainClass: string
  assets?: string
  assetIndex?: { id: string; url: string; sha1: string; size: number; totalSize?: number }
  downloads?: { client?: { url: string; sha1: string; size: number } }
  javaVersion?: { component: string; majorVersion: number }
  arguments?: { game?: Argument[]; jvm?: Argument[] }
  libraries: Library[]
}

/** Наборы параметров Java. G1 совпадает с Install.GC_ARGS, остальные взяты из лаунчера Slarof. */
export const JVM_PRESETS: Record<JvmPreset, string[]> = {
  g1: [
    '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch', '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1',
  ],
  zgc: ['-XX:+UseZGC', '-XX:+AlwaysPreTouch'],
  lowend: ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=50', '-XX:-AlwaysPreTouch', '-XX:+UseStringDeduplication'],
}

/** Правила Mojang для системы игрока. Правила с features (демо, QuickPlay и т. п.) не применяем. */
export function rulesAllow(rules: Rule[] | undefined, arch = process.arch, os: MojangOs = MOJANG_OS): boolean {
  if (!rules?.length) return true
  let allowed = false
  for (const rule of rules) {
    if (rule.features) {
      if (rule.action === 'allow') continue
      allowed = true
      continue
    }
    const nameOk = !rule.os?.name || rule.os.name === os
    const archOk = !rule.os?.arch || (rule.os.arch === 'x86' ? arch === 'ia32' : rule.os.arch === arch)
    if (nameOk && archOk) allowed = rule.action === 'allow'
  }
  return allowed
}

export function libraryPath(library: Library): string {
  const given = library.downloads?.artifact?.path
  if (given) return given
  const [group, artifact, version, classifier] = library.name.split(':')
  const suffix = classifier ? `-${classifier}` : ''
  return `${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}${suffix}.jar`
}

/** Библиотеки дочерней версии важнее родительских при совпадении группы, имени и классификатора. */
export function mergeLibraries(child: VersionJson, parent: VersionJson): Library[] {
  const key = (library: Library) => {
    const [group, artifact, , classifier] = library.name.split(':')
    return `${group}:${artifact}:${classifier ?? ''}`
  }
  const seen = new Set<string>()
  const result: Library[] = []
  for (const library of [...child.libraries, ...parent.libraries]) {
    if (!rulesAllow(library.rules) || seen.has(key(library))) continue
    seen.add(key(library))
    result.push(library)
  }
  return result
}

/** UUID игрока без лицензии: так же его считает сервер с online-mode=false. */
export function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface LaunchParams {
  vanilla: VersionJson
  neoforge: VersionJson
  nickname: string
  ramGb: number
  minecraftDir: string
  gameDir: string
  tmpDir: string
  launcherVersion: string
  /** Набор параметров Java, по умолчанию G1. */
  jvmPreset?: JvmPreset
  /** Дополнительные аргументы Java и игры из настроек лаунчера. */
  extraJvmArgs?: string[]
  extraGameArgs?: string[]
  /** Копия jar Minecraft под именем версии NeoForge: ставится в конец classpath ради version.json. */
  versionJar?: string | null
}

export const SERVER_ADDRESS = 'lumorrix.ru'

/** Аргументы игры для настройки автоподключения. */
export function gameOptionArgs(options: Pick<GameOptions, 'autoConnect'>): string[] {
  return options.autoConnect ? ['--quickPlayMultiplayer', SERVER_ADDRESS] : []
}

function expand(args: Argument[] | undefined, vars: Record<string, string>): string[] {
  const out: string[] = []
  for (const arg of args ?? []) {
    let values: string[]
    if (typeof arg === 'string') {
      values = [arg]
    } else {
      if (!rulesAllow(arg.rules)) continue
      values = Array.isArray(arg.value) ? arg.value : [arg.value]
    }
    for (const value of values) {
      out.push(value.replace(/\$\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole))
    }
  }
  return out
}

/** Аргументы запуска игры (без самого java). */
export function buildArguments(params: LaunchParams): string[] {
  const { vanilla, neoforge, nickname, ramGb, minecraftDir, gameDir, tmpDir, launcherVersion } = params
  const libraryDir = join(minecraftDir, 'libraries')
  const nativesDir = join(minecraftDir, 'natives')
  // Ванильный jar под своим именем в classpath не кладём: ignoreList NeoForge исключает только jar с именем своей версии.
  // Поэтому его копия называется как версия NeoForge (versionJar): NeoForge её пропускает, а version.json из неё виден модам.
  const classpath = [
    ...mergeLibraries(neoforge, vanilla).map((library) => join(libraryDir, libraryPath(library))),
    ...(params.versionJar ? [params.versionJar] : []),
  ].join(delimiter)
  const vars: Record<string, string> = {
    auth_player_name: nickname,
    version_name: neoforge.id,
    game_directory: gameDir,
    assets_root: join(minecraftDir, 'assets'),
    assets_index_name: vanilla.assetIndex?.id ?? vanilla.assets ?? '',
    auth_uuid: offlineUuid(nickname).replaceAll('-', ''),
    auth_access_token: '0',
    clientid: '',
    auth_xuid: '',
    user_type: 'legacy',
    version_type: 'release',
    natives_directory: nativesDir,
    launcher_name: 'lumorrix',
    launcher_version: launcherVersion,
    classpath,
    library_directory: libraryDir.replaceAll('\\', '/'),
    classpath_separator: delimiter,
  }
  return [
    `-Xmx${ramGb}G`,
    '-Xms2G',
    ...JVM_PRESETS[params.jvmPreset ?? 'g1'],
    ...(params.extraJvmArgs ?? []),
    // Лаунчер сам ставит сборку: мод не должен её обновлять.
    '-Dlumorrix.launcher.managed=true',
    // Временные файлы игры держим в своей папке, а не в %TEMP%.
    `-Djava.io.tmpdir=${tmpDir}`,
    `-Dorg.lwjgl.system.SharedLibraryExtractPath=${nativesDir}`,
    `-Djna.tmpdir=${tmpDir}`,
    `-Dio.netty.native.workdir=${tmpDir}`,
    ...expand(vanilla.arguments?.jvm, vars),
    ...expand(neoforge.arguments?.jvm, vars),
    neoforge.mainClass,
    ...expand(vanilla.arguments?.game, vars),
    ...expand(neoforge.arguments?.game, vars),
    ...(params.extraGameArgs ?? []),
  ]
}
