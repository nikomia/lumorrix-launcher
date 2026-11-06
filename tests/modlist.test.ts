import { describe, expect, it } from 'vitest'
import { applyDefaultOff, DEFAULT_OFF, dependentsOf, isHidden, isLibrary, libraryChanges, type ModInfo, parseModsToml, presetWants, requirementsOf } from '../src/main/pack/modlist'

const mod = (id: string, requires: string[], enabled = true): ModInfo => ({
  ids: [id],
  name: id,
  description: '',
  logo: '',
  requires,
  file: `${id}.jar`,
  kind: 'client',
  enabled,
})

describe('описание мода', () => {
  it('читает название, описание и обязательные зависимости', () => {
    const meta = parseModsToml(`
modLoader = "javafml"
[[mods]]
modId = "reeses_sodium_options"
displayName = "Reese's Sodium Options"
description = '''
Better options
screen
'''
[[dependencies.reeses_sodium_options]]
modId = "sodium"
type = "required"
[[dependencies.reeses_sodium_options]]
modId = "neoforge"
type = "required"
[[dependencies.reeses_sodium_options]]
modId = "iris"
type = "optional"
[[dependencies.reeses_sodium_options]]
modId = "servermod"
type = "required"
side = "SERVER"
`)
    expect(meta?.name).toBe("Reese's Sodium Options")
    expect(meta?.description).toBe('Better options screen')
    expect(meta?.requires).toEqual(['sodium'])
  })

  it('находит логотип мода и убирает ведущий слэш', () => {
    expect(parseModsToml('[[mods]]\nmodId = "a"\nlogoFile = "/logo.png"')?.logo).toBe('logo.png')
    expect(parseModsToml('logoFile = "top.png"\n[[mods]]\nmodId = "a"')?.logo).toBe('top.png')
    expect(parseModsToml('[[mods]]\nmodId = "a"')?.logo).toBe('')
  })

  it('понимает старый формат mandatory', () => {
    const meta = parseModsToml(`
[[mods]]
modId = "a"
[[dependencies.a]]
modId = "b"
mandatory = true
`)
    expect(meta?.requires).toEqual(['b'])
  })

  it('не падает на битом файле', () => {
    expect(parseModsToml('[[[ это не toml')).toBeNull()
  })
})

describe('моды, выключенные по умолчанию', () => {
  it('у нового игрока выключены', () => {
    const disabled = new Set<string>()
    applyDefaultOff(disabled, [])
    expect([...disabled]).toEqual(['gpu_booster'])
  })

  it('не выключаются снова, если игрок включил их сам', () => {
    const disabled = new Set<string>()
    applyDefaultOff(disabled, DEFAULT_OFF)
    expect(disabled.size).toBe(0)
  })

  it('новый мод в списке применяется, не трогая прежние', () => {
    const disabled = new Set<string>()
    expect(applyDefaultOff(disabled, ['c2me']).sort()).toEqual(['c2me', 'gpu_booster'])
    expect([...disabled]).toEqual(['gpu_booster'])
  })
})

describe('наборы модов', () => {
  const wanted = (preset: 'quality' | 'performance' | 'custom', id: string) => presetWants(preset, mod(id, []))

  it('Качество включает всё, кроме модов, выключенных по умолчанию', () => {
    expect(wanted('quality', 'iris')).toBe(true)
    expect(wanted('quality', 'c2me')).toBe(true)
    expect(wanted('quality', 'неизвестный_мод')).toBe(true)
    expect(wanted('quality', 'gpu_booster')).toBe(false)
  })

  it('Производительность включает моды на производительность и удобство', () => {
    expect(wanted('performance', 'sodium')).toBe(true)
    expect(wanted('performance', 'reeses_sodium_options')).toBe(true)
    expect(wanted('performance', 'c2me')).toBe(true)
    expect(wanted('performance', 'xaerominimap')).toBe(true)
    expect(wanted('performance', 'mousetweaks')).toBe(true)
    expect(wanted('performance', 'inventorysorter')).toBe(true)
    expect(wanted('performance', 'controlling')).toBe(true)
    expect(wanted('performance', 'iris')).toBe(false)
    expect(wanted('performance', 'punchy')).toBe(false)
    expect(wanted('performance', 'gpu_booster')).toBe(false)
  })

  it('Свои выключает всё', () => {
    expect(wanted('custom', 'sodium')).toBe(false)
    expect(wanted('custom', 'xaerominimap')).toBe(false)
  })
})

describe('исправления', () => {
  it('скрыты от игрока', () => {
    expect(isHidden(mod('modelfix', []))).toBe(true)
    expect(isHidden(mod('derenderpatcher', []))).toBe(true)
    expect(isHidden(mod('apotheosis_tooltip_fix', []))).toBe(true)
    expect(isHidden(mod('sodium', []))).toBe(false)
  })

  it('всегда включаются, даже если их выключили вручную', () => {
    expect(libraryChanges([mod('modelfix', [], false)]).enable).toEqual(['modelfix.jar'])
  })

  it('никогда не выключаются', () => {
    expect(libraryChanges([mod('modelfix', [])])).toEqual({ enable: [], disable: [] })
  })

  it('выключаются без нужного им мода и включаются вместе с ним', () => {
    const patcher = (enabled: boolean) => mod('derenderpatcher', ['sodium'], enabled)
    expect(libraryChanges([patcher(true), mod('sodium', [], false)]).disable).toEqual(['derenderpatcher.jar'])
    expect(libraryChanges([patcher(false), mod('sodium', [], true)]).enable).toEqual(['derenderpatcher.jar'])
    expect(libraryChanges([patcher(true), mod('sodium', [], true)])).toEqual({ enable: [], disable: [] })
  })

  it('не считают обязательные моды сервера причиной выключения', () => {
    const fix = mod('derenderpatcher', ['draconicevolution'], true)
    expect(libraryChanges([fix])).toEqual({ enable: [], disable: [] })
  })

  it('удерживают нужную им библиотеку', () => {
    const fix = mod('modelfix', ['toadlib'], false)
    const lib = mod('toadlib', [])
    expect(libraryChanges([fix, lib]).disable).toEqual([])
  })
})

describe('библиотеки', () => {
  const controlling = (enabled: boolean) => mod('controlling', ['searchables'], enabled)
  const searchables = (enabled: boolean) => mod('searchables', [], enabled)

  it('определяются только среди клиентских модов', () => {
    expect(isLibrary(searchables(true))).toBe(true)
    expect(isLibrary({ ...searchables(true), kind: 'user' })).toBe(false)
    expect(isLibrary(controlling(true))).toBe(false)
  })

  it('выключаются, когда ни один включённый мод их не использует', () => {
    expect(libraryChanges([controlling(false), searchables(true)])).toEqual({ enable: [], disable: ['searchables.jar'] })
  })

  it('включаются, когда нужны включённому моду', () => {
    expect(libraryChanges([controlling(true), searchables(false)])).toEqual({ enable: ['searchables.jar'], disable: [] })
  })

  it('ничего не меняют, когда всё уже верно', () => {
    expect(libraryChanges([controlling(true), searchables(true)])).toEqual({ enable: [], disable: [] })
  })

  it('учитывают свой мод игрока', () => {
    const own: ModInfo = { ...mod('my_mod', ['searchables']), kind: 'user' }
    expect(libraryChanges([own, controlling(false), searchables(true)]).disable).toEqual([])
  })

  it('учитывают цепочку библиотек', () => {
    const touch = mod('touch_n_motion', ['emf_compat_core'])
    const compat = mod('emf_compat_core', ['toadlib'], false)
    const toad = mod('toadlib', [], false)
    expect(libraryChanges([touch, compat, toad]).enable).toEqual(['emf_compat_core.jar', 'toadlib.jar'])
  })

  it('не зацикливаются и не считают нужными друг друга без внешнего мода', () => {
    const a = mod('toadlib', ['searchables'])
    const b = mod('searchables', ['toadlib'])
    expect(libraryChanges([a, b]).disable).toEqual(['toadlib.jar', 'searchables.jar'])
  })

  it('не выключаются, если описание включённого мода не прочиталось', () => {
    const unreadable: ModInfo = { ...mod('x', []), ids: [], kind: 'user' }
    expect(libraryChanges([unreadable, searchables(true)]).disable).toEqual([])
  })
})

describe('зависимости модов', () => {
  it('при выключении находит зависимые моды по цепочке', () => {
    const sodium = mod('sodium', [])
    const extra = mod('sodium_extra', ['sodium'])
    const reeses = mod('reeses', ['sodium_extra'])
    const other = mod('other', [])
    expect(dependentsOf([sodium, extra, reeses, other], sodium)).toEqual([extra, reeses])
  })

  it('уже выключенные зависимые моды не упоминает', () => {
    const sodium = mod('sodium', [])
    const extra = mod('sodium_extra', ['sodium'], false)
    expect(dependentsOf([sodium, extra], sodium)).toEqual([])
  })

  it('при включении находит выключенные зависимости по цепочке', () => {
    const sodium = mod('sodium', [], false)
    const extra = mod('sodium_extra', ['sodium'], false)
    const reeses = mod('reeses', ['sodium_extra'], false)
    expect(requirementsOf([sodium, extra, reeses], reeses)).toEqual([extra, sodium])
  })

  it('не зацикливается на взаимных зависимостях', () => {
    const a = mod('a', ['b'], false)
    const b = mod('b', ['a'], false)
    expect(requirementsOf([a, b], a)).toEqual([b])
    expect(dependentsOf([{ ...a, enabled: true }, { ...b, enabled: true }], a).length).toBeLessThanOrEqual(2)
  })
})
