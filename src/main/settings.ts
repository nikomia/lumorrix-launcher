import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { dirname } from 'node:path'
import type { GameOptions, JvmPreset, Preset } from '../shared/types'
import { applyDefaultOff, DEFAULT_OFF } from './pack/modlist'
import { modPrefs, settingsFile } from './paths'

export interface Settings extends GameOptions {
  nickname: string
  ramGb: number
  modPreset: Preset | null
}

const PRESETS: Preset[] = ['quality', 'performance', 'custom']
export const isPreset = (value: unknown): value is Preset => PRESETS.includes(value as Preset)

const JVM_PRESET_IDS: JvmPreset[] = ['g1', 'zgc', 'lowend']
export const isJvmPreset = (value: unknown): value is JvmPreset => JVM_PRESET_IDS.includes(value as JvmPreset)

export const NICKNAME = /^[A-Za-z0-9_]{3,16}$/
export const RAM_OPTIONS = [4, 6, 8, 10, 12, 16]

const totalRamGb = () => Math.round(totalmem() / 1024 ** 3)

/** Для 200+ модов нужно около 6 ГБ. Логика совпадает с Installer.defaultRam. */
export function defaultRam(total = totalRamGb()): number {
  return total >= 24 ? 8 : total >= 12 ? 6 : 4
}

/** Пока игрок не выбрал сам: при 8 ГБ ОЗУ и меньше настройки для слабого ПК, иначе G1. */
export function defaultJvmPreset(total = totalRamGb()): JvmPreset {
  return total <= 8 ? 'lowend' : 'g1'
}

/** Всё ОЗУ минус 2 ГБ системе; минимум сборки 4 ГБ доступен всегда. */
export function ramAllowed(gb: number, total = totalRamGb()): boolean {
  return gb === 4 || gb <= total - 2
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

export async function loadSettings(): Promise<Settings> {
  let saved: Partial<Settings> = {}
  try {
    saved = JSON.parse(await readFile(settingsFile, 'utf8'))
  } catch {
    saved = {}
  }
  const ramGb = RAM_OPTIONS.includes(saved.ramGb ?? 0) && ramAllowed(saved.ramGb ?? 0) ? (saved.ramGb as number) : defaultRam()
  const nickname = typeof saved.nickname === 'string' && NICKNAME.test(saved.nickname) ? saved.nickname : ''
  return {
    nickname,
    ramGb,
    modPreset: isPreset(saved.modPreset) ? saved.modPreset : null,
    jvmPreset: isJvmPreset(saved.jvmPreset) ? saved.jvmPreset : defaultJvmPreset(),
    autoConnect: saved.autoConnect === true,
    closeOnLaunch: saved.closeOnLaunch === true,
    discordStatus: saved.discordStatus !== false,
    consoleOnLaunch: saved.consoleOnLaunch === true,
  }
}

export const saveSettings = (settings: Settings) => writeJson(settingsFile, settings)

/** Выключенные клиентские моды (по modId). */
export async function loadDisabled(): Promise<Set<string>> {
  let saved: { disabled?: unknown; defaultsApplied?: unknown } = {}
  try {
    saved = JSON.parse(await readFile(modPrefs, 'utf8'))
  } catch {
    saved = {}
  }
  const disabled = new Set<string>(Array.isArray(saved.disabled) ? saved.disabled.map(String) : [])
  applyDefaultOff(disabled, Array.isArray(saved.defaultsApplied) ? saved.defaultsApplied.map(String) : [])
  return disabled
}

export const saveDisabled = (disabled: Set<string>) => writeJson(modPrefs, { disabled: [...disabled].sort(), defaultsApplied: DEFAULT_OFF })
