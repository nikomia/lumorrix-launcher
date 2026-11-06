import { describe, expect, it } from 'vitest'
import { defaultJvmPreset } from '../src/main/settings'

describe('параметры Java по умолчанию', () => {
  it('для слабого ПК при 8 ГБ ОЗУ и меньше', () => {
    expect(defaultJvmPreset(4)).toBe('lowend')
    expect(defaultJvmPreset(8)).toBe('lowend')
  })

  it('G1 при большем объёме', () => {
    expect(defaultJvmPreset(12)).toBe('g1')
    expect(defaultJvmPreset(32)).toBe('g1')
  })
})
