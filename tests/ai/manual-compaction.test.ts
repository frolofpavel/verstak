import { describe, it, expect } from 'vitest'
import { pickBoundary, buildCompactionPrompt, estimateTokens, KEEP_RECENT_MESSAGES } from '../../electron/ai/manual-compaction'
import type { CompactableMessage } from '../../electron/ai/manual-compaction'

/**
 * Срез 2.0.11-B: ручная компакция — выбор границы и промпт суммаризатора.
 *
 * Ручная компакция обязана быть ПРЕДСКАЗУЕМОЙ: человек сам нажал «сожми», значит видно,
 * что именно сожмётся, и ошибка ничего не портит.
 */

const m = (dbId: number | undefined, role: 'user' | 'assistant', content = 'текст'): CompactableMessage =>
  ({ role, content, ...(dbId != null ? { dbId } : {}) })

const many = (n: number): CompactableMessage[] =>
  Array.from({ length: n }, (_, i) => m(i + 1, i % 2 === 0 ? 'user' : 'assistant', `сообщение ${i + 1}`))

describe('выбор границы компакции (2.0.11-B)', () => {
  it('пустой чат → сжимать нечего', () => {
    const r = pickBoundary([])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('empty')
  })

  it('короткий чат → сжимать нечего (последние держим целиком)', () => {
    const r = pickBoundary(many(4))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('nothing-to-compact')
  })

  it('ровно порог → ещё не сжимаем', () => {
    expect(pickBoundary(many(KEEP_RECENT_MESSAGES)).ok).toBe(false)
  })

  it('длинный чат → граница оставляет последние сообщения дословно', () => {
    const r = pickBoundary(many(20))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.boundary.keptCount).toBe(KEEP_RECENT_MESSAGES)
    expect(r.boundary.compactedCount).toBe(20 - KEEP_RECENT_MESSAGES)
    expect(r.boundary.throughMessageId).toBe(14) // 20 − 6 = 14-е сообщение
  })

  // Сжать ВСЁ, включая только что сказанное, — верный способ сделать ответ бессвязным:
  // модель потеряет живую нить прямо посреди разговора.
  it('свежие сообщения НИКОГДА не попадают под сжатие', () => {
    const r = pickBoundary(many(20))
    if (!r.ok) return
    expect(r.boundary.throughMessageId).toBeLessThan(20 - KEEP_RECENT_MESSAGES + 1)
  })

  // Снапшот ссылается на id строки. Сжать то, чего в БД нет, = сослаться в пустоту.
  it('оптимистичные сообщения (без dbId) в границу не попадают', () => {
    const msgs = [...many(10), m(undefined, 'user', 'печатаю прямо сейчас')]
    const r = pickBoundary(msgs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.boundary.compactedCount).toBe(10 - KEEP_RECENT_MESSAGES) // 11-е не считается
  })

  it('порог настраивается (для теста/будущего UI)', () => {
    const r = pickBoundary(many(10), 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.boundary.keptCount).toBe(2)
    expect(r.boundary.throughMessageId).toBe(8)
  })
})

describe('промпт суммаризатора', () => {
  const msgs: CompactableMessage[] = [
    m(1, 'user', 'нужно починить экспорт в src/export.ts'),
    m(2, 'assistant', 'сделал, критерий готовности — тест зелёный'),
    m(3, 'user', 'свежее сообщение — не должно попасть'),
  ]

  it('в промпт уходит ТОЛЬКО то, что до границы', () => {
    const p = buildCompactionPrompt(msgs, 2)
    expect(p.user).toContain('src/export.ts')
    expect(p.user).toContain('критерий готовности')
    expect(p.user).not.toContain('свежее сообщение') // за границей — не сжимаем
  })

  it('роли подписаны по-человечески (модель поймёт, кто говорил)', () => {
    const p = buildCompactionPrompt(msgs, 2)
    expect(p.user).toContain('Пользователь:')
    expect(p.user).toContain('Ассистент:')
  })

  it('система требует сохранить решения/файлы/запреты и запрещает вымысел', () => {
    const p = buildCompactionPrompt(msgs, 2)
    expect(p.system).toContain('решения')
    expect(p.system).toContain('файлы')
    expect(p.system).toContain('запреты')
    expect(p.system).toContain('пропуск лучше вымысла') // сжатие не смеет придумывать
  })

  it('оптимистичные сообщения в промпт не попадают', () => {
    const p = buildCompactionPrompt([...msgs, m(undefined, 'user', 'ещё не в БД')], 2)
    expect(p.user).not.toContain('ещё не в БД')
  })
})

describe('оценка размера', () => {
  it('пусто → 0', () => {
    expect(estimateTokens([])).toBe(0)
  })

  it('растёт с длиной (это ОЦЕНКА, не биллинг провайдера)', () => {
    const small = estimateTokens([{ content: 'а'.repeat(400) }])
    const big = estimateTokens([{ content: 'а'.repeat(4000) }])
    expect(small).toBe(100)
    expect(big).toBe(1000)
    expect(big).toBeGreaterThan(small)
  })

  // Ревью B #15: чат из скриншотов давал оценку ≈0 — счётчик уверял, что всё в порядке,
  // пока окно не лопнет.
  it('вложения весят: чат из скриншотов не выглядит пустым', () => {
    const screenshots = estimateTokens([{ content: '', attachments: [{ name: 'a.png' }, { name: 'b.png' }] }])
    expect(screenshots).toBeGreaterThan(1000)
  })

  it('ход рассуждений модели тоже занимает место', () => {
    expect(estimateTokens([{ content: 'ок', thinking: 'а'.repeat(4000) }]))
      .toBeGreaterThan(estimateTokens([{ content: 'ок' }]))
  })

  it('tool-нагрузка учитывается (в длинных агентных сессиях это основной вес)', () => {
    const withTools = estimateTokens([{ content: 'ок', toolResults: [{ id: '1', content: 'я'.repeat(2000) }] }])
    expect(withTools).toBeGreaterThan(400)
  })

  it('битые данные не роняют счётчик', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => estimateTokens([{ content: 'ок', toolCalls: [cyclic] }])).not.toThrow()
  })
})
