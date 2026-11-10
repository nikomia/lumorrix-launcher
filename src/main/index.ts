import { mkdirSync } from 'node:fs'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, screen, shell } from 'electron'
import type { FolderName, LinkName, ModView, ServerStatus, SettingsView, Status, UpdateStatus } from '../shared/types'
import { log } from './log'
import { IS_MAC } from './platform'
import { fetchText, fileSize } from './net'
import { dependentsOf, isHidden, listMods, type ModInfo, modIconPath, presetWants, refreshManifest, requirementsOf, setModsEnabled, settleLibraries } from './pack/modlist'
import { installedVersion } from './pack/sync'
import { manifestCache, MANIFEST_URL, modMetaCache, packTmp, paths } from './paths'
import { getUpdateStatus, installUpdate, requiredUpdate, startSelfUpdate } from './selfUpdate'
import { currentSkin, defaultSkin, licensedSkin, resetSkin, uploadSkin } from './skin'
import * as service from './service'
import { isJvmPreset, isPreset, loadDisabled, loadSettings, NICKNAME, RAM_OPTIONS, ramAllowed, saveDisabled, saveSettings } from './settings'

// Всё служебное держим в своей папке, а не в %APPDATA%\<имя>. Должно выполниться до старта приложения.
mkdirSync(paths.data, { recursive: true })
app.setPath('userData', join(paths.data, 'electron'))
app.setPath('sessionData', join(paths.data, 'electron'))
app.setPath('crashDumps', join(paths.data, 'electron', 'crashes'))
app.setAppLogsPath(paths.logs)
// Простому интерфейсу не нужна видеокарта, а без неё нет отдельного процесса GPU примерно на 100 МБ.
app.disableHardwareAcceleration()
// Лаунчеру эти кэши не нужны: страницы лежат локально.
app.commandLine.appendSwitch('disable-http-cache')
app.commandLine.appendSwitch('disk-cache-size', '1')
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

const LINKS: Record<LinkName, string> = {
  discord: 'https://discord.gg/PayxnJQSaJ',
  support: 'https://discord.gg/Y6FeUCEvB2',
  wiki: 'https://lumorrix.ru/wiki/',
  rules: 'https://lumorrix.ru/rules/',
  download: 'https://lumorrix.ru/how-to-play/',
}

/** Тот же источник онлайна, что и на сайте. */
const SERVER_STATUS_URL = 'https://api.mcsrvstat.us/3/lumorrix.ru'

async function serverStatus(): Promise<ServerStatus> {
  try {
    const data = JSON.parse(await fetchText(SERVER_STATUS_URL, 1))
    if (data.online !== true) return { online: false }
    return { online: true, players: Number(data.players?.online ?? 0), max: Number(data.players?.max ?? 0) }
  } catch {
    return null
  }
}

let window: BrowserWindow | null = null
let consoleWindow: BrowserWindow | null = null

function send(channel: string, value: Status | UpdateStatus): void {
  window?.webContents.send(channel, value)
}

const WEB_PREFERENCES = {
  preload: join(__dirname, '../preload/index.js'),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  spellcheck: false,
}

/** Консоль с живым логом игры. Живёт отдельно от главного окна, которое на время игры закрывается. */
function openConsole(): void {
  if (consoleWindow) {
    if (consoleWindow.isMinimized()) consoleWindow.restore()
    consoleWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 640,
    minHeight: 360,
    show: false,
    title: 'Lumorrix: консоль',
    backgroundColor: '#141415',
    autoHideMenuBar: true,
    webPreferences: WEB_PREFERENCES,
  })
  consoleWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    consoleWindow = null
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/console.html`)
  else void win.loadFile(join(__dirname, '../renderer/console.html'))
}

const CONSOLE_TAIL_BYTES = 1024 * 1024

async function consoleTail(): Promise<string> {
  try {
    const file = await open(join(paths.logs, 'game.log'), 'r')
    try {
      const { size } = await file.stat()
      const length = Math.min(size, CONSOLE_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, size - length)
      const text = buffer.toString('utf8')
      // Начало куска могло попасть в середину строки.
      return size > length ? text.slice(text.indexOf('\n') + 1) : text
    } finally {
      await file.close()
    }
  } catch {
    return ''
  }
}

function createWindow(): void {
  if (window) {
    if (window.isMinimized()) window.restore()
    window.focus()
    return
  }
  // На маленьких экранах и при большом масштабе Windows окно не должно вылезать за рабочую область.
  const area = screen.getPrimaryDisplay().workAreaSize
  window = new BrowserWindow({
    width: Math.min(1120, area.width),
    height: Math.min(720, area.height),
    resizable: false,
    maximizable: false,
    show: false,
    title: 'Lumorrix',
    backgroundColor: '#141415',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon: join(process.resourcesPath, 'icon.png') } : {}),
    titleBarStyle: 'hidden',
    // На macOS кнопки окна системные и стоят слева, на Windows и Linux их рисует overlay справа.
    ...(IS_MAC ? { trafficLightPosition: { x: 12, y: 10 } } : { titleBarOverlay: { color: '#00000000', symbolColor: '#ededed', height: 32 } }),
    webPreferences: WEB_PREFERENCES,
  })
  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => {
    window = null
  })
  // Новые окна и переходы по ссылкам запрещены: внешние ссылки открываются только через LINKS.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

async function settingsView(): Promise<SettingsView> {
  const settings = await loadSettings()
  return {
    ...settings,
    ramOptions: RAM_OPTIONS.map((gb) => ({ gb, allowed: ramAllowed(gb) })),
    launcherVersion: app.getVersion(),
    packVersion: await installedVersion(paths.game),
  }
}

const installedMods = () => listMods(paths.game, MANIFEST_URL, manifestCache, modMetaCache)

/** Список модов, в том числе ещё не установленных. Во время установки файлы не качаем: они нужны ей самой. */
async function loadMods(): Promise<ModInfo[]> {
  if (service.isBusy()) return installedMods()
  const preview = { blobDir: packTmp, disabled: await loadDisabled() }
  if (await installedVersion(paths.game)) {
    // Сборка уже стоит: без интернета просто показываем то, что лежит на диске.
    return listMods(paths.game, MANIFEST_URL, manifestCache, modMetaCache, preview).catch(installedMods)
  }
  try {
    await refreshManifest(MANIFEST_URL, manifestCache)
  } catch (error) {
    if ((await fileSize(manifestCache)) === null) throw error
  }
  return listMods(paths.game, MANIFEST_URL, manifestCache, modMetaCache, preview)
}

// Запросы идут по очереди, чтобы список и установка не качали один и тот же файл одновременно.
let modsQueue: Promise<unknown> = Promise.resolve()

function allMods(): Promise<ModInfo[]> {
  const next = modsQueue.catch(() => {}).then(loadMods)
  modsQueue = next
  return next
}

const modsIdle = () => modsQueue.catch(() => {})

const ICON_SIZE = 64
const iconCache = new Map<string, string | null>()

/** Логотипы бывают и по 1024 пикселя, поэтому в интерфейс отдаём уменьшенную копию. */
async function modIcon(id: string): Promise<string | null> {
  if (!id) return null
  const cached = iconCache.get(id)
  if (cached) return cached
  let icon: string | null = null
  try {
    const image = nativeImage.createFromBuffer(await readFile(modIconPath(modMetaCache, id)))
    const { width, height } = image.getSize()
    if (width && height) {
      const scale = Math.min(ICON_SIZE / width, ICON_SIZE / height, 1)
      icon = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }).toDataURL()
      iconCache.set(id, icon)
    }
  } catch {
    icon = null
  }
  return icon
}

const toView = (mods: ModInfo[]): Promise<ModView[]> =>
  Promise.all(
    mods
      .filter((mod) => !isHidden(mod))
      .map(async ({ ids, file, name, description, kind, enabled }) => ({
        id: ids[0] ?? '',
        file,
        name,
        description,
        icon: await modIcon(ids[0] ?? ''),
        kind,
        enabled,
      })),
  )

function registerIpc(): void {
  ipcMain.handle('status:get', () => service.getStatus())
  ipcMain.handle('update:get', () => getUpdateStatus())
  ipcMain.handle('settings:get', settingsView)
  ipcMain.handle('settings:save', async (_event, change: Record<string, unknown>) => {
    const settings = await loadSettings()
    if (typeof change.nickname === 'string' && NICKNAME.test(change.nickname)) settings.nickname = change.nickname
    if (typeof change.ramGb === 'number' && RAM_OPTIONS.includes(change.ramGb) && ramAllowed(change.ramGb)) settings.ramGb = change.ramGb
    if (typeof change.autoConnect === 'boolean') settings.autoConnect = change.autoConnect
    if (typeof change.closeOnLaunch === 'boolean') settings.closeOnLaunch = change.closeOnLaunch
    if (typeof change.discordStatus === 'boolean') settings.discordStatus = change.discordStatus
    if (typeof change.consoleOnLaunch === 'boolean') settings.consoleOnLaunch = change.consoleOnLaunch
    if (isJvmPreset(change.jvmPreset)) settings.jvmPreset = change.jvmPreset
    await saveSettings(settings)
    return settingsView()
  })
  ipcMain.handle('server:status', serverStatus)
  /** Со старой версией лаунчера играть нельзя: вместо запуска игрок видит окно «Нужно обновить лаунчер». */
  const blockOutdated = async (): Promise<boolean> => {
    if (!app.isPackaged) return false
    const required = await requiredUpdate(app.getVersion())
    if (!required) return false
    window?.webContents.send('update:required', required)
    return true
  }
  ipcMain.handle('play', async (_event, options?: { skipUpdate?: unknown }) => {
    if (await blockOutdated()) return
    await modsIdle()
    await service.play(options?.skipUpdate === true)
  })
  ipcMain.handle('install', async () => {
    if (await blockOutdated()) return
    await modsIdle()
    await service.install()
  })
  ipcMain.handle('cancel', () => service.cancel())
  ipcMain.handle('repair', async () => {
    await modsIdle()
    await service.repair()
  })
  ipcMain.handle('dismiss', () => service.dismiss())
  ipcMain.handle('mods:list', async () => toView(await allMods()))
  ipcMain.handle('mods:plan', async (_event, file: unknown, enabled: unknown) => {
    const mods = await allMods()
    const target = mods.find((mod) => mod.file === file)
    if (!target) return { files: [] }
    const affected = enabled === true ? requirementsOf(mods, target) : dependentsOf(mods, target)
    // Про скрытые моды игрока не спрашиваем: они переключаются сами.
    return { files: affected.filter((mod) => !isHidden(mod)).map((mod) => mod.file) }
  })
  ipcMain.handle('mods:set', async (_event, files: unknown, enabled: unknown) => {
    if (!service.isBusy() && Array.isArray(files) && typeof enabled === 'boolean') {
      const names = files.map(String)
      const before = await allMods()
      const disabled = await loadDisabled()
      await setModsEnabled(paths.game, MANIFEST_URL, manifestCache, disabled, names, enabled)
      await saveDisabled(disabled)
      await settleLibraries(paths.game, MANIFEST_URL, manifestCache, disabled, await allMods())
      await saveDisabled(disabled)
      // Игрок поменял мод из сборки вручную: это уже его собственный набор.
      if (before.some((mod) => mod.kind === 'client' && names.includes(mod.file))) {
        await saveSettings({ ...(await loadSettings()), modPreset: 'custom' })
      }
    }
    return toView(await allMods())
  })
  ipcMain.handle('mods:preset', async (_event, preset: unknown) => {
    if (isPreset(preset) && !service.isBusy()) {
      const mods = (await allMods()).filter((mod) => mod.kind === 'client' && !isHidden(mod))
      const disabled = await loadDisabled()
      const files = (wanted: boolean) => mods.filter((mod) => presetWants(preset, mod) === wanted).map((mod) => mod.file)
      await setModsEnabled(paths.game, MANIFEST_URL, manifestCache, disabled, files(true), true)
      await setModsEnabled(paths.game, MANIFEST_URL, manifestCache, disabled, files(false), false)
      await saveDisabled(disabled)
      await settleLibraries(paths.game, MANIFEST_URL, manifestCache, disabled, await allMods())
      await saveDisabled(disabled)
      await saveSettings({ ...(await loadSettings()), modPreset: preset })
    }
    return { mods: await toView(await allMods()), settings: await settingsView() }
  })
  ipcMain.handle('link:open', (_event, name: LinkName) => {
    if (Object.hasOwn(LINKS, name)) return shell.openExternal(LINKS[name])
  })
  ipcMain.handle('folder:open', async (_event, name: FolderName) => {
    const folders: Record<FolderName, string> = { game: paths.game, mods: join(paths.game, 'mods'), logs: join(paths.game, 'logs') }
    if (!Object.hasOwn(folders, name)) return
    await mkdir(folders[name], { recursive: true })
    await shell.openPath(folders[name])
  })
  ipcMain.handle('crash:copy', async () => clipboard.writeText(await service.crashReportText()))
  ipcMain.handle('console:open', () => openConsole())
  ipcMain.handle('console:tail', () => consoleTail())
  ipcMain.handle('skin:get', async () => currentSkin((await loadSettings()).nickname))
  // Без своего скина игра покажет лицензионный с таким же ником, а если его нет — стандартный.
  ipcMain.handle('skin:default', async () => {
    const { nickname } = await loadSettings()
    return (await licensedSkin(nickname)) ?? defaultSkin(nickname)
  })
  ipcMain.handle('skin:upload', async (_event, png: unknown) => {
    if (!(png instanceof Uint8Array)) return { ok: false, error: 'Не удалось прочитать файл скина.' }
    return uploadSkin((await loadSettings()).nickname, png)
  })
  ipcMain.handle('skin:reset', async () => resetSkin((await loadSettings()).nickname))
  ipcMain.on('app:version', (event) => {
    event.returnValue = app.getVersion()
  })
  ipcMain.handle('update:install', () => {
    if (!service.isBusy()) installUpdate()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  service.initService(
    {
      status: (status) => send('status', status),
      // Пока идёт игра, окно уничтожаем: это освобождает память процесса отрисовки.
      gameStarted: () => {
        window?.destroy()
        void loadSettings().then((settings) => {
          if (settings.consoleOnLaunch) openConsole()
        })
      },
      gameExited: () => createWindow(),
      quit: () => app.quit(),
      consoleData: (text) => consoleWindow?.webContents.send('console:data', text),
      consoleClear: () => consoleWindow?.webContents.send('console:clear'),
    },
    app.getVersion(),
  )
  app.on('second-instance', createWindow)
  app.on('activate', () => {
    if (!service.isGameRunning()) createWindow()
  })
  app.on('window-all-closed', () => {
    if (!service.isGameRunning()) app.quit()
  })
  void app.whenReady().then(() => {
    // Без меню на macOS не работают Cmd+Q и вставка ника из буфера.
    Menu.setApplicationMenu(IS_MAC ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null)
    registerIpc()
    createWindow()
    log(`Лаунчер ${app.getVersion()} запущен`)
    if (app.isPackaged) void startSelfUpdate(app.getVersion(), (status) => send('update', status))
  })
}
