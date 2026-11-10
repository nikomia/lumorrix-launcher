import { contextBridge, ipcRenderer } from 'electron'
import type { LauncherApi, RequiredUpdate, Status, UpdateStatus } from '../shared/types'

const api: LauncherApi = {
  platform: process.platform,
  version: ipcRenderer.sendSync('app:version') as string,
  getStatus: () => ipcRenderer.invoke('status:get'),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (change) => ipcRenderer.invoke('settings:save', change),
  play: (options) => ipcRenderer.invoke('play', options),
  install: () => ipcRenderer.invoke('install'),
  cancel: () => ipcRenderer.invoke('cancel'),
  repair: () => ipcRenderer.invoke('repair'),
  dismiss: () => ipcRenderer.invoke('dismiss'),
  listMods: () => ipcRenderer.invoke('mods:list'),
  planMod: (file, enabled) => ipcRenderer.invoke('mods:plan', file, enabled),
  setMods: (files, enabled) => ipcRenderer.invoke('mods:set', files, enabled),
  setPreset: (preset) => ipcRenderer.invoke('mods:preset', preset),
  openLink: (name) => ipcRenderer.invoke('link:open', name),
  openFolder: (name) => ipcRenderer.invoke('folder:open', name),
  copyCrashReport: () => ipcRenderer.invoke('crash:copy'),
  openConsole: () => ipcRenderer.invoke('console:open'),
  consoleTail: () => ipcRenderer.invoke('console:tail'),
  onConsole: (listener) => void ipcRenderer.on('console:data', (_event, text: string) => listener(text)),
  onConsoleClear: (listener) => void ipcRenderer.on('console:clear', () => listener()),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getSkin: () => ipcRenderer.invoke('skin:get'),
  getDefaultSkin: () => ipcRenderer.invoke('skin:default'),
  uploadSkin: (png) => ipcRenderer.invoke('skin:upload', png),
  resetSkin: () => ipcRenderer.invoke('skin:reset'),
  onStatus: (listener) => void ipcRenderer.on('status', (_event, status: Status) => listener(status)),
  onUpdate: (listener) => void ipcRenderer.on('update', (_event, status: UpdateStatus) => listener(status)),
  onUpdateRequired: (listener) => void ipcRenderer.on('update:required', (_event, info: RequiredUpdate) => listener(info)),
}

contextBridge.exposeInMainWorld('lumorrix', api)
