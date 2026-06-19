import { describe, it, expect } from 'vitest'
import { scoreTaskSpec, TASK_SPEC_CONTRACT } from '../../src/lib/task-spec'

describe('scoreTaskSpec — контракт ТЗ-задачи (v3 Шаг B)', () => {
  it('хорошее ТЗ (пути + критерий + детальность) → ok', () => {
    const good = 'В src/lib/auth.ts добавить функцию validateToken(token): проверяет подпись JWT. ' +
      'Готово, когда tests/auth.test.ts зелёный и tsc без ошибок.'
    const s = scoreTaskSpec(good)
    expect(s.ok).toBe(true)
    expect(s.missing).toEqual([])
  })

  it('заглушка без путей и критерия → not ok, перечисляет нехватку', () => {
    const s = scoreTaskSpec('улучшить производительность')
    expect(s.ok).toBe(false)
    expect(s.missing).toContain('конкретные файлы/пути')
    expect(s.missing).toContain('критерий готовности («сделано» = что)')
  })

  it('есть путь, но нет критерия готовности', () => {
    const s = scoreTaskSpec('Поменять что-то большое и важное внутри модуля src/store целиком везде')
    expect(s.ok).toBe(false)
    expect(s.missing).toContain('критерий готовности («сделано» = что)')
    expect(s.missing).not.toContain('конкретные файлы/пути')
  })

  it('слишком короткое описание → не хватает детальности', () => {
    const s = scoreTaskSpec('fix a.ts')
    expect(s.missing).toContain('детальность (минимум пара конкретных предложений)')
  })

  it('пусто/null → всё отсутствует', () => {
    expect(scoreTaskSpec(null).ok).toBe(false)
    expect(scoreTaskSpec('').missing.length).toBe(3)
  })

  it('контракт содержит ключевые требования (пути, критерий, one concern)', () => {
    expect(TASK_SPEC_CONTRACT).toMatch(/файлы\/пути/i)
    expect(TASK_SPEC_CONTRACT).toMatch(/критерий готовности/i)
    expect(TASK_SPEC_CONTRACT).toMatch(/одна задача = одна забота/i)
  })
})
