import { describe, it, expect, beforeEach, vi } from 'vitest'

// Характеризационные тесты жизненного цикла чата (switchChatSession): snapshot
// уходящего чата + restore входящего. Это сердце per-chat механики — раньше у
// него было 0 тестов, а именно «забыли поле в одной из рукописных копий bundle»
// порождало #8/#17. Тесты ЛОКИРУЮТ текущее поведение перед рефактором
// (вынос captureBundle/restoreBundle) — рефактор обязан их сохранить зелёными.

const listSpy = vi.fn(async () => [] as Array<{ role: string; content: string; createdAt?: number }>)
const setKeySpy = vi.fn(async () => {})
const listReviewsSpy = vi.fn(async () => [] as Array<{ id: number }>)
const windowStub = {
  api: {
    chats: { list: listSpy, append: vi.fn(async () => {}) },
    settings: { setKey: setKeySpy },
    chatSessions: { listReviews: listReviewsSpy },
  },
}
vi.stubGlobal('window', windowStub)

import { useProject } from '../../src/store/projectStore'
import type { SessionSnapshot } from '../../src/store/session-snapshot'
import type { ChatMessage } from '../../src/types/api'

// Различимый bundle со ВСЕМИ 7 полями заполненными — roundtrip обязан сохранить
// каждое. Если рефактор уронит хоть одно поле — тест покраснеет.
function distinctiveBundle(tag: string): SessionSnapshot {
  return {
    messages: [{ role: 'assistant', content: `msg-${tag}` }] as ChatMessage[],
    isStreaming: true,
    streamStartedAt: 1000,
    pendingWrites: [{ callId: `w-${tag}`, path: 'a.ts', before: '', after: 'x' }],
    pendingCommand: { callId: `c-${tag}`, command: `cmd-${tag}` },
    activity: [{ id: `act-${tag}`, kind: 'read', label: 'r', status: 'ok', timestamp: 1 }],
    sessionUsage: { inputTokens: 11, outputTokens: 22, cachedInputTokens: 3 },
    runningPlanStep: { planId: 1, stepId: 2, title: `plan-${tag}` },
    hasUnread: false,
  }
}

function resetStore() {
  useProject.setState({
    path: 'C:/proj',
    messages: [],
    isStreaming: false,
    pendingWrites: [],
    pendingCommand: null,
    activity: [],
    sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    runningPlanStep: null,
    activeChatId: null,
    chatSessions: [],
    chatSnapshots: {},
    touchedFiles: {},
    checkpointId: null,
    artifacts: [],
    openedReviewId: null,
  }, false)
}

beforeEach(() => {
  vi.stubGlobal('window', windowStub)
  resetStore()
  listSpy.mockClear()
  setKeySpy.mockClear()
  listReviewsSpy.mockClear()
})

describe('switchChatSession — snapshot уходящего чата', () => {
  it('переключение прочь снапшотит ВСЕ 7 полей активного чата в chatSnapshots[oldId]', async () => {
    const active = distinctiveBundle('A')
    useProject.setState({
      activeChatId: 1,
      messages: active.messages,
      isStreaming: active.isStreaming,
      pendingWrites: active.pendingWrites,
      pendingCommand: active.pendingCommand,
      activity: active.activity,
      sessionUsage: active.sessionUsage,
      runningPlanStep: active.runningPlanStep,
      sendOwners: { 11: { kind: 'chat', chatId: 1, projectPath: 'C:/proj' } },
    }, false)

    await useProject.getState().switchChatSession(2)

    const snap = useProject.getState().chatSnapshots[1]
    expect(snap).toBeDefined()
    expect(snap.messages).toBe(active.messages)
    expect(snap.isStreaming).toBe(true)
    expect(snap.pendingWrites).toBe(active.pendingWrites)
    expect(snap.pendingCommand).toBe(active.pendingCommand)
    expect(snap.activity).toBe(active.activity)
    expect(snap.sessionUsage).toBe(active.sessionUsage)
    expect(snap.runningPlanStep).toBe(active.runningPlanStep)
    // hasUnread снапшота уходящего чата всегда false (пользователь его только что смотрел).
    expect(snap.hasUnread).toBe(false)
  })

  it('switch на самого себя (id === activeChatId) не снапшотит', async () => {
    useProject.setState({ activeChatId: 5, messages: [{ role: 'user', content: 'x' }] as ChatMessage[] }, false)
    await useProject.getState().switchChatSession(5)
    expect(useProject.getState().chatSnapshots[5]).toBeUndefined()
  })
})

describe('switchChatSession — restore входящего чата', () => {
  it('переключение на чат СО снапшотом восстанавливает ВСЕ 7 полей в top-level', async () => {
    const saved = distinctiveBundle('B')
    useProject.setState({
      activeChatId: 1,
      messages: [],
      chatSnapshots: { 2: saved },
      sendOwners: { 22: { kind: 'chat', chatId: 2, projectPath: 'C:/proj' } },
    }, false)

    await useProject.getState().switchChatSession(2)

    const st = useProject.getState()
    expect(st.activeChatId).toBe(2)
    expect(st.messages).toBe(saved.messages)
    expect(st.isStreaming).toBe(saved.isStreaming)
    expect(st.pendingWrites).toBe(saved.pendingWrites)
    expect(st.pendingCommand).toBe(saved.pendingCommand)
    expect(st.activity).toBe(saved.activity)
    expect(st.sessionUsage).toBe(saved.sessionUsage)
    expect(st.runningPlanStep).toBe(saved.runningPlanStep)
    // Восстановленный чат убирается из карты снапшотов (он теперь активный).
    expect(st.chatSnapshots[2]).toBeUndefined()
  })

  it('переключение на чат БЕЗ снапшота даёт чистое состояние + гидратацию из БД', async () => {
    listSpy.mockResolvedValueOnce([{ role: 'user', content: 'из БД', createdAt: 7 }])
    useProject.setState({
      activeChatId: 1,
      messages: [{ role: 'user', content: 'старое' }] as ChatMessage[],
      isStreaming: true,
      pendingWrites: [{ callId: 'w', path: 'a', before: '', after: 'b' }],
    }, false)

    await useProject.getState().switchChatSession(9)
    await Promise.resolve(); await Promise.resolve()

    const st = useProject.getState()
    expect(st.activeChatId).toBe(9)
    // чистый сброс полей
    expect(st.isStreaming).toBe(false)
    expect(st.pendingWrites).toEqual([])
    expect(st.pendingCommand).toBeNull()
    // гидратация истории из БД
    expect(listSpy).toHaveBeenCalledWith(9)
    expect(st.messages).toEqual([{ role: 'user', content: 'из БД', createdAt: 7 }])
  })

  it('roundtrip: A→B→A возвращает исходный bundle чата A без потерь', async () => {
    const a = distinctiveBundle('roundtrip')
    useProject.setState({
      activeChatId: 1,
      messages: a.messages,
      isStreaming: a.isStreaming,
      pendingWrites: a.pendingWrites,
      pendingCommand: a.pendingCommand,
      activity: a.activity,
      sessionUsage: a.sessionUsage,
      runningPlanStep: a.runningPlanStep,
      chatSnapshots: { 2: distinctiveBundle('B') },
    }, false)

    await useProject.getState().switchChatSession(2)  // leave 1, enter 2
    await useProject.getState().switchChatSession(1)  // leave 2, re-enter 1

    const st = useProject.getState()
    expect(st.activeChatId).toBe(1)
    expect(st.messages).toBe(a.messages)
    expect(st.pendingWrites).toBe(a.pendingWrites)
    expect(st.pendingCommand).toBe(a.pendingCommand)
    expect(st.activity).toBe(a.activity)
    expect(st.sessionUsage).toBe(a.sessionUsage)
    expect(st.runningPlanStep).toBe(a.runningPlanStep)
  })
})
