import { describe, it, expect } from 'vitest'
import { resolvePlanGate } from '../../electron/ai/plan-gate'

describe('plan-gate: resolvePlanGate', () => {
  it('approve → выполнение (accept-edits) + сообщение «одобрил, приступай»', () => {
    const r = resolvePlanGate('approve', undefined, 'Рефактор auth')
    expect(r.newMode).toBe('accept-edits')
    expect(r.result).toContain('ОДОБРИЛ')
    expect(r.result).toContain('Рефактор auth')
    expect(r.result).toContain('выполнению')
  })

  it('revise → режим НЕ меняется + замечания переданы модели', () => {
    const r = resolvePlanGate('revise', 'добавь шаг с тестами', 'План X')
    expect(r.newMode).toBeNull()
    expect(r.result).toContain('ДОРАБОТАТЬ')
    expect(r.result).toContain('добавь шаг с тестами')
    expect(r.result).toContain('НЕ начинай выполнение')
  })

  it('reject → режим НЕ меняется + явный запрет выполнения', () => {
    const r = resolvePlanGate('reject', 'не тот подход', 'План Y')
    expect(r.newMode).toBeNull()
    expect(r.result).toContain('ОТКЛОНИЛ')
    expect(r.result).toContain('не тот подход')
    expect(r.result).toContain('Не выполняй')
  })

  it('revise/reject без feedback — корректное сообщение без хвоста «:»', () => {
    expect(resolvePlanGate('revise', undefined, 'П').result).not.toContain(': .')
    expect(resolvePlanGate('reject', '   ', 'П').result).toContain('ОТКЛОНИЛ план «П».')
  })
})
