import { describe, expect, it } from 'vitest'
import { buildArguments, gameOptionArgs, libraryPath, mergeLibraries, offlineUuid, rulesAllow, type VersionJson } from '../src/main/game/version'
import { MOJANG_OS } from '../src/main/platform'

const vanilla: VersionJson = {
  id: '1.21.1',
  mainClass: 'net.minecraft.client.main.Main',
  assetIndex: { id: '17', url: '', sha1: '', size: 0 },
  arguments: {
    jvm: [
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' },
      { rules: [{ action: 'allow', os: { name: 'windows' } }], value: ['-Dwin=1'] },
      '-Djava.library.path=${natives_directory}',
      '-cp',
      '${classpath}',
    ],
    game: [
      '--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--gameDir', '${game_directory}',
      { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
    ],
  },
  libraries: [
    { name: 'org.lwjgl:lwjgl:3.3.3' },
    { name: 'org.ow2.asm:asm:9.0' },
    { name: 'org.lwjgl:lwjgl:3.3.3:natives-windows', rules: [{ action: 'allow', os: { name: 'windows' } }] },
    { name: 'org.lwjgl:lwjgl:3.3.3:natives-linux', rules: [{ action: 'allow', os: { name: 'linux' } }] },
  ],
}

const neoforge: VersionJson = {
  id: 'neoforge-21.1.265',
  inheritsFrom: '1.21.1',
  mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
  arguments: {
    jvm: ['-DlibraryDirectory=${library_directory}', '-p', '${library_directory}/a.jar${classpath_separator}${library_directory}/b.jar'],
    game: ['--launchTarget', 'forgeclient'],
  },
  libraries: [{ name: 'org.ow2.asm:asm:9.10' }],
}

const args = () =>
  buildArguments({
    vanilla,
    neoforge,
    nickname: 'Steve_1',
    ramGb: 6,
    minecraftDir: 'C:\\L\\minecraft',
    gameDir: 'C:\\L\\game',
    tmpDir: 'C:\\L\\tmp\\game',
    launcherVersion: '1',
  })

describe('настройки запуска', () => {
  it('по умолчанию ничего не добавляет', () => {
    expect(gameOptionArgs({ autoConnect: false })).toEqual([])
  })

  it('сразу подключается к серверу', () => {
    expect(gameOptionArgs({ autoConnect: true })).toEqual(['--quickPlayMultiplayer', 'lumorrix.ru'])
  })

  it('идёт после аргументов игры', () => {
    const list = buildArguments({
      vanilla,
      neoforge,
      nickname: 'Steve_1',
      ramGb: 6,
      minecraftDir: 'C:\\L\\minecraft',
      gameDir: 'C:\\L\\game',
      tmpDir: 'C:\\L\\tmp\\game',
      launcherVersion: '1',
      extraGameArgs: gameOptionArgs({ autoConnect: true }),
    })
    expect(list.at(-1)).toBe('lumorrix.ru')
    expect(list.at(-3)).toBe('forgeclient')
  })
})

describe('запуск игры', () => {
  it('считает UUID игрока как Minecraft в offline-режиме', () => {
    expect(offlineUuid('Notch')).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f')
  })

  it('передаёт флаг лаунчера, память и настоящего игрока', () => {
    const list = args()
    expect(list).toContain('-Dlumorrix.launcher.managed=true')
    expect(list).toContain('-Xmx6G')
    expect(list[list.indexOf('--username') + 1]).toBe('Steve_1')
    expect(list[list.indexOf('--gameDir') + 1]).toBe('C:\\L\\game')
    expect(list.join(' ')).not.toContain('${')
  })

  it('главный класс из NeoForge стоит перед игровыми аргументами', () => {
    const list = args()
    const main = list.indexOf(neoforge.mainClass)
    expect(main).toBeGreaterThan(list.indexOf('-Xmx6G'))
    expect(main).toBeLessThan(list.indexOf('--username'))
    expect(list.at(-1)).toBe('forgeclient')
  })

  it('не включает аргументы и библиотеки других систем и демо-режим', () => {
    const list = args()
    expect(list).not.toContain('--demo')
    expect(list.includes('-Dwin=1')).toBe(MOJANG_OS === 'windows')
    expect(list.includes('-XstartOnFirstThread')).toBe(MOJANG_OS === 'osx')
    const classpath = list[list.indexOf('-cp') + 1]
    expect(classpath.includes('natives-windows')).toBe(MOJANG_OS === 'windows')
    expect(classpath.includes('natives-linux')).toBe(MOJANG_OS === 'linux')
  })

  it('библиотека NeoForge заменяет ванильную той же группы и имени, jar игры в classpath нет', () => {
    const libs = mergeLibraries(neoforge, vanilla).map((library) => library.name)
    expect(libs).toContain('org.ow2.asm:asm:9.10')
    expect(libs).not.toContain('org.ow2.asm:asm:9.0')
    const classpath = args()[args().indexOf('-cp') + 1]
    expect(classpath).not.toContain('1.21.1.jar')
  })

  it('строит путь библиотеки из координат', () => {
    expect(libraryPath({ name: 'org.lwjgl:lwjgl:3.3.3:natives-windows' })).toBe('org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar')
  })

  it('разбирает правила', () => {
    expect(rulesAllow(undefined)).toBe(true)
    expect(rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }], 'x64', 'windows')).toBe(false)
    expect(rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }], 'x64', 'linux')).toBe(true)
    expect(rulesAllow([{ action: 'allow', os: { name: 'windows', arch: 'x86' } }], 'x64', 'windows')).toBe(false)
    expect(rulesAllow([{ action: 'allow', os: { name: 'osx' } }], 'arm64', 'osx')).toBe(true)
  })
})
