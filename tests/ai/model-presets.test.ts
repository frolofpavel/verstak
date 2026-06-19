import { describe, it, expect } from 'vitest'
import { buildModePreset, BEAST_PRESET, MAX_STEPS_REPORT } from '../../electron/ai/model-presets'

describe('model-presets — Шаг D (beast-автономность)', () => {
  it('автономные режимы (auto/bypass) → beast-пресет', () => {
    expect(buildModePreset('auto')).toBe(BEAST_PRESET)
    expect(buildModePreset('bypass')).toBe(BEAST_PRESET)
  })

  it('подтверждающие режимы → пусто (не навязываем автономность)', () => {
    expect(buildModePreset('ask')).toBe('')
    expect(buildModePreset('accept-edits')).toBe('')
    expect(buildModePreset('plan')).toBe('')
  })

  it('beast-пресет содержит ключевое: не сдавайся + жёсткая проверка + честный стоп', () => {
    expect(BEAST_PRESET).toMatch(/до полного решения|не останавливайся/i)
    expect(BEAST_PRESET).toMatch(/проверк|тест|typecheck/i)
    expect(BEAST_PRESET).toMatch(/блокиру|стену/i)
  })

  it('max-steps отчёт: структура сделано/не доделано/дальше', () => {
    expect(MAX_STEPS_REPORT).toMatch(/Что сделано/i)
    expect(MAX_STEPS_REPORT).toMatch(/НЕ доделано/i)
    expect(MAX_STEPS_REPORT).toMatch(/дальше|Рекомендация/i)
  })
})
