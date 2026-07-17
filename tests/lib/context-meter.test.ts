import { describe, it, expect } from 'vitest'
import { meterView, compactResultText, compactedHint, LONG_CHAT_TOKENS } from '../../src/lib/context-meter'
import type { ContextStateDTO } from '../../src/types/api'

/**
 * Срез 2.0.11-B: тексты и доступность кнопки сжатия.
 *
 * Проверяем не «строка равна строке», а обещания интерфейса: нельзя сжимать во время
 * ответа, нельзя обещать того, чего не было, и нельзя пугать человека жаргоном.
 */

const state = (over: Partial<ContextStateDTO> = {}): ContextStateDTO => ({
  totalMessages: 20,
  estimatedTokens: 5000,
  compacted: false,
  compactedThroughMessageId: null,
  canCompact: true,
  busy: false,
  ...over,
})

describe('состояние кнопки сжатия', () => {
  it('нет проекта → нельзя, с понятной причиной', () => {
    const v = meterView(null, false)
    expect(v.canCompact).toBe(false)
    expect(v.blockedReason).toContain('проект')
  })

  it('состояние не загружено → нельзя, без вранья про причину', () => {
    expect(meterView(null, true).canCompact).toBe(false)
  })

  // Сжать под работающей моделью = увести историю у неё из-под ног на полуслове.
  it('идёт ответ → нельзя, и человеку сказано дождаться', () => {
    const v = meterView(state({ busy: true }), true)
    expect(v.canCompact).toBe(false)
    expect(v.blockedReason).toContain('Дождись')
    expect(v.meta).toBe('идёт ответ')
  })

  it('busy важнее «можно» из состояния (гейт не обходится)', () => {
    expect(meterView(state({ busy: true, canCompact: true }), true).canCompact).toBe(false)
  })

  it('короткий разговор → нельзя, честно объяснено почему', () => {
    const v = meterView(state({ canCompact: false }), true)
    expect(v.canCompact).toBe(false)
    expect(v.blockedReason).toContain('короткий')
  })

  it('длинный разговор → можно', () => {
    expect(meterView(state(), true).canCompact).toBe(true)
  })

  it('разговор разросся → подсказываем сжать', () => {
    expect(meterView(state({ estimatedTokens: LONG_CHAT_TOKENS }), true).suggest).toBe(true)
    expect(meterView(state({ estimatedTokens: LONG_CHAT_TOKENS - 1 }), true).suggest).toBe(false)
  })

  it('уже сжат → это видно в подписи', () => {
    expect(meterView(state({ compacted: true }), true).meta).toBe('свёрнут')
  })
})

describe('текст результата', () => {
  it('успех → говорит, что переписка цела (главный страх человека)', () => {
    const r = compactResultText({
      ok: true,
      compactedCount: 14,
      keptCount: 6,
      snapshot: {
        id: 1, chatId: 7, summary: 'итог', throughMessageId: 14, sourceMaxMessageId: 20,
        providerId: 'claude', model: 'm', estimatedTokensBefore: 100, estimatedTokensAfter: 20, createdAt: 1,
      },
    })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('14')
    expect(r.text).toMatch(/видно целиком|останется|не тронут/i)
  })

  it('осечка → показываем причину с main, не выдумываем свою', () => {
    const r = compactResultText({ ok: false, reason: 'conflict', detail: 'во время сжатия пришло новое сообщение — контекст не тронут' })
    expect(r.ok).toBe(false)
    expect(r.text).toBe('во время сжатия пришло новое сообщение — контекст не тронут')
  })

  it('busy-осечка тоже доносится как есть', () => {
    expect(compactResultText({ ok: false, reason: 'busy', detail: 'идёт ответ — дождитесь окончания' }).text)
      .toContain('дождитесь')
  })
})

describe('подсказка про сжатие', () => {
  it('до сжатия обещает сохранность переписки', () => {
    expect(compactedHint(state())).toMatch(/останется|на месте/i)
  })

  it('после сжатия говорит, что прошлые итоги сохраняются (путь отката)', () => {
    expect(compactedHint(state({ compacted: true }))).toMatch(/сохраня/i)
  })

  // Павел — маркетолог. «Токены», «snapshot», «compaction» ему ничего не говорят.
  it('в текстах нет жаргона', () => {
    const texts = [
      compactedHint(state()),
      compactedHint(state({ compacted: true })),
      meterView(state({ busy: true }), true).blockedReason,
      meterView(state({ canCompact: false }), true).blockedReason,
    ]
    for (const t of texts) {
      expect(t).not.toMatch(/токен|snapshot|compact|контекстн\w* окн/i)
    }
  })
})
