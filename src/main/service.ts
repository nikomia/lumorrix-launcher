import { type ChildProcess, spawn } from 'node:child_process'
import { closeSync, createWriteStream, openSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Status } from '../shared/types'
import { Cancelled, UserError } from './errors'
import { analyzeCrash } from './game/crashAnalyzer'
import { ensureGame, type InstalledGame } from './game/install'
import { buildArguments, gameOptionArgs } from './game/version'
import { log } from './log'
import { cancelActive, finishCancelable, formatSize, startCancelable, throwIfCancelled } from './net'
import { isHidden, listMods, settleLibraries } from './pack/modlist'
import { syncPack, type SyncProgress } from './pack/sync'
import { manifestCache, MANIFEST_URL, modMetaCache, packTmp, paths } from './paths'
import { loadDisabled, loadSettings, saveDisabled } from './settings'

export interface ServiceEvents {
  status(status: Status): void
  gameStarted(): void
  gameExited(): void
  quit(): void
  consoleData(text: string): void
  consoleClear(): void
}

let events: ServiceEvents
let status: Status = { state: 'idle' }
let game: ChildProcess | null = null
let launcherVersion = ''
let crashLog: string | null = null

export function initService(handlers: ServiceEvents, version: string): void {
  events = handlers
  launcherVersion = version
}

export const getStatus = () => status
export const isBusy = () => status.state === 'working' || status.state === 'playing'
export const isGameRunning = () => game !== null

function setStatus(next: Status): void {
  status = next
  events.status(next)
}

function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many
}

export function formatRemaining(seconds: number): string {
  if (seconds < 60) return 'осталось меньше минуты'
  const minutes = Math.round(seconds / 60)
  return `осталось около ${minutes} ${plural(minutes, 'минуты', 'минут', 'минут')}`
}

/** Прогресс скачивания понятным языком, не чаще 10 раз в секунду. */
function byteReporter(title: string) {
  const started = Date.now()
  let startedAt: number | null = null
  let last = 0
  return (done: number, total: number) => {
    const now = Date.now()
    if (now - last < 100 && done < total) return
    last = now
    if (startedAt === null) startedAt = done
    const speed = (done - startedAt) / Math.max((now - started) / 1000, 0.001)
    const remaining = speed > 0 && now - started > 3000 ? `, ${formatRemaining((total - done) / speed)}` : ''
    setStatus({
      state: 'working',
      title,
      detail: `${formatSize(Math.max(done, 0))} из ${formatSize(total)}${remaining}`,
      fraction: total ? Math.min(done / total, 1) : null,
      cancellable: true,
    })
  }
}

async function prepareGame(verify: boolean, skipUpdate = false): Promise<InstalledGame> {
  const checking = verify ? 'Проверяем игровые файлы' : 'Готовим игру'
  setStatus({ state: 'working', title: checking, fraction: null, cancellable: true })
  const report = byteReporter('Скачиваем Minecraft')
  let lastCheck = 0
  return ensureGame({
    rehash: verify,
    skipUpdate,
    onProgress: (progress: SyncProgress) => {
      if (progress.phase === 'downloading') {
        report(progress.done, progress.total)
      } else if (progress.phase === 'installing') {
        setStatus({ state: 'working', title: 'Устанавливаем Minecraft', fraction: null, cancellable: false })
      } else if (Date.now() - lastCheck > 100 || progress.done === progress.total) {
        lastCheck = Date.now()
        setStatus({ state: 'working', title: checking, fraction: progress.done / progress.total, cancellable: true })
      }
    },
  })
}

async function preparePack(rehash: boolean): Promise<void> {
  const disabled = await loadDisabled()
  const report = byteReporter('Скачиваем сборку')
  let lastCheck = 0
  try {
    const result = await syncPack({
      gameDir: paths.game,
      tmpDir: packTmp,
      manifestUrl: MANIFEST_URL,
      manifestCache,
      disabled,
      rehash,
      onProgress: (progress: SyncProgress) => {
        if (progress.phase === 'downloading') {
          report(progress.done, progress.total)
        } else if (progress.phase === 'installing') {
          setStatus({ state: 'working', title: 'Устанавливаем сборку', fraction: null, cancellable: false })
        } else if (Date.now() - lastCheck > 100 || progress.done === progress.total) {
          lastCheck = Date.now()
          setStatus({ state: 'working', title: 'Проверяем обновления', fraction: progress.done / progress.total, cancellable: true })
        }
      },
    })
    log(`Сборка ${result.version}: скачано ${result.downloaded}, удалено ${result.removed}`)
  } finally {
    await saveDisabled(disabled)
  }
}

/** Обновление или свой мод игрока могли изменить, какие библиотеки нужны. Ошибка здесь не должна мешать запуску. */
async function prepareLibraries(): Promise<void> {
  try {
    const disabled = await loadDisabled()
    const mods = await listMods(paths.game, MANIFEST_URL, manifestCache, modMetaCache)
    await settleLibraries(paths.game, MANIFEST_URL, manifestCache, disabled, mods)
    await saveDisabled(disabled)
  } catch (error) {
    log('Не удалось настроить библиотеки', error)
  }
}

function showError(error: unknown): void {
  if (error instanceof Cancelled) {
    setStatus({ state: 'idle' })
    return
  }
  log('Ошибка', error instanceof UserError ? (error.options.cause ?? error) : error)
  if (error instanceof UserError) {
    setStatus({ state: 'error', title: error.title, message: error.message, canPlayOld: !!error.options.canPlayOld })
    return
  }
  const code = (error as NodeJS.ErrnoException)?.code
  setStatus({
    state: 'error',
    title: 'Что-то пошло не так',
    message:
      code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
        ? 'Файл занят другой программой, возможно антивирусом. Попробуйте ещё раз.'
        : 'Попробуйте ещё раз. Если не поможет, напишите в поддержку в Discord.',
    canPlayOld: false,
  })
}

async function launch(installed: InstalledGame): Promise<void> {
  const { nickname, ramGb, jvmPreset, autoConnect, closeOnLaunch, discordStatus } = await loadSettings()
  const tmpDir = join(paths.tmp, 'game')
  await Promise.all([mkdir(tmpDir, { recursive: true }), mkdir(paths.game, { recursive: true }), mkdir(paths.logs, { recursive: true })])
  const args = buildArguments({
    vanilla: installed.vanilla,
    neoforge: installed.neoforge,
    nickname,
    ramGb,
    minecraftDir: paths.minecraft,
    gameDir: paths.game,
    tmpDir,
    launcherVersion,
    jvmPreset,
    extraJvmArgs: discordStatus ? [] : ['-Dlumorrix.discord=false'],
    extraGameArgs: gameOptionArgs({ autoConnect }),
    versionJar: installed.versionJar,
  })
  const logPath = join(paths.logs, 'game.log')
  const started = Date.now()
  events.consoleClear()
  if (closeOnLaunch) {
    // Игра живёт дальше сама: лог идёт прямо в файл, следить за её выходом и падением некому.
    const output = openSync(logPath, 'w')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(installed.javaw, args, { cwd: paths.game, stdio: ['ignore', output, output], windowsHide: true, detached: true })
      child.once('error', (cause) => {
        closeSync(output)
        reject(launchError(cause))
      })
      child.once('spawn', () => {
        child.unref()
        closeSync(output)
        resolve()
        events.quit()
      })
    })
    return
  }
  // Лог идёт через лаунчер: так его видит консоль, а в файл он пишется тут же.
  const file = createWriteStream(logPath)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(installed.javaw, args, { cwd: paths.game, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const forward = (chunk: string) => {
      file.write(chunk)
      events.consoleData(chunk)
    }
    child.stdout.setEncoding('utf8').on('data', forward)
    child.stderr.setEncoding('utf8').on('data', forward)
    child.once('error', (cause) => {
      file.end()
      reject(launchError(cause))
    })
    child.once('spawn', () => {
      game = child
      setStatus({ state: 'playing' })
      events.gameStarted()
      resolve()
    })
    child.once('close', (code) => {
      file.end()
      if (game !== child) return
      game = null
      void onGameExit(code, started)
    })
  })
}

const launchError = (cause: unknown) =>
  new UserError('Не удалось запустить игру', 'Java не запустилась. Возможно, её заблокировал антивирус. Попробуйте «Проверить игровые файлы» в настройках.', { cause })

async function onGameExit(code: number | null, started: number): Promise<void> {
  log(`Игра завершилась с кодом ${code}`)
  await rm(join(paths.tmp, 'game'), { recursive: true, force: true }).catch(() => {})
  if (code === 0) {
    setStatus({ state: 'idle' })
    events.gameExited()
  } else {
    // Окно открываем сразу: разбор смотрит все моды и может занять несколько секунд.
    setStatus({ state: 'working', title: 'Разбираем причину вылета', fraction: null, cancellable: false })
    events.gameExited()
    const mods = await listMods(paths.game, MANIFEST_URL, manifestCache, modMetaCache).catch(() => [])
    const canOff = new Set(mods.filter((mod) => !isHidden(mod)).map((mod) => mod.file))
    const report = await analyzeCrash({ gameDir: paths.game, since: started, canDisable: (file) => canOff.has(file) })
    crashLog = report.logFile
    log(`Разбор падения: ${report.kind}, ${report.exception ?? 'без исключения'}`)
    setStatus({ state: 'crashed', report })
  }
}

/** Запускает установку, которую игрок может отменить. Скачанное при этом сохраняется для следующего раза. */
async function runInstall(work: () => Promise<void>): Promise<void> {
  if (isBusy()) return
  startCancelable()
  try {
    await work()
  } catch (error) {
    showError(error)
  } finally {
    finishCancelable()
  }
}

export const cancel = () => cancelActive()

export function play(skipUpdate = false): Promise<void> {
  return runInstall(async () => {
    const { nickname } = await loadSettings()
    if (!nickname) throw new UserError('Нужен ник', 'Введите ник в настройках.')
    const installed = await prepareGame(false, skipUpdate)
    if (!skipUpdate) await preparePack(false)
    await prepareLibraries()
    throwIfCancelled()
    setStatus({ state: 'working', title: 'Запускаем игру', fraction: null, cancellable: false })
    await launch(installed)
  })
}

export function install(): Promise<void> {
  return runInstall(async () => {
    await prepareGame(false)
    await preparePack(false)
    await prepareLibraries()
    setStatus({ state: 'idle' })
  })
}

export function repair(): Promise<void> {
  return runInstall(async () => {
    await prepareGame(true)
    await preparePack(true)
    await prepareLibraries()
    setStatus({ state: 'done', message: 'Игровые файлы в порядке' })
  })
}

export function dismiss(): void {
  if (!isBusy()) setStatus({ state: 'idle' })
}

/** Текст для вставки в Discord: без пути к профилю Windows и не длиннее сообщения Discord. */
export async function crashReportText(): Promise<string> {
  const text = crashLog ? await readFile(crashLog, 'utf8').catch(() => '') : ''
  const tail = text.split(/\r?\n/).slice(-30).join('\n').replaceAll(homedir(), '~').slice(-1500)
  const report = status.state === 'crashed' ? status.report : null
  const summary = report ? `${report.title}${report.exception ? `\n${report.exception}` : ''}\n` : ''
  return `Lumorrix: игра упала (лаунчер ${launcherVersion})\n${summary}\`\`\`\n${tail}\n\`\`\``
}
