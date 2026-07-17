import { describe, it, expect } from 'vitest'
import { prepareHistoryForModel, historyStats, summaryBlock } from '../../electron/ai/history-preparation'
import type { HistoryMessage } from '../../electron/ai/history-preparation'

/**
 * Срез 2.0.11-B: что реально уходит модели после сжатия (карточка п.6).
 *
 * Ключевое разделение: здесь строится ТОЛЬКО payload запроса. Видимая переписка живёт
 * отдельно и сжатием не портится — это проверяется в storage-тестах.
 */

const m = (dbId: number | undefined, role: 'user' | 'assistant', content: string): HistoryMessage =>
  ({ role, content, ...(dbId != null ? { dbId } : {}) })

describe('история для модели со снапшотом (2.0.11-B)', () => {
  const history: HistoryMessage[] = [
    m(1, 'user', 'первое'),
    m(2, 'assistant', 'ответ на первое'),
    m(3, 'user', 'второе'),
    m(4, 'assistant', 'ответ на второе'),
    m(5, 'user', 'свежий вопрос'),
  ]

  it('снапшота нет → история как есть (поведение не меняется)', () => {
    expect(prepareHistoryForModel(history, null)).toEqual(history)
  })

  it('пустой summary не считается сжатием (не шлём мусорный блок)', () => {
    expect(prepareHistoryForModel(history, { summary: '   ', throughMessageId: 4 })).toEqual(history)
  })

  it('снапшот есть → summary отдельным блоком + ТОЛЬКО хвост после границы', () => {
    const out = prepareHistoryForModel(history, { summary: 'обсудили первое и второе', throughMessageId: 4 })
    expect(out).toHaveLength(2)
    expect(out[0].content).toContain('обсудили первое и второе')
    expect(out[0].content).toContain('Сжатый итог')
    expect(out[1].content).toBe('свежий вопрос') // хвост на месте
  })

  it('сжатое НЕ дублируется: сообщения до границы в запрос не попадают', () => {
    const out = prepareHistoryForModel(history, { summary: 'итог', throughMessageId: 4 })
    const joined = out.map(x => x.content).join('\n')
    expect(joined).not.toContain('ответ на первое')
    expect(joined).not.toContain('второе')
  })

  // Только что напечатанное ещё не имеет id в БД. Отфильтровать его = потерять вопрос
  // человека прямо в момент отправки.
  it('оптимистичные сообщения (без dbId) всегда в хвосте', () => {
    const withOptimistic = [...history, m(undefined, 'user', 'печатаю прямо сейчас')]
    const out = prepareHistoryForModel(withOptimistic, { summary: 'итог', throughMessageId: 5 })
    expect(out.at(-1)!.content).toBe('печатаю прямо сейчас')
  })

  it('снапшот покрыл ВСЮ переписку → уходит один summary, а не пустая история', () => {
    const out = prepareHistoryForModel(history, { summary: 'весь разговор', throughMessageId: 5 })
    expect(out).toHaveLength(1)
    expect(out[0].content).toContain('весь разговор')
  })

  it('граница в середине → хвост начинается сразу после неё', () => {
    const out = prepareHistoryForModel(history, { summary: 'итог', throughMessageId: 2 })
    expect(out.slice(1).map(x => x.content)).toEqual(['второе', 'ответ на второе', 'свежий вопрос'])
  })

  it('summary честно помечен как сжатие (модель не примет его за реплику человека)', () => {
    const b = summaryBlock('итог')
    expect(b.content).toContain('[Сжатый итог предыдущей части этого чата]')
    expect(b.content).toContain('Дальше — сообщения после него')
  })

  it('статистика показывает РЕАЛЬНЫЙ эффект, а не обещание', () => {
    expect(historyStats(history, null)).toEqual({ totalMessages: 5, sentMessages: 5, compacted: false })
    expect(historyStats(history, { summary: 'итог', throughMessageId: 4 }))
      .toEqual({ totalMessages: 5, sentMessages: 2, compacted: true })
  })

  it('пустая история не падает', () => {
    expect(prepareHistoryForModel([], null)).toEqual([])
    expect(prepareHistoryForModel([], { summary: 'итог', throughMessageId: 5 })).toHaveLength(1)
  })
})
