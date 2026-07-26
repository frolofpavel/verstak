import { describe, it, expect } from 'vitest'
import { keepStreamingOnlyWhenInflight, freshSnapshot, type SessionSnapshot } from '../../src/store/session-snapshot'

/**
 * Прямой unit вынесенного leaveChat (1.9.8 #3). Раньше двухшаг «снять активный чат
 * в фон + привести стрим-флаг к реальности» был рукописно продублирован в
 * switchChatSession и newChatSession — правка в одной копии, забытая в другой, и
 * есть race-класс. Теперь единый путь; тест фиксирует его контракт в изоляции
 * (lifecycle-тесты проверяют интеграцию через switch/new).
 */

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
