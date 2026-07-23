import { describe, it, expect } from 'vitest'
import { applySnapshotEvent } from '../../src/store/apply-snapshot-event'
import { freshSnapshot, type SessionSnapshot } from '../../src/store/session-snapshot'
import type { ChatMessage } from '../../src/types/api'

function snap(messages: ChatMessage[], over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...freshSnapshot(), messages, ...over }
}

describe('applySnapshotEvent — общее ядро роутинга стрим-событий', () => {
  it('text: добивает последний assistant', () => {
    const s = snap([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'При' }])
    const r = applySnapshotEvent(s, { type: 'text', text: 'вет' })
    expect(r.messages[1].content).toBe('Привет')
  })

  it('text: создаёт нового assistant, если последний — user', () => {
    const s = snap([{ role: 'user', content: 'hi' }])
    const r = applySnapshotEvent(s, { type: 'text', text: 'Ответ' })
    expect(r.messages).toHaveLength(2)
    expect(r.messages[1]).toMatchObject({ role: 'assistant', content: 'Ответ' })
  })

  it('text: создаёт assistant в пустом снапшоте', () => {
    const r = applySnapshotEvent(snap([]), { type: 'text', text: 'X' })
    expect(r.messages).toEqual([{ role: 'assistant', content: 'X' }])
  })

  it('thought: дописывает chain-of-thought к assistant', () => {
    const s = snap([{ role: 'assistant', content: 'a', thinking: 'ду' }])
    const r = applySnapshotEvent(s, { type: 'thought', text: 'маю' })
    expect(r.messages[0].thinking).toBe('думаю')
  })

  it('thought: no-op если последний — user (нет assistant для thinking)', () => {
    const s = snap([{ role: 'user', content: 'hi' }])
    const r = applySnapshotEvent(s, { type: 'thought', text: 'x' })
    expect(r.messages).toEqual(s.messages)
  })

  it('usage: аккумулирует поверх существующего', () => {
    const s = snap([], { sessionUsage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 } })
    const r = applySnapshotEvent(s, {
      type: 'usage',
      usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 7, inputAccounting: 'exclusive' },
    })
    expect(r.sessionUsage).toEqual({
      inputTokens: 13,
      outputTokens: 9,
      cachedInputTokens: 7,
      cacheWriteTokens: 7,
      inputAccounting: 'exclusive',
    })
  })

  it('done: гасит стрим + штампует длительность последнего assistant', () => {
    const s = snap([{ role: 'assistant', content: 'готово' }], { isStreaming: true, streamStartedAt: Date.now() - 1000 })
    const r = applySnapshotEvent(s, { type: 'done' })
    expect(r.isStreaming).toBe(false)
    expect(r.streamStartedAt).toBeNull()
    expect(typeof r.messages[0].responseDurationMs).toBe('number')
    expect(r.messages[0].responseDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('done: без streamStartedAt — гасит стрим, без штампа длительности', () => {
    const s = snap([{ role: 'assistant', content: 'x' }], { isStreaming: true, streamStartedAt: null })
    const r = applySnapshotEvent(s, { type: 'done' })
    expect(r.isStreaming).toBe(false)
    expect(r.messages[0].responseDurationMs).toBeUndefined()
  })

  it('error: добавляет пометку [Ошибка] к assistant + гасит стрим', () => {
    const s = snap([{ role: 'assistant', content: 'частичный' }], { isStreaming: true, streamStartedAt: Date.now() })
    const r = applySnapshotEvent(s, { type: 'error', message: 'нет ключа' })
    expect(r.messages[0].content).toBe('частичный\n\n[Ошибка: нет ключа]')
    expect(r.isStreaming).toBe(false)
  })

  it('error: без последнего assistant — пометку не добавляет, но стрим гасит', () => {
    const s = snap([{ role: 'user', content: 'hi' }], { isStreaming: true, streamStartedAt: Date.now() })
    const r = applySnapshotEvent(s, { type: 'error', message: 'boom' })
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0]).toEqual({ role: 'user', content: 'hi' })
    expect(r.isStreaming).toBe(false)
  })

  it('pending-write: сохраняет снапшот и добавляет видимый progress-шаг', () => {
    const s = snap([{ role: 'assistant', content: 'a' }])
    const r = applySnapshotEvent(s, { type: 'pending-write', callId: 'c1' })
    expect(r.messages).toEqual(s.messages)
    expect(r.agentProgress).toEqual([
      expect.objectContaining({
        id: 'write-c1',
        phase: 'write',
        status: 'running',
        title: 'Нужно подтвердить изменение файла',
      }),
    ])
  })

  it('сохраняет hasUnread и прочие поля снапшота при text', () => {
    const s = snap([], { hasUnread: true, runningPlanStep: { planId: 1, stepId: 2, title: 't' } })
    const r = applySnapshotEvent(s, { type: 'text', text: 'x' })
    expect(r.hasUnread).toBe(true)
    expect(r.runningPlanStep).toEqual({ planId: 1, stepId: 2, title: 't' })
  })

  it('иммутабельность: исходный снапшот и его messages не мутируются', () => {
    const original = snap([{ role: 'assistant', content: 'a' }])
    const frozenMsgs = original.messages
    applySnapshotEvent(original, { type: 'text', text: 'b' })
    expect(original.messages).toBe(frozenMsgs)
    expect(original.messages[0].content).toBe('a')
  })
})
