import { describe, it, expect } from 'vitest'
import { buildDecisionsBlock, MAX_DECISIONS, type DecisionForContext } from '../../electron/ai/decisions-context'

// ДЕФЕКТ (31.08): Verstak давно пишет Decision Record — решение, почему, возражения,
// риски и ОТВЕРГНУТЫЕ АЛЬТЕРНАТИВЫ. Человеку это показывается (панель «Решения»,
// карточка прогона). Агенту — НИКОГДА: context-pack о решениях не знал. Поэтому
// назавтра агент начинал с чистого листа и предлагал ровно то, что вчера разобрали и
// отклонили.
//
// ГЛАВНЫЙ ПИН: отвергнутое доезжает до контекста и помечено так, что его нельзя
// прочитать как рекомендацию.
//
// Почему именно отвергнутое, а не «цель и веха» (как у конкурентов): память о тупиках
// экономит не токены, а прогон целиком, и её нельзя вывести из кода — она копится
// только работой.

const d = (over: Partial<DecisionForContext> = {}): DecisionForContext => ({
  title: 'Хранение сессий',
  finalDecision: 'SQLite на пользователя',
  why: 'один файл переносится и бэкапится',
  alternativesRejected: ['общая БД на всех', 'файлы JSON на диске'],
  createdAt: Date.UTC(2026, 7, 20),
  ...over,
})

describe('решения прошлых сессий: блок для агента', () => {
  it('отвергнутые альтернативы попадают в блок и помечены явно', () => {
    const out = buildDecisionsBlock([d()])
    expect(out).toContain('общая БД на всех')
    expect(out).toContain('УЖЕ ОТВЕРГНУТО')
  })

  it('блок велит не предлагать отвергнутое заново без новой причины', () => {
    const out = buildDecisionsBlock([d()])
    expect(out).toMatch(/не предлагай заново/i)
    // И при этом НЕ запрещает пересмотр: устаревшее решение можно оспорить, сказав,
    // что изменилось. Запрет без выхода превратил бы память в догму.
    expect(out).toMatch(/устарел|что изменилось/i)
  })

  it('решение и причина видны — иначе «отвергнуто» не с чем соотнести', () => {
    const out = buildDecisionsBlock([d()])
    expect(out).toContain('SQLite на пользователя')
    expect(out).toContain('один файл переносится')
  })

  it('длинный список ограничен — блок идёт в каждый первый ход', () => {
    const many = Array.from({ length: 20 }, (_, i) => d({ title: `Решение ${i}` }))
    const out = buildDecisionsBlock(many)
    const shown = out.split('\n').filter(l => /^- \d\d\.\d\d Решение /.test(l)).length
    expect(shown).toBe(MAX_DECISIONS)
  })

  it('длинные строки режутся — одно многословное решение не съедает блок', () => {
    const out = buildDecisionsBlock([d({ title: 'т'.repeat(600), alternativesRejected: ['а'.repeat(600)] })])
    for (const line of out.split('\n')) expect(line.length).toBeLessThan(220)
  })

  // КОНТРОЛЬНЫЕ КЕЙСЫ.
  it('решений нет — секции нет вовсе, а не пустой заголовок', () => {
    // Пустой заголовок приучает модель пролистывать блок и обесценивает его в тот
    // день, когда он наполнится.
    expect(buildDecisionsBlock([])).toBe('')
  })

  it('решение без отвергнутых альтернатив не выдумывает пометку', () => {
    const out = buildDecisionsBlock([d({ alternativesRejected: [] })])
    expect(out).toContain('Хранение сессий')
    expect(out).not.toContain('УЖЕ ОТВЕРГНУТО')
  })

  it('запись без заголовка отбрасывается — мусор в контекст не идёт', () => {
    expect(buildDecisionsBlock([d({ title: '   ' })])).toBe('')
  })
})
