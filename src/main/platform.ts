export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/** Имя системы в правилах Mojang (поле os.name в JSON версии). */
export type MojangOs = 'windows' | 'osx' | 'linux'
export const MOJANG_OS: MojangOs = IS_WINDOWS ? 'windows' : IS_MAC ? 'osx' : 'linux'
