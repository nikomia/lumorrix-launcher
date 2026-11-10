/** Что сейчас делает лаунчер. Единственный источник правды для интерфейса. */
export type Status =
  | { state: 'idle' }
  | { state: 'working'; title: string; detail?: string; fraction: number | null; cancellable: boolean }
  | { state: 'done'; message: string }
  | { state: 'playing' }
  | { state: 'error'; title: string; message: string; canPlayOld: boolean }
  | { state: 'crashed'; report: CrashReport }

export type UpdateStatus =
  | { state: 'none' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  /** Лаунчер только что обновился до этой версии: один раз показываем об этом плашку. */
  | { state: 'updated'; version: string }

/** Ответ сайта на загрузку или сброс скина. */
export type SkinResult = { ok: true } | { ok: false; error: string }

/** Скин, который игра показывает нику без своего скина: лицензионный с тем же ником или стандартный Minecraft. */
export interface DefaultSkin {
  src: string
  name: string
}

/** Играть со старой версией лаунчера нельзя: нужно обновиться до version. */
export interface RequiredUpdate {
  version: string
  /** Лаунчер не умеет обновляться сам (macOS, Linux без AppImage): новую версию нужно скачать с сайта. */
  manual: boolean
}

export type Preset = 'quality' | 'performance' | 'custom'
export type JvmPreset = 'g1' | 'zgc' | 'lowend'

export interface GameOptions {
  jvmPreset: JvmPreset
  /** Сразу подключаться к серверу после запуска игры. */
  autoConnect: boolean
  /** Закрывать лаунчер после запуска игры. */
  closeOnLaunch: boolean
  /** Показывать статус игры в профиле Discord. */
  discordStatus: boolean
  /** Открывать консоль вместе с игрой. */
  consoleOnLaunch: boolean
}

export interface CrashCulprit {
  file: string
  name: string
  reason: string
  canDisable: boolean
}

/** Разбор падения игры: что случилось и что с этим сделать. */
export interface CrashReport {
  kind: string
  title: string
  description: string | null
  solution: string
  action: 'disable' | 'memory' | 'repair' | 'relaunch' | 'none'
  exception: string | null
  culprits: CrashCulprit[]
  crashReport: string | null
  logFile: string
}

export interface SettingsView extends GameOptions {
  nickname: string
  ramGb: number
  /** null: игрок ещё не выбирал набор, вкладка модов предложит его. */
  modPreset: Preset | null
  ramOptions: { gb: number; allowed: boolean }[]
  launcherVersion: string
  packVersion: string | null
}

export interface ModView {
  /** modId мода; пустой, если его не удалось прочитать. */
  id: string
  file: string
  name: string
  description: string
  /** Логотип мода как data URL; null, если его нет. */
  icon: string | null
  kind: 'client' | 'user'
  enabled: boolean
}

/** null: узнать не удалось, поэтому ничего не показываем. */
export type ServerStatus = { online: false } | { online: true; players: number; max: number } | null

export type LinkName = 'discord' | 'support' | 'wiki' | 'rules' | 'download'
export type FolderName = 'game' | 'mods' | 'logs'

export interface LauncherApi {
  /** Система игрока (process.platform): по ней окно подстраивает шапку. */
  platform: string
  /** Версия лаунчера. */
  version: string
  getStatus(): Promise<Status>
  getUpdate(): Promise<UpdateStatus>
  getServerStatus(): Promise<ServerStatus>
  getSettings(): Promise<SettingsView>
  saveSettings(change: { nickname?: string; ramGb?: number } & Partial<GameOptions>): Promise<SettingsView>
  play(options?: { skipUpdate?: boolean }): Promise<void>
  /** Только скачать и установить, без запуска игры. */
  install(): Promise<void>
  cancel(): Promise<void>
  repair(): Promise<void>
  dismiss(): Promise<void>
  listMods(): Promise<ModView[]>
  /** Какие ещё моды затронет переключение. */
  planMod(file: string, enabled: boolean): Promise<{ files: string[] }>
  setMods(files: string[], enabled: boolean): Promise<ModView[]>
  setPreset(preset: Preset): Promise<{ mods: ModView[]; settings: SettingsView }>
  openLink(name: LinkName): Promise<void>
  openFolder(name: FolderName): Promise<void>
  copyCrashReport(): Promise<void>
  openConsole(): Promise<void>
  /** Что уже есть в логе текущего запуска игры. */
  consoleTail(): Promise<string>
  onConsole(listener: (text: string) => void): void
  onConsoleClear(listener: () => void): void
  installUpdate(): Promise<void>
  onStatus(listener: (status: Status) => void): void
  onUpdate(listener: (status: UpdateStatus) => void): void
  onUpdateRequired(listener: (info: RequiredUpdate) => void): void
  /** Скин игрока с сайта (data URL) или null, если стоит стандартный. */
  getSkin(): Promise<string | null>
  /** Стандартный скин игрока; null, если игра ещё не установлена. */
  getDefaultSkin(): Promise<DefaultSkin | null>
  uploadSkin(png: Uint8Array): Promise<SkinResult>
  resetSkin(): Promise<SkinResult>
}
