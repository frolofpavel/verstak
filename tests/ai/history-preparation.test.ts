import { describe, it, expect } from 'vitest'
import { prepareHistoryForModel, historyStats, summaryBlock } from '../../electron/ai/history-preparation'
import type { HistoryMessage } from '../../electron/ai/history-preparation'
import { IGNORED_TOOLS_NUDGE } from '../../electron/ai/tool-mode'

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
    expect(b.content).toContain('Сжатый итог начала этого чата')
    expect(b.content).toContain('Конец итога')
  })

  // Ревью B #10: блок обещал модели «дальше — сообщения после него». Гарантировать это
  // нельзя: renderer гидрирует чат окном ~50 сообщений, и в длинном чате середина просто
  // отсутствует. Дыру создаёт окно, но обещание превращало «модель не видит середину» в
  // «модель уверена, что ничего не пропущено».
  it('блок НЕ обещает непрерывность истории', () => {
    const b = summaryBlock('итог')
    expect(b.content).not.toMatch(/Дальше — сообщения после него/)
    expect(b.content).toMatch(/часть промежуточных может отсутствовать/)
  })

  it('блок велит сказать о нехватке, а не додумать', () => {
    expect(summaryBlock('итог').content).toMatch(/не додумывай/)
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

// Бэклог (наблюдение живого прогона 18.07): corrective-nudge из ПРОШЛЫХ прогонов оседали в
// истории чата и продолжали отравлять контекст будущих ходов (модель читала «Ты не вызвал
// инструмент…» как факт и рефлексировала «система ожидает tool call»). Фильтруем их из payload'а.
// ЖИВОЙ in-run nudge сюда НЕ попадает: он добавляется в currentMessages в runner-api уже ПОСЛЕ
// сборки payload'а (ai.ts:468 → prepareHistoryForModel), поэтому анти-DeepSeek не страдает.
describe('протухшие corrective-nudge не уходят модели', () => {
  it('без снапшота: осевший в истории IGNORED_TOOLS_NUDGE вырезается из payload', () => {
    const hist: HistoryMessage[] = [
      m(1, 'user', 'сделай X'),
      m(2, 'assistant', 'думаю'),
      m(3, 'user', IGNORED_TOOLS_NUDGE),
      m(4, 'assistant', 'ок'),
      m(5, 'user', 'что на картинке?'),
    ]
    const out = prepareHistoryForModel(hist, null)
    expect(out.map(x => x.content)).not.toContain(IGNORED_TOOLS_NUDGE)
    expect(out).toHaveLength(4)
    expect(out.at(-1)!.content).toBe('что на картинке?')
  })

  it('со снапшотом: протухший nudge в хвосте тоже вырезается', () => {
    const hist: HistoryMessage[] = [
      m(1, 'user', 'старое'),
      m(2, 'assistant', 'старый ответ'),
      m(3, 'user', IGNORED_TOOLS_NUDGE),
      m(4, 'user', 'свежее'),
    ]
    const out = prepareHistoryForModel(hist, { summary: 'итог', throughMessageId: 2 })
    const joined = out.map(x => x.content).join('\n')
    expect(joined).not.toContain(IGNORED_TOOLS_NUDGE)
    expect(joined).toContain('свежее')
  })

  it('historyStats считает уже без протухших nudge', () => {
    const hist: HistoryMessage[] = [
      m(1, 'user', 'a'),
      m(2, 'user', IGNORED_TOOLS_NUDGE),
      m(3, 'user', 'b'),
    ]
    expect(historyStats(hist, null).sentMessages).toBe(2)
  })
})
