import { describe, it, expect } from 'vitest'
import { forkPointForMessage } from '../../src/lib/fork-edit'
import type { ChatMessage } from '../../src/types/api'

/**
 * Срез 2.0.11-D: правка/перезапуск сообщения строго через Fork.
 *
 * Здесь ЧИСТАЯ часть — где резать форк. Правка не мутирует оригинал: вместо этого мы
 * форкаем историю ДО редактируемого сообщения (не включая его), а отредактированный текст
 * уйдёт в ветку черновиком. Так оригинал остаётся byte-for-byte, а неудачная правка не
 * рушит исходный чат.
 *
 * Редактируем только СВОЙ ввод (user-сообщение): ответ ассистента генерируется, «править»
 * его и перезапускать с него бессмысленно — перезапуск идёт от реплики человека.
 */

const m = (dbId: number, role: 'user' | 'assistant', content: string): ChatMessage =>
  ({ role, content, dbId })

const history: ChatMessage[] = [
  m(1, 'user', 'первый вопрос'),
  m(2, 'assistant', 'первый ответ'),
  m(3, 'user', 'второй вопрос'),
  m(4, 'assistant', 'второй ответ'),
]

describe('forkPointForMessage — где резать форк при правке', () => {
  it('правка сообщения в середине → форк до ПРЕДЫДУЩЕГО (редактируемое не входит)', () => {
    const r = forkPointForMessage(history, 3)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.uptoMessageId).toBe(2)          // история до «первого ответа» включительно
    expect(r.originalText).toBe('второй вопрос') // черновик для композера ветки
  })

  it('правка ПЕРВОГО сообщения → форк пустой (uptoMessageId = null)', () => {
    const r = forkPointForMessage(history, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.uptoMessageId).toBeNull()
    expect(r.originalText).toBe('первый вопрос')
  })

  it('сообщения нет → not-found', () => {
    const r = forkPointForMessage(history, 999)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('not-found')
  })

  // Ответ ассистента не редактируется — перезапуск идёт от реплики человека.
  it('правка ответа ассистента → not-user-message', () => {
    const r = forkPointForMessage(history, 2)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('not-user-message')
  })

  it('сообщение без dbId (ещё не в БД) → not-found (форкать нечего)', () => {
    const withOptimistic = [...history, { role: 'user' as const, content: 'печатаю' }]
    // dbId нет → найти по нему нельзя; правка оптимистичного = просто текст в композере.
    const r = forkPointForMessage(withOptimistic, undefined as unknown as number)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('not-found')
  })

  // Граница берётся по ПОРЯДКУ в истории, а не по арифметике id: id в chats глобальны
  // и между сообщениями чата лежат id других чатов (дыры). Предыдущее — по позиции.
  it('граница — предыдущее ПО ПОРЯДКУ, а не id−1 (id могут иметь дыры)', () => {
    const gapped: ChatMessage[] = [
      m(10, 'user', 'а'),
      m(25, 'assistant', 'б'),
      m(40, 'user', 'в'),
    ]
    const r = forkPointForMessage(gapped, 40)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.uptoMessageId).toBe(25) // предыдущее по позиции, не 39
  })
})
