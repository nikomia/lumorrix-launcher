import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IS_MAC, IS_WINDOWS } from './platform'

/**
 * Всё, что создаёт лаунчер, лежит в одной папке рядом с привычной .minecraft.
 * Путь разворачиваем в полный: с коротким именем вида USERNA~1 игра падает, потому что Mixin обрезает путь на «~».
 * На macOS и Linux папка лежит там, где система хранит данные программ.
 */
function defaultRoot(): string {
  const home = homedir()
  if (IS_WINDOWS) return join(process.env.APPDATA ?? home, '.lumorrix-launcher')
  if (IS_MAC) return join(home, 'Library', 'Application Support', 'lumorrix-launcher')
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'lumorrix-launcher')
}

function resolveRoot(): string {
  const wanted = process.env.LUMORRIX_ROOT ?? defaultRoot()
  mkdirSync(wanted, { recursive: true })
  return realpathSync.native(wanted)
}

const root = resolveRoot()

export const paths = {
  root,
  game: join(root, 'game'),
  minecraft: join(root, 'minecraft'),
  runtime: join(root, 'runtime'),
  data: join(root, 'data'),
  logs: join(root, 'logs'),
  tmp: join(root, 'tmp'),
}

export const MANIFEST_URL = 'https://lumorrix.ru/modpack/manifest.txt'
/** Minecraft, библиотеки, ассеты и Java с нашего VPS. */
export const CLIENT_MANIFEST_URL = 'https://lumorrix.ru/client/manifest.txt'
export const manifestCache = join(paths.data, 'manifest.txt')
export const modMetaCache = join(paths.data, 'mod-meta.json')
export const modPrefs = join(paths.data, 'mods.json')
export const settingsFile = join(paths.data, 'settings.json')
export const packTmp = join(paths.tmp, 'pack')
