import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'
import { log } from './log'

let status: UpdateStatus = { state: 'none' }
export const getUpdateStatus = () => status

/**
 * Обновление лаунчера: проверка один раз при старте и загрузка в фоне. Применяется кнопкой или
 * при следующем выходе. Поэтому скачанное обновление к старту всегда уже не нужно. А вот installer.exe
 * рядом с ним удалять нельзя: сравнивая с ним, новая версия скачивается не целиком, а только изменившимися частями.
 */
export async function startSelfUpdate(notify: (status: UpdateStatus) => void): Promise<void> {
  const pending = join(process.env.LOCALAPPDATA ?? '', 'lumorrix-launcher-updater', 'pending')
  // После обновления установщик может ещё пару секунд держать свой файл, поэтому повторяем удаление.
  if (process.env.LOCALAPPDATA) await rm(pending, { recursive: true, force: true, maxRetries: 5, retryDelay: 2000 }).catch(() => {})

  const set = (next: UpdateStatus) => {
    status = next
    notify(next)
  }
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

export function installUpdate(): void {
  autoUpdater.quitAndInstall(true, true)
}
