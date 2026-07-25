import { describe, it, expect, beforeEach, vi } from 'vitest'
import { applyBundleUpdate, type BundleHostState } from '../../src/store/chat-bundle-update'
import { freshSnapshot } from '../../src/store/session-snapshot'
import type { ChatMessage } from '../../src/types/api'

// Литерал сообщения без widening role → string (freshSnapshot-спреды типизируют
// messages как ChatMessage[], голый литерал роль расширяет до string).
const um = (content: string): ChatMessage => ({ role: 'user', content })

// PerChatState 4.1 (writers-first): applyBundleUpdate — единая точка мутации
// bundle одного чата. Стражи: активный → top-level, фоновый → chatSnapshots,
// helpMode-активный-со-снапшотом → снапшот (регрессия: события чата, уведённого
// в фон справкой, падали в top-level и терлись при leaveHelpMode).

const host = (over: Partial<BundleHostState> = {}): BundleHostState => ({
  chatId: null,
  messages: [],
  isStreaming: false,
  streamStartedAt: null,
  pendingWrites: [],
  pendingCommand: null,
  activity: [],
  agentProgress: [],
  sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
  runningPlanStep: null,
  checkpointId: null,
  checkpointMessageId: null,
  preflights: [],
  subagentRuns: [],
  activeChatId: 1,
  helpMode: false,
  chatSnapshots: {},
  ...over,
})

describe('applyBundleUpdate — маршрутизация патча', () => {
  it('активный чат (chatId === activeChatId) → top-level, снапшоты не трогает', () => {
    const state = host({ messages: [{ role: 'user', content: 'a' }] })
    const patch = applyBundleUpdate(state, 1, b => ({ messages: [...b.messages, { role: 'assistant', content: 'b' }] }))
    expect(patch.messages).toHaveLength(2)
    expect(patch.chatSnapshots).toBeUndefined()
  })

  it('chatId == null → top-level (семантика «текущий активный»)', () => {
    const patch = applyBundleUpdate(host(), null, () => ({ isStreaming: true }))
    expect(patch.isStreaming).toBe(true)
    expect(patch.chatSnapshots).toBeUndefined()
  })

  it('фоновый чат с существующим снапшотом → мерж в снапшот, сосед цел', () => {
    const neighbor = { ...freshSnapshot(), messages: [um('n')] }
    const target = { ...freshSnapshot(), messages: [um('t')], hasUnread: true }
    const state = host({ chatSnapshots: { 2: target, 3: neighbor } })
    const patch = applyBundleUpdate(state, 2, b => ({ messages: [...b.messages, { role: 'assistant', content: 'x' }] }))
    expect(patch.chatSnapshots?.[2].messages).toHaveLength(2)
    expect(patch.chatSnapshots?.[2].hasUnread).toBe(true)
    expect(patch.chatSnapshots?.[3]).toBe(neighbor)
    expect(patch.messages).toBeUndefined()
  })

  it('фоновый чат без снапшота → freshSnapshot + патч', () => {
    const patch = applyBundleUpdate(host(), 9, () => ({ isStreaming: true, hasUnread: true }))
    const snap = patch.chatSnapshots?.[9]
    expect(snap?.isStreaming).toBe(true)
    expect(snap?.hasUnread).toBe(true)
    expect(snap?.messages).toEqual([])
    expect(snap?.pendingWrites).toEqual([])
  })

  it('updater → null = no-op: пустой патч, снапшот НЕ создаётся', () => {
    expect(applyBundleUpdate(host(), 1, () => null)).toEqual({})
    expect(applyBundleUpdate(host(), 9, () => null)).toEqual({})
  })

  it('hasUnread: для фона сохраняется, для top-level отбрасывается', () => {
    const bg = applyBundleUpdate(host(), 9, () => ({ hasUnread: true, isStreaming: true }))
    expect(bg.chatSnapshots?.[9].hasUnread).toBe(true)
    const top = applyBundleUpdate(host(), 1, () => ({ hasUnread: true, isStreaming: true }))
    expect(top.isStreaming).toBe(true)
    expect('hasUnread' in top).toBe(false)
  })

  it('helpMode: активный чат со снапшотом → патч в снапшот, не в top-level', () => {
    // openHelpChat снимает активный чат в chatSnapshots[activeChatId]; его стрим
    // продолжает идти через applyEventToChat. Патч обязан лечь в снапшот —
    // leaveHelpMode восстанавливает top-level ИЗ снапшота (старый баг: события
    // падали в top-level и терялись при выходе из справки).
    const bgSnap = { ...freshSnapshot(), messages: [um('q')] }
    const state = host({ helpMode: true, chatSnapshots: { 1: bgSnap } })
    const patch = applyBundleUpdate(state, 1, b => ({ messages: [...b.messages, { role: 'assistant', content: 'a' }] }))
    expect(patch.chatSnapshots?.[1].messages).toHaveLength(2)
    expect(patch.messages).toBeUndefined()
  })

  it('helpMode без снапшота активного чата → top-level (дегенеративный случай)', () => {
    const state = host({ helpMode: true })
    const patch = applyBundleUpdate(state, 1, () => ({ isStreaming: true }))
    expect(patch.isStreaming).toBe(true)
  })
})

// --- store-уровень: updateChatBundle как единая точка ---

const windowStub = {
  api: {
    chats: { listWindow: vi.fn(async () => ({ messages: [], totalCount: 0, hasMoreBefore: false })), list: vi.fn(async () => []), append: vi.fn(async () => {}) },
    settings: { setKey: vi.fn(async () => {}) },
    chatSessions: { listReviews: vi.fn(async () => []) },
  },
}
vi.stubGlobal('window', windowStub)

import { useProject } from '../../src/store/projectStore'

describe('updateChatBundle — store-уровень', () => {
  beforeEach(() => {
    useProject.setState({
      messages: [],
      isStreaming: false,
      streamStartedAt: null,
      pendingWrites: [],
      pendingCommand: null,
      activity: [],
      agentProgress: [],
      preflights: [],
      subagentRuns: [],
      sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
      runningPlanStep: null,
      checkpointId: null,
      checkpointMessageId: null,
      chatSnapshots: {},
      activeChatId: 1,
      helpMode: false,
    })
  })

  it('патч активного чата пишет top-level, снапшоты не создаёт', () => {
    useProject.getState().updateChatBundle(1, () => ({ isStreaming: true }))
    const s = useProject.getState()
    expect(s.isStreaming).toBe(true)
    expect(s.chatSnapshots).toEqual({})
  })

  it('патч фонового чата пишет снапшот, top-level не трогает', () => {
    useProject.getState().updateChatBundle(7, b => ({ messages: [...b.messages, { role: 'user', content: 'bg' }] }))
    const s = useProject.getState()
    expect(s.messages).toEqual([])
    expect(s.chatSnapshots[7].messages).toHaveLength(1)
  })

  it('addMessage → top-level активного (инвариант конверсии writers)', () => {
    useProject.getState().addMessage({ role: 'user', content: 'привет' })
    expect(useProject.getState().messages).toHaveLength(1)
    expect(useProject.getState().chatSnapshots).toEqual({})
  })

  it('setStreaming: true ставит таймер, false его сохраняет (как раньше)', () => {
    const st = useProject.getState()
    st.setStreaming(true)
    const started = useProject.getState().streamStartedAt
    expect(useProject.getState().isStreaming).toBe(true)
    expect(started).not.toBeNull()
    useProject.getState().setStreaming(false)
    expect(useProject.getState().isStreaming).toBe(false)
    expect(useProject.getState().streamStartedAt).toBe(started)
  })

  it('pushUserToChatSnapshot → снапшот: user+assistant, isStreaming, hasUnread=false', () => {
    useProject.getState().pushUserToChatSnapshot(5, 'вопрос')
    const snap = useProject.getState().chatSnapshots[5]
    expect(snap.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(snap.isStreaming).toBe(true)
    expect(snap.streamStartedAt).not.toBeNull()
    expect(snap.hasUnread).toBe(false)
    expect(useProject.getState().messages).toEqual([])
  })

  it('clearChatPendingCommand снимает pending фонового чата, активный цел', () => {
    useProject.setState({
      pendingCommand: { callId: 'a', command: 'ls' },
      chatSnapshots: { 5: { ...freshSnapshot(), pendingCommand: { callId: 'b', command: 'rm x' } } },
    })
    useProject.getState().clearChatPendingCommand(5)
    const s = useProject.getState()
    expect(s.chatSnapshots[5].pendingCommand).toBeNull()
    expect(s.pendingCommand?.callId).toBe('a')
  })

  it('clearChatPendingCommand без pending → no-op, снапшот не создаётся', () => {
    useProject.getState().clearChatPendingCommand(42)
    expect(useProject.getState().chatSnapshots).toEqual({})
  })

  it('helpMode: applyEventToChat активного чата пишет в его снапшот', () => {
    useProject.setState({
      helpMode: true,
      messages: [{ role: 'user', content: 'top' }],
      chatSnapshots: { 1: { ...freshSnapshot(), messages: [{ role: 'user', content: 'bg' }] } },
    })
    useProject.getState().applyEventToChat(1, { type: 'text', text: 'chunk' })
    const s = useProject.getState()
    const snapMsgs = s.chatSnapshots[1].messages
    expect(snapMsgs).toHaveLength(2)
    expect(snapMsgs[1].content).toBe('chunk')
    expect(s.chatSnapshots[1].hasUnread).toBe(true)
    // top-level не тронут — иначе события потеряются при leaveHelpMode.
    expect(s.messages).toEqual([{ role: 'user', content: 'top' }])
  })

  it('addUsage копит sessionUsage активного чата', () => {
    const st = useProject.getState()
    st.addUsage({ inputTokens: 100, outputTokens: 10 })
    st.addUsage({ inputTokens: 50, cacheReadTokens: 20 })
    const u = useProject.getState().sessionUsage
    expect(u.inputTokens).toBe(150)
    expect(u.outputTokens).toBe(10)
    expect(u.cachedInputTokens).toBe(20)
  })
})
