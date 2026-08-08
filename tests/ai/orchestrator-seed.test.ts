import { describe, it, expect } from 'vitest'
import { buildTaskSessionSeed } from '../../electron/ai/orchestrator/seed'

// Задача 10: оркестратор порождает ВИДИМУЮ дочернюю сессию. Seed — самодостаточное
// первое сообщение этой сессии (handoff #12). Чистый синтез — пинуется здесь.
describe('buildTaskSessionSeed — seed дочерней сессии', () => {
  it('включает задачу; тримит', () => {
    const s = buildTaskSessionSeed({ title: 'Отчёт', task: '  собери отчёт по Директу  ' })
    expect(s).toContain('собери отчёт по Директу')
    expect(s.startsWith(' ')).toBe(false)
  })

  it('добавляет контекст проекта, когда он есть', () => {
    const s = buildTaskSessionSeed({ title: 'X', task: 'сделай', projectContext: 'Проект на React, тесты vitest' })
    expect(s).toContain('сделай')
    expect(s).toContain('Проект на React, тесты vitest')
    expect(s.indexOf('сделай')).toBeLessThan(s.indexOf('React')) // задача раньше контекста
  })

  it('пустой контекст не добавляет секцию', () => {
    const s = buildTaskSessionSeed({ title: 'X', task: 'сделай', projectContext: '   ' })
    expect(s).toBe('сделай')
  })

  it('пустая задача → пустой seed (вызывающий не порождает сессию)', () => {
    expect(buildTaskSessionSeed({ title: 'X', task: '   ' })).toBe('')
  })

  // Задача C(а): бюджет сообщается ребёнку ФАКТОМ (не просьбой).
  it('turnsBudget → факт «У тебя N ходов» в seed', () => {
    const s = buildTaskSessionSeed({ title: 'X', task: 'собери отчёт', turnsBudget: 24 })
    expect(s).toContain('У тебя 24 ходов')
    expect(s).toContain('собери отчёт')
  })
  it('без turnsBudget блока «Рамки» нет (обратная совместимость)', () => {
    const s = buildTaskSessionSeed({ title: 'X', task: 'сделай' })
    expect(s).not.toContain('Рамки этой сессии')
    expect(s).toBe('сделай')
  })
})
