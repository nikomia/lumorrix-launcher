import { contextBridge, ipcRenderer } from 'electron'
import type { LauncherApi, Status, UpdateStatus } from '../shared/types'

const api: LauncherApi = {
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
  onStatus: (listener) => void ipcRenderer.on('status', (_event, status: Status) => listener(status)),
  onUpdate: (listener) => void ipcRenderer.on('update', (_event, status: UpdateStatus) => listener(status)),
}

contextBridge.exposeInMainWorld('lumorrix', api)
