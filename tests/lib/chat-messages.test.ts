import { describe, it, expect } from 'vitest'
import {
  appendOrStartAssistant,
  appendToLastAssistant,
  appendThinkingToLastAssistant,
  historyForSend,
} from '../../src/lib/chat-messages'
import type { ChatMessage } from '../../src/types/api'

const user = (c: string): ChatMessage => ({ role: 'user', content: c })
const ai = (c: string, thinking?: string): ChatMessage => ({ role: 'assistant', content: c, thinking })

describe('chat-messages — чистые операции над сообщениями', () => {
  describe('appendOrStartAssistant', () => {
    it('дописывает к последнему assistant', () => {
      const r = appendOrStartAssistant([user('hi'), ai('При')], 'вет')
      expect(r[1].content).toBe('Привет')
    })
    it('создаёт нового assistant, если последний — user', () => {
      const r = appendOrStartAssistant([user('hi')], 'Ответ')
      expect(r).toHaveLength(2)
      expect(r[1]).toMatchObject({ role: 'assistant', content: 'Ответ' })
    })
    it('создаёт assistant из пустого списка', () => {
      expect(appendOrStartAssistant([], 'X')).toEqual([{ role: 'assistant', content: 'X' }])
    })
  })

  describe('appendToLastAssistant', () => {
    it('дописывает к последнему assistant', () => {
      const r = appendToLastAssistant([ai('a')], 'b')
      expect(r[0].content).toBe('ab')
    })
    it('no-op, если последний — user (нового не создаёт)', () => {
      const msgs = [user('hi')]
      const r = appendToLastAssistant(msgs, 'x')
      expect(r).toEqual(msgs)
      expect(r).toHaveLength(1)
    })
    it('no-op на пустом списке', () => {
      expect(appendToLastAssistant([], 'x')).toEqual([])
    })
  })

  describe('appendThinkingToLastAssistant', () => {
    it('дописывает thinking к последнему assistant', () => {
      const r = appendThinkingToLastAssistant([ai('a', 'ду')], 'маю')
      expect(r[0].thinking).toBe('думаю')
    })
    it('инициализирует thinking из undefined', () => {
      const r = appendThinkingToLastAssistant([ai('a')], 'старт')
      expect(r[0].thinking).toBe('старт')
    })
    it('no-op, если последний — user', () => {
      const msgs = [user('hi')]
      expect(appendThinkingToLastAssistant(msgs, 'x')).toEqual(msgs)
    })
  })

  it('иммутабельность: исходный массив и его элементы не мутируются', () => {
    const original = [ai('a')]
    const frozen = original[0]
    appendOrStartAssistant(original, 'b')
    appendThinkingToLastAssistant(original, 't')
    expect(original[0]).toBe(frozen)
    expect(original[0].content).toBe('a')
    expect(original[0].thinking).toBeUndefined()
  })
})

/**
 * Хвост ревью 2.0.11-B (#3/#4/#9): историю для отправки собирали ДВЕ копии одной функции
 * (Chat.tsx и SideChat.tsx), и обе срезали dbId.
 *
 * Почему это хуже, чем «сжатие не работает»: без dbId main считает ВСЕ сообщения свежими
 * и шлёт модели [итог + полная история] — контекст РАСТЁТ, а человек уже заплатил за
 * генерацию итога. Сжатие, которое делает хуже, чем его отсутствие.
 */
describe('historyForSend — история для модели', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'первое', dbId: 1 },
    { role: 'assistant', content: '', dbId: 2 },
    { role: 'assistant', content: 'ответ', dbId: 3 },
    { role: 'user', content: '   ', dbId: 4 },
    { role: 'user', content: 'печатаю сейчас' },
  ]

  it('пустые болванки не уходят модели', () => {
    expect(historyForSend(msgs).map(m => m.content)).toEqual(['первое', 'ответ', 'печатаю сейчас'])
  })

  // Несущее: по dbId main режет историю по границе сжатого итога.
  it('dbId СОХРАНЯЕТСЯ — иначе сжатие вырождается в «итог + вся история»', () => {
    expect(historyForSend(msgs).map(m => m.dbId)).toEqual([1, 3, undefined])
  })

  it('сообщение без dbId (ещё не в БД) не ломает сборку', () => {
    expect(historyForSend([{ role: 'user', content: 'свежее' }])).toEqual([{ role: 'user', content: 'свежее' }])
  })

  it('UI-обвес не уходит модели (thinking/appliedSkills)', () => {
    const out = historyForSend([{ role: 'assistant', content: 'ответ', dbId: 1, thinking: 'размышляю', appliedSkills: [{ id: 's' }] }])
    expect(out[0]).toEqual({ role: 'assistant', content: 'ответ', dbId: 1 })
  })

  it('исходный массив не мутируется', () => {
    const src: ChatMessage[] = [{ role: 'user', content: 'a', dbId: 1 }]
    historyForSend(src)
    expect(src).toEqual([{ role: 'user', content: 'a', dbId: 1 }])
  })
})
