import { describe, it, expect } from 'vitest'
import { leaveChat, keepStreamingOnlyWhenInflight, freshSnapshot, type SessionSnapshot, type ChatStateBundle } from '../../src/store/session-snapshot'

/**
 * Прямой unit вынесенного leaveChat (1.9.8 #3). Раньше двухшаг «снять активный чат
 * в фон + привести стрим-флаг к реальности» был рукописно продублирован в
 * switchChatSession и newChatSession — правка в одной копии, забытая в другой, и
 * есть race-класс. Теперь единый путь; тест фиксирует его контракт в изоляции
 * (lifecycle-тесты проверяют интеграцию через switch/new).
 */

function bundle(over: Partial<ChatStateBundle> = {}): ChatStateBundle {
  const base = freshSnapshot()
  delete (base as { hasUnread?: boolean }).hasUnread
  return {
    messages: [{ role: 'assistant', content: 'hi' }],
    isStreaming: false,
    streamStartedAt: null,
    pendingWrites: [],
    pendingCommand: null,
    activity: [],
    agentProgress: [],
    sessionUsage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 },
    runningPlanStep: null,
    checkpointId: 42,
    checkpointMessageId: 43,
    preflights: [],
    subagentRuns: [],
    ...over,
  }
}

describe('leaveChat — единый уход активного чата в фон', () => {
  it('снимает bundle активного чата в snapshots[activeChatId] со всеми полями', () => {
    const active = bundle({ messages: [{ role: 'user', content: 'X' }] })
    const out = leaveChat({}, 1, 2, active, false)
    expect(out[1]).toBeDefined()
    expect(out[1].messages).toBe(active.messages)
    expect(out[1].checkpointId).toBe(42)
    expect(out[1].hasUnread).toBe(false)  // только что смотрели
  })

  it('switch на самого себя (activeChatId === movingToId) — не снапшотит', () => {
    const out = leaveChat({}, 5, 5, bundle(), false)
    expect(out[5]).toBeUndefined()
  })

  it('activeChatId=null — ничего не снапшотит', () => {
    const out = leaveChat({}, null, 2, bundle(), false)
    expect(Object.keys(out)).toHaveLength(0)
  })

  it('in-flight + isStreaming → живой стрим уходящего чата сохранён', () => {
    const active = bundle({ isStreaming: true, streamStartedAt: 1000 })
    const out = leaveChat({}, 1, 2, active, true)
    expect(out[1].isStreaming).toBe(true)
    expect(out[1].streamStartedAt).toBe(1000)
  })

  it('НЕ in-flight + isStreaming → фантом стрима снят (анти-залипание баннера)', () => {
    const active = bundle({ isStreaming: true, streamStartedAt: 1000 })
    const out = leaveChat({}, 1, 2, active, false)
    expect(out[1].isStreaming).toBe(false)
    expect(out[1].streamStartedAt).toBeNull()
  })

  it('не мутирует исходную карту снапшотов (возвращает свежую копию)', () => {
    const src: Record<number, SessionSnapshot> = {}
    const out = leaveChat(src, 1, 2, bundle(), false)
    expect(out).not.toBe(src)
    expect(Object.keys(src)).toHaveLength(0)  // исходник не тронут
  })
})

describe('keepStreamingOnlyWhenInflight — приведение стрим-флага к реальности', () => {
  it('in-flight + streaming → тот же объект (без изменений)', () => {
    const snap = { ...freshSnapshot(), isStreaming: true, streamStartedAt: 5 }
    expect(keepStreamingOnlyWhenInflight(snap, true)).toBe(snap)
  })
  it('не streaming и нет streamStartedAt → тот же объект', () => {
    const snap = freshSnapshot()
    expect(keepStreamingOnlyWhenInflight(snap, false)).toBe(snap)
  })
  it('streaming, но НЕ in-flight → флаг снят', () => {
    const snap = { ...freshSnapshot(), isStreaming: true, streamStartedAt: 5 }
    const out = keepStreamingOnlyWhenInflight(snap, false)
    expect(out.isStreaming).toBe(false)
    expect(out.streamStartedAt).toBeNull()
  })
})
