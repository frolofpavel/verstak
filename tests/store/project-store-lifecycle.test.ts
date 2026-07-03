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

// Различимый bundle со ВСЕМИ полями заполненными — roundtrip обязан сохранить
// каждое. Если рефактор уронит хоть одно поле — тест покраснеет. checkpointId/
// preflights/subagentRuns добавлены в bundle (finding 2/3 — per-chat preserve).
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
    checkpointId: 500, checkpointMessageId: 501,
    preflights: [{ callId: `pf-${tag}`, summary: `s-${tag}`, affectedZones: [], risk: 'low', riskReason: '', verifyAfter: [], outOfScope: [] }],
    subagentRuns: [{ callId: `sr-${tag}`, label: `l-${tag}`, task: 't', status: 'running' }],
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
  it('переключение прочь снапшотит ВСЕ поля активного чата в chatSnapshots[oldId]', async () => {
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
      checkpointId: active.checkpointId,
      preflights: active.preflights,
      subagentRuns: active.subagentRuns,
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
    // finding 2/3: checkpointId/preflights/subagentRuns теперь тоже в снапшоте.
    expect(snap.checkpointId).toBe(active.checkpointId)
    expect(snap.preflights).toBe(active.preflights)
    expect(snap.subagentRuns).toBe(active.subagentRuns)
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
  it('переключение на чат СО снапшотом восстанавливает ВСЕ поля в top-level', async () => {
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
    // finding 2/3: checkpointId/preflights/subagentRuns восстанавливаются per-chat.
    expect(st.checkpointId).toBe(saved.checkpointId)
    expect(st.preflights).toBe(saved.preflights)
    expect(st.subagentRuns).toBe(saved.subagentRuns)
    // Восстановленный чат убирается из карты снапшотов (он теперь активный).
    expect(st.chatSnapshots[2]).toBeUndefined()
  })

  // finding 2/3 (ревью Verstak 23.06): checkpointId/preflights/subagentRuns теперь
  // per-chat в bundle — НЕ утекают от уходящего чата (восстанавливается СВОЁ чата 2),
  // а НЕ-bundle поля (touchedFiles/artifacts/previewArtifactId) по-прежнему сбрасываются.
  it('restore: bundle-поля = СВОИ чата 2, не утекают от уходящего; не-bundle сброшены', async () => {
    const saved = distinctiveBundle('B')  // checkpointId=500, pf-B, sr-B
    useProject.setState({
      activeChatId: 1,
      chatSnapshots: { 2: saved },
      // состояние УХОДЯЩЕГО чата 1 — НЕ должно протечь в чат 2:
      touchedFiles: { 'a.ts': { before: '', after: 'x' } },
      checkpointId: 999,
      preflights: [{ callId: 'pf-A', summary: 's', affectedZones: [], risk: 'low', riskReason: '', verifyAfter: [], outOfScope: [] }],
      subagentRuns: [{ callId: 'sr-A', label: 'l', task: 't', status: 'running' }],
      artifacts: [{ id: 'art-A', kind: 'html', title: 't', content: 'c', createdAt: 1 }],
      previewArtifactId: 'art-A',
    } as never, false)

    await useProject.getState().switchChatSession(2)

    const st = useProject.getState()
    expect(st.activeChatId).toBe(2)
    // bundle-поля = СВОИ чата 2 (не 999/pf-A/sr-A уходящего):
    expect(st.checkpointId).toBe(500)
    expect(st.preflights).toBe(saved.preflights)
    expect(st.subagentRuns).toBe(saved.subagentRuns)
    // не-bundle поля сброшены:
    expect(st.touchedFiles).toEqual({})
    expect(st.artifacts).toEqual([])
    expect(st.previewArtifactId).toBeNull()
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

  // finding 3: чат БЕЗ снапшота (else-ветка) = чистый старт — preflights/subagentRuns
  // уходящего чата не утекают (фолбэк на fresh-значения, не bundle).
  it('switch на чат без снапшота даёт пустые preflights/subagentRuns (не утекают от уходящего)', async () => {
    useProject.setState({
      activeChatId: 1,
      preflights: [{ callId: 'p-A', summary: 's', affectedZones: ['z'], risk: 'low', riskReason: 'r', verifyAfter: [], outOfScope: [] }],
      subagentRuns: [{ callId: 'sr-A', label: 'l', task: 't', status: 'running' }],
    } as never, false)

    await useProject.getState().switchChatSession(9)

    const st = useProject.getState()
    expect(st.preflights).toEqual([])
    expect(st.subagentRuns).toEqual([])
  })

  it('roundtrip: A→B→A возвращает исходный bundle чата A без потерь (вкл. checkpointId/preflights)', async () => {
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
      checkpointId: 111,           // distinct от B (500) — проверяем, что вернётся СВОЙ
      preflights: a.preflights,
      subagentRuns: a.subagentRuns,
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
    // finding 2/3: checkpointId/preflights/subagentRuns чата A пережили roundtrip.
    expect(st.checkpointId).toBe(111)
    expect(st.preflights).toBe(a.preflights)
    expect(st.subagentRuns).toBe(a.subagentRuns)
  })
})

// 5.3 (review P0): closeProject сбрасывал лишь часть полей → sendOwners/helpMode/
// sessions/snapshots/preflights/subagentRuns/reviews утекали в следующий открытый
// проект. Нет проекта = чистый лист.
describe('closeProject — полный сброс эфемерного состояния (5.3)', () => {
  it('очищает sendOwners/helpMode/sessions/snapshots/preflights/subagentRuns/reviews', () => {
    useProject.setState({
      path: 'C:/proj',
      sendOwners: { 1: { kind: 'chat', chatId: 5 } },
      helpMode: true,
      sessions: { 'C:/proj': distinctiveBundle('S') },
      chatSnapshots: { 2: distinctiveBundle('C') },
      subagentRuns: [{ callId: 'sr1', label: 'l', task: 't', status: 'running' }],
      reviews: { 9: { reviewChatId: 9, parentChatId: 1, providerId: 'grok', model: null, content: '', status: 'streaming', createdAt: 1, noteCount: -1, findings: [], accepted: [] } },
      openedReviewId: 9,
      activeChatId: 3,
      pendingWrites: [{ callId: 'w', path: 'a', before: '', after: 'b' }],
    }, false)
    useProject.getState().pushPreflight({ callId: 'p1', summary: 's', affectedZones: ['z'], risk: 'low', riskReason: 'r', verifyAfter: [], outOfScope: [] })

    useProject.getState().closeProject()

    const st = useProject.getState()
    expect(st.path).toBeNull()
    expect(st.sendOwners).toEqual({})
    expect(st.helpMode).toBe(false)
    expect(st.sessions).toEqual({})
    expect(st.chatSnapshots).toEqual({})
    expect(st.preflights).toEqual([])
    expect(st.subagentRuns).toEqual([])
    expect(st.reviews).toEqual({})
    expect(st.openedReviewId).toBeNull()
    expect(st.activeChatId).toBeNull()
    expect(st.pendingWrites).toEqual([])
  })
})
