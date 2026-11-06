import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeCrash } from '../src/main/game/crashAnalyzer'
import { modsToml, zipOf } from './zip'

let game = ''

beforeEach(() => {
  game = mkdtempSync(join(tmpdir(), 'lumorrix-crash-'))
  mkdirSync(join(game, 'mods'))
  mkdirSync(join(game, 'crash-reports'))
  mkdirSync(join(game, 'logs'))
  writeFileSync(join(game, 'mods', 'sodium.jar'), zipOf({ 'META-INF/neoforge.mods.toml': modsToml('sodium', 'Sodium'), 'net/caffeinemc/Bad.class': 'x' }))
  writeFileSync(join(game, 'mods', 'create.jar'), zipOf({ 'META-INF/neoforge.mods.toml': modsToml('create', 'Create'), 'com/simibubi/Machine.class': 'x' }))
})

afterEach(() => {
  rmSync(game, { recursive: true, force: true })
})

const report = (text: string) => writeFileSync(join(game, 'crash-reports', 'crash-1.txt'), `---- Minecraft Crash Report ----\nDescription: Rendering\n\n${text}\n`)
const analyze = (canDisable: (file: string) => boolean = () => true, since = Date.now()) => analyzeCrash({ gameDir: game, since, canDisable })

describe('разбор падений', () => {
  it('называет мод, который не смог запуститься, а не последнюю ошибку', async () => {
    writeFileSync(join(game, 'logs', 'latest.log'), 'Failed to create mod instance. ModID: create, class x.Y\n')
    report('java.lang.NullPointerException: потом\n\tat TRANSFORMER/sodium@1/net.caffeinemc.Bad.render(Bad.java:5)')
    const result = await analyze()
    expect(result.title).toBe('Мод «Create» не смог запуститься')
    expect(result.culprits[0]?.file).toBe('create.jar')
  })

  it('находит мод по классу в стектрейсе и предлагает его выключить', async () => {
    report('java.lang.NullPointerException: boom\n\tat MC-BOOTSTRAP/net.minecraft.client.Main.run(Main.java:1)\n\tat TRANSFORMER/sodium@1/net.caffeinemc.Bad.render(Bad.java:5)')
    const result = await analyze()
    expect(result.title).toBe('Вылет из-за мода «Sodium»')
    expect(result.action).toBe('disable')
    expect(result.culprits[0]).toMatchObject({ file: 'sodium.jar', canDisable: true })
    expect(result.exception).toBe('java.lang.NullPointerException: boom')
  })

  it('находит мод по коду, встроенному через Mixin', async () => {
    report('java.lang.IllegalStateException: x\n\tat net.minecraft.client.Main.handler$abc000$sodium$tick(Main.java:1)')
    const result = await analyze()
    expect(result.culprits[0]?.name).toBe('Sodium')
  })

  it('находит мод по ошибке применения Mixin', async () => {
    writeFileSync(join(game, 'logs', 'latest.log'), 'MixinApplyError: Mixin [create.mixins.json:Foo] from mod create] FAILED\n')
    const result = await analyze()
    expect(result.culprits[0]?.name).toBe('Create')
  })

  it('обязательный мод сборки не предлагает выключить', async () => {
    report('java.lang.NullPointerException\n\tat com.simibubi.Machine.tick(Machine.java:1)')
    const result = await analyze((file) => file !== 'create.jar')
    expect(result.culprits[0]?.canDisable).toBe(false)
    expect(result.action).toBe('repair')
  })

  it('узнаёт нехватку памяти и отправляет в настройки', async () => {
    report('java.lang.OutOfMemoryError: Java heap space\n\tat java.base/java.util.Arrays.copyOf(Arrays.java:1)')
    const result = await analyze()
    expect(result.title).toBe('Игре не хватило памяти')
    expect(result.action).toBe('memory')
  })

  it('узнаёт проблему драйвера видеокарты', async () => {
    writeFileSync(join(game, 'logs', 'latest.log'), 'GLFW error 65542: WGL: The driver does not appear to support OpenGL\n')
    const result = await analyze()
    expect(result.action).toBe('none')
  })

  it('называет отсутствующую зависимость', async () => {
    writeFileSync(join(game, 'logs', 'latest.log'), "Mod ID: 'cloth_config', Requested by: 'sodium', Expected range: [1,)\n")
    const result = await analyze()
    expect(result.title).toBe('Модам не хватает других модов')
    expect(result.description).toContain('cloth_config')
    expect(result.culprits[0]?.name).toBe('Sodium')
  })

  it('не верит старому отчёту от прошлого запуска', async () => {
    report('java.lang.OutOfMemoryError: old')
    const result = await analyze(() => true, Date.now() + 60_000)
    expect(result.crashReport).toBeNull()
    expect(result.action).toBe('repair')
  })

  it('без понятной причины честно об этом говорит', async () => {
    report('java.lang.RuntimeException: strange\n\tat java.base/java.lang.Thread.run(Thread.java:1)')
    const result = await analyze()
    expect(result.title).toBe('Игра закрылась с ошибкой')
    expect(result.action).toBe('repair')
  })
})
