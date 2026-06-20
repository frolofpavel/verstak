import { describe, it, expect } from 'vitest'
import {
  appendOrStartAssistant,
  appendToLastAssistant,
  appendThinkingToLastAssistant,
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
