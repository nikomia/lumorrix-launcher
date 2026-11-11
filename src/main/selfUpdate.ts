import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { RequiredUpdate, UpdateStatus } from '../shared/types'
import { log } from './log'
import { fetchText } from './net'
import { paths, settingsFile } from './paths'
import { IS_MAC, IS_WINDOWS } from './platform'

let status: UpdateStatus = { state: 'none' }
export const getUpdateStatus = () => status

/** Последняя версия лаунчера, которую игрок уже запускал. */
const seenVersionFile = join(paths.data, 'launcher-version.txt')

/**
 * Узнаёт, запущена ли эта версия впервые после обновления. Версии до 0.2.0 файл не писали,
 * поэтому если его нет, а настройки уже есть, лаунчер тоже только что обновился.
 */
async function justUpdatedTo(current: string): Promise<boolean> {
  const seen = (await readFile(seenVersionFile, 'utf8').catch(() => '')).trim()
  if (seen === current) return false
  await writeFile(seenVersionFile, `${current}\n`, 'utf8').catch(() => {})
  if (seen) return true
  return access(settingsFile).then(
    () => true,
    () => false,
  )
}

/**
 * Обновление лаунчера: проверка один раз при старте и загрузка в фоне. Применяется кнопкой или
 * при следующем выходе. Поэтому скачанное обновление к старту всегда уже не нужно. А вот installer.exe
 * рядом с ним удалять нельзя: сравнивая с ним, новая версия скачивается не целиком, а только изменившимися частями.
 */
export async function startSelfUpdate(current: string, notify: (status: UpdateStatus) => void): Promise<void> {
  const set = (next: UpdateStatus) => {
    status = next
    notify(next)
  }
  if (await justUpdatedTo(current)) set({ state: 'updated', version: current })

  // Сборка для macOS не подписана, а на Linux обновлять себя умеет только AppImage.
  if (IS_MAC || (!IS_WINDOWS && !process.env.APPIMAGE)) return
  const pending = join(process.env.LOCALAPPDATA ?? '', 'lumorrix-launcher-updater', 'pending')
  // После обновления установщик может ещё пару секунд держать свой файл, поэтому повторяем удаление.
  if (process.env.LOCALAPPDATA) await rm(pending, { recursive: true, force: true, maxRetries: 5, retryDelay: 2000 }).catch(() => {})

  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  let version = ''
  autoUpdater.on('update-available', (info) => {
    version = info.version
    set({ state: 'downloading', version, percent: 0 })
  })
  autoUpdater.on('download-progress', (progress) => set({ state: 'downloading', version, percent: Math.round(progress.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }))
  // Без связи с сайтом лаунчер работает как обычно, игроку об этом знать незачем.
  autoUpdater.on('error', (error) => log('Обновление лаунчера не удалось', error))
  await autoUpdater.checkForUpdates().catch((error) => log('Проверка обновлений лаунчера не удалась', error))
}

const LATEST_URL = 'https://lumorrix.ru/launcher/latest.yml'
const CHECK_TIMEOUT_MS = 6000

/** Сравнивает версии вида 1.2.3: больше нуля, если a новее b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/** Сам себя обновляет только установленный лаунчер для Windows и AppImage на Linux. */
const canSelfUpdate = () => IS_WINDOWS || (!IS_MAC && !!process.env.APPIMAGE)

/**
 * Перед запуском игры: если на сайте вышла новая версия лаунчера, играть со старой нельзя.
 * Без связи с сайтом не мешаем: тогда и сборку не проверить, а игрок может играть в уже установленную.
 */
export async function requiredUpdate(current: string): Promise<RequiredUpdate | null> {
  let latest: string | undefined
  try {
    const text = await Promise.race([
      fetchText(`${LATEST_URL}?t=${Date.now()}`, 1),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)),
    ])
    latest = /^version:\s*['"]?([\w.-]+)/m.exec(text)?.[1]
  } catch (error) {
    log('Не удалось проверить версию лаунчера перед игрой', error)
    return null
  }
  if (!latest || compareVersions(latest, current) <= 0) return null
  if (canSelfUpdate() && status.state === 'none') {
    // Проверка при запуске могла не пройти (не было сети): начинаем загрузку сейчас.
    await autoUpdater.checkForUpdates().catch((error) => log('Проверка обновлений лаунчера не удалась', error))
  }
  return { version: latest, manual: !canSelfUpdate() }
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(true, true)
}
