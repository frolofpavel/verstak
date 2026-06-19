import { describe, it, expect } from 'vitest'
import { scoreTaskSpec, planSpecFeedback } from '../../electron/ai/task-spec-check'

describe('scoreTaskSpec — серверная проверка ТЗ (v3 Шаг B enforcement)', () => {
  it('хорошее ТЗ (пути + критерий + детальность) → ok', () => {
    const good = 'В src/lib/auth.ts добавить функцию validateToken(token): проверяет подпись JWT. ' +
      'Готово, когда tests/auth.test.ts зелёный и tsc без ошибок.'
    expect(scoreTaskSpec(good)).toEqual({ ok: true, missing: [] })
  })

  it('заглушка без путей и критерия → not ok, перечисляет нехватку', () => {
    const s = scoreTaskSpec('улучшить производительность')
    expect(s.ok).toBe(false)
    expect(s.missing).toContain('конкретные файлы/пути')
    expect(s.missing).toContain('критерий готовности («сделано» = что)')
  })

  it('путь есть, критерия нет', () => {
    const s = scoreTaskSpec('Поменять что-то большое и важное внутри модуля src/store целиком везде')
    expect(s.missing).toContain('критерий готовности («сделано» = что)')
    expect(s.missing).not.toContain('конкретные файлы/пути')
  })

  it('пусто/null → всё отсутствует', () => {
    expect(scoreTaskSpec(null).ok).toBe(false)
    expect(scoreTaskSpec('').missing.length).toBe(3)
  })
})

describe('planSpecFeedback — фидбэк по тонким шагам плана', () => {
  it('все шаги детальные → пустой фидбэк', () => {
    const steps = [
      { title: 'A', detail: 'В src/a.ts добавить foo(). Готово когда npm run type зелёный.' },
      { title: 'B', detail: 'В src/b.ts удалить bar. Проверь что tests/b.test.ts проходит.' },
    ]
    expect(planSpecFeedback(steps)).toBe('')
  })

  it('тонкие шаги → перечислены с номером и нехваткой', () => {
    const steps = [
      { title: 'Хороший', detail: 'В src/a.ts добавить foo(). Готово когда tsc зелёный.' },
      { title: 'Улучшить', detail: 'улучшить' },
    ]
    const fb = planSpecFeedback(steps)
    expect(fb).toMatch(/Тонкое ТЗ у 1 шаг/)
    expect(fb).toMatch(/#2 «Улучшить»/)
    expect(fb).not.toMatch(/#1/) // первый шаг хороший
  })
})
