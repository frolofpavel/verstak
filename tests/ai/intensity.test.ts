import { describe, it, expect } from 'vitest'
import { intensityConfig, parseIntensity } from '../../electron/ai/intensity'

/**
 * Ось интенсивности Простой/Турбо — пресет глубины машинерии (effort + контекст +
 * поощрение оркестрации + подсказка промпта). Дефолт — Простой (предсказуемо/дёшево).
 */
describe('intensity', () => {
  it('parseIntensity: только "turbo" → turbo, всё прочее → simple (безопасный дефолт)', () => {
    expect(parseIntensity('turbo')).toBe('turbo')
    expect(parseIntensity('simple')).toBe('simple')
    expect(parseIntensity(null)).toBe('simple')
    expect(parseIntensity(undefined)).toBe('simple')
    expect(parseIntensity('мусор')).toBe('simple')
  })

  it('Простой: standard effort, лёгкий контекст, без проактивной оркестрации', () => {
    const c = intensityConfig('simple')
    expect(c.effortLevel).toBe('standard')
    expect(c.brainPack).toBe('short')
    expect(c.proactiveOrchestration).toBe(false)
    expect(c.systemHint).toContain('mode="simple"')
  })

  it('Турбо: deep effort, глубокий контекст, проактивная оркестрация', () => {
    const c = intensityConfig('turbo')
    expect(c.effortLevel).toBe('deep')
    expect(c.brainPack).toBe('long')
    expect(c.proactiveOrchestration).toBe(true)
    expect(c.systemHint).toContain('mode="turbo"')
  })

  it('подсказки задают противоположное поведение (прямо vs вся машинерия)', () => {
    expect(intensityConfig('simple').systemHint).toMatch(/Простой|прямо|сам/)
    expect(intensityConfig('turbo').systemHint).toMatch(/Турбо|delegate_task|swarm|LSP/)
  })
})
