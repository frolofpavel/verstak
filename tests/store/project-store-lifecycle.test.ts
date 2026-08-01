import { active, seedActive } from './_active-bundle'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Характеризационные тесты жизненного цикла чата (switchChatSession): snapshot
// уходящего чата + restore входящего. Это сердце per-chat механики — раньше у
// него было 0 тестов, а именно «забыли поле в одной из рукописных копий bundle»
// порождало #8/#17. Тесты ЛОКИРУЮТ текущее поведение перед рефактором
// (вынос captureBundle/restoreBundle) — рефактор обязан их сохранить зелёными.

// Илья (reapply-2.0.7): гидратация чата перешла на оконный chats.listWindow
// (последние 50 + догрузка старых) — мок повторяет его форму ответа.
const listSpy = vi.fn(async () => ({
  messages: [] as Array<{ role: string; content: string; createdAt?: number }>,
  totalCount: 0,
  hasMoreBefore: false,
}))
const setKeySpy = vi.fn(async () => {})
const getKeySpy = vi.fn(async (_k: string) => null as string | null)
const listReviewsSpy = vi.fn(async () => [] as Array<{ id: number }>)
const createSpy = vi.fn(async (_path: string, opts: { title?: string; providerId?: string | null; model?: string | null }) => ({ id: 100, title: opts.title ?? 'new', providerId: opts.providerId ?? null, model: opts.model ?? null }))
const sessionsListSpy = vi.fn(async () => [] as Array<{ id: number }>)
const setModelSpy = vi.fn(async () => {})
const windowStub = {
  api: {
    chats: { listWindow: listSpy, list: vi.fn(async () => []), append: vi.fn(async () => {}) },
    settings: { setKey: setKeySpy, getKey: getKeySpy },
    chatSessions: { listReviews: listReviewsSpy, create: createSpy, list: sessionsListSpy, setModel: setModelSpy, getOrCreateHelp: vi.fn(async () => ({ id: 999 })) },
    skills: { recordUse: vi.fn(async () => {}) },
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
    // §10 хвост: карточка согласования переехала в bundle чата — значит она тоже
    // обязана переживать roundtrip перехода между чатами.
    pendingPlan: { callId: `pc-${tag}`, planId: 1, title: `plan-card-${tag}`, stepCount: 2 },
    // §7.2: карточка созданного плана — тоже состояние чата, обязана переживать
    // переход между чатами вместе с остальным bundle.
    planCards: [{ planId: 1, title: `plan-${tag}`, stepCount: 2, awaitingApproval: false }],
    activity: [{ id: `act-${tag}`, kind: 'read', label: 'r', status: 'ok', timestamp: 1 }],
    agentProgress: [{ id: `progress-${tag}`, phase: 'tool', title: `progress-${tag}`, status: 'running', timestamp: 1 }],
    sessionUsage: { inputTokens: 11, outputTokens: 22, cachedInputTokens: 3 },
    runningPlanStep: { planId: 1, stepId: 2, title: `plan-${tag}` },
    checkpointId: 500, checkpointMessageId: 501,
    preflights: [{ callId: `pf-${tag}`, summary: `s-${tag}`, affectedZones: [], risk: 'low', riskReason: '', verifyAfter: [], outOfScope: [] }],
    subagentRuns: [{ callId: `sr-${tag}`, label: `l-${tag}`, task: 't', status: 'running' }],
    materialsNotes: [{ source: 'folder', line: `materials-${tag}` }],
    hasUnread: false,
  }
}

function resetStore() {
  useProject.setState({
    path: 'C:/proj',
    activeChatId: null,
    chatSessions: [],
    chats: {},
    touchedFiles: {},
    artifacts: [],
    openedReviewId: null,
    // Изоляция: sendOwners/chatLaneGenerations/helpMode не сбрасывались и текли
    // между тестами (leaked laneGeneration ломал hasInflightChatSend в порядке файла).
    sendOwners: {},
    chatLaneGenerations: {},
    helpMode: false,
  }, false)
}

beforeEach(() => {
  vi.stubGlobal('window', windowStub)
  resetStore()
  listSpy.mockClear()
  setKeySpy.mockClear()
  getKeySpy.mockClear()
  listReviewsSpy.mockClear()
  createSpy.mockClear()
  sessionsListSpy.mockClear()
  setModelSpy.mockClear()
})

describe('switchChatSession — snapshot уходящего чата', () => {
  it('переключение прочь снапшотит ВСЕ поля активного чата в chats[oldId]', async () => {
    const active = distinctiveBundle('A')
    useProject.setState({
      activeChatId: 1,
      chats: { 1: { ...active, chatId: 1, hasUnread: false } },
      sendOwners: { 11: { kind: 'chat', chatId: 1, projectPath: 'C:/proj' } },
    }, false)

    await useProject.getState().switchChatSession(2)

    const snap = useProject.getState().chats[1]
    expect(snap).toBeDefined()
    expect(snap.messages).toBe(active.messages)
    expect(snap.isStreaming).toBe(true)
    expect(snap.pendingWrites).toBe(active.pendingWrites)
    expect(snap.pendingCommand).toBe(active.pendingCommand)
    expect(snap.activity).toBe(active.activity)
    expect(snap.agentProgress).toBe(active.agentProgress)
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
    useProject.setState({ activeChatId: 5 }, false); seedActive(useProject, { messages: [{ role: 'user', content: 'x' }] as ChatMessage[]  })
    await useProject.getState().switchChatSession(5)
    // 4.4: переключение на самого себя ничего не меняет — состояние чата на месте.
    const st5 = useProject.getState()
    expect(st5.activeChatId).toBe(5)
    expect(st5.chats[5].messages).toEqual([{ role: 'user', content: 'x' }])
  })
})

describe('switchChatSession — restore входящего чата', () => {
  it('переключение на чат СО снапшотом восстанавливает ВСЕ поля в top-level', async () => {
    const saved = distinctiveBundle('B')
    useProject.setState({
      activeChatId: 1,
      chats: { 2: saved },
      sendOwners: { 22: { kind: 'chat', chatId: 2, projectPath: 'C:/proj' } },
    }, false)

    await useProject.getState().switchChatSession(2)

    const st = useProject.getState()
    expect(st.activeChatId).toBe(2)
    expect(active(st).messages).toBe(saved.messages)
    expect(active(st).isStreaming).toBe(saved.isStreaming)
    expect(active(st).pendingWrites).toBe(saved.pendingWrites)
    expect(active(st).pendingCommand).toBe(saved.pendingCommand)
    expect(active(st).activity).toBe(saved.activity)
    expect(active(st).agentProgress).toBe(saved.agentProgress)
    expect(active(st).sessionUsage).toBe(saved.sessionUsage)
    expect(active(st).runningPlanStep).toBe(saved.runningPlanStep)
    // finding 2/3: checkpointId/preflights/subagentRuns восстанавливаются per-chat.
    expect(active(st).checkpointId).toBe(saved.checkpointId)
    expect(active(st).preflights).toBe(saved.preflights)
    expect(active(st).subagentRuns).toBe(saved.subagentRuns)
    // Восстановленный чат убирается из карты снапшотов (он теперь активный).
    // 4.4: вошедший чат остаётся в chats — это и есть единственное хранилище.
    expect(st.chats[2], 'состояние вошедшего чата обязано быть на месте').toBeDefined()
    expect(st.chats[2].hasUnread).toBe(false)
  })

  // finding 2/3 (ревью Verstak 23.06): checkpointId/preflights/subagentRuns теперь
  // per-chat в bundle — НЕ утекают от уходящего чата (восстанавливается СВОЁ чата 2),
  // а НЕ-bundle поля (touchedFiles/artifacts/previewArtifactId) по-прежнему сбрасываются.
  it('restore: bundle-поля = СВОИ чата 2, не утекают от уходящего; не-bundle сброшены', async () => {
    const saved = distinctiveBundle('B')  // checkpointId=500, pf-B, sr-B
    useProject.setState({
      activeChatId: 1,
      chats: { 2: saved },
      // состояние УХОДЯЩЕГО чата 1 — НЕ должно протечь в чат 2:
      touchedFiles: { 'a.ts': { before: '', after: 'x' } },
      artifacts: [{ id: 'art-A', kind: 'html', title: 't', content: 'c', createdAt: 1 }],
      previewArtifactId: 'art-A',
    } as never, false)

    await useProject.getState().switchChatSession(2)

    const st = useProject.getState()
    expect(st.activeChatId).toBe(2)
    // bundle-поля = СВОИ чата 2 (не 999/pf-A/sr-A уходящего):
    expect(active(st).checkpointId).toBe(500)
    expect(active(st).preflights).toBe(saved.preflights)
    expect(active(st).subagentRuns).toBe(saved.subagentRuns)
    // не-bundle поля сброшены:
    expect(st.touchedFiles).toEqual({})
    expect(st.artifacts).toEqual([])
    expect(st.previewArtifactId).toBeNull()
  })

  it('переключение на чат БЕЗ снапшота даёт чистое состояние + гидратацию из БД', async () => {
    listSpy.mockResolvedValueOnce({ messages: [{ role: 'user', content: 'из БД', createdAt: 7 }], totalCount: 1, hasMoreBefore: false })
    useProject.setState({
      activeChatId: 1,
    }, false)

    await useProject.getState().switchChatSession(9)
    await Promise.resolve(); await Promise.resolve()

    const st = useProject.getState()
    expect(st.activeChatId).toBe(9)
    // чистый сброс полей
    expect(active(st).isStreaming).toBe(false)
    expect(active(st).pendingWrites).toEqual([])
    expect(active(st).pendingCommand).toBeNull()
    // гидратация истории из БД
    expect(listSpy).toHaveBeenCalledWith(9, { limit: 50 })
    expect(active(st).messages).toEqual([{ role: 'user', content: 'из БД', createdAt: 7 }])
  })

  // finding 3: чат БЕЗ снапшота (else-ветка) = чистый старт — preflights/subagentRuns
  // уходящего чата не утекают (фолбэк на fresh-значения, не bundle).
  it('switch на чат без снапшота даёт пустые preflights/subagentRuns (не утекают от уходящего)', async () => {
    useProject.setState({
      activeChatId: 1,
    } as never, false)

    await useProject.getState().switchChatSession(9)

    const st = useProject.getState()
    expect(active(st).preflights).toEqual([])
    expect(active(st).subagentRuns).toEqual([])
  })

  it('roundtrip: A→B→A возвращает исходный bundle чата A без потерь (вкл. checkpointId/preflights)', async () => {
    const a = distinctiveBundle('roundtrip')
    useProject.setState({
      activeChatId: 1,
      chats: {
        // checkpointId чата 1 намеренно отличается от B (500) — проверяем, что после
        // A→B→A вернётся СВОЙ, а не соседский.
        1: { ...a, chatId: 1, hasUnread: false, checkpointId: 111 },
        2: distinctiveBundle('B'),
      },
    }, false)

    await useProject.getState().switchChatSession(2)  // leave 1, enter 2
    await useProject.getState().switchChatSession(1)  // leave 2, re-enter 1

    const st = useProject.getState()
    expect(st.activeChatId).toBe(1)
    expect(active(st).messages).toBe(a.messages)
    expect(active(st).pendingWrites).toBe(a.pendingWrites)
    expect(active(st).pendingCommand).toBe(a.pendingCommand)
    expect(active(st).activity).toBe(a.activity)
    expect(active(st).agentProgress).toBe(a.agentProgress)
    expect(active(st).sessionUsage).toBe(a.sessionUsage)
    expect(active(st).runningPlanStep).toBe(a.runningPlanStep)
    // finding 2/3: checkpointId/preflights/subagentRuns чата A пережили roundtrip.
    expect(active(st).checkpointId).toBe(111)
    expect(active(st).preflights).toBe(a.preflights)
    expect(active(st).subagentRuns).toBe(a.subagentRuns)
  })
})

// #3 (1.9.8): newChatSession дублирует leave-двухшаг switchChatSession
// (backgroundActiveChat + keepStreamingOnlyWhenInflight). Раньше 0 тестов — drift
// между двумя копиями и есть race-класс. Локируем поведение перед выносом leaveChat.
describe('newChatSession — snapshot уходящего чата (leave-паритет со switch)', () => {
  it('снапшотит уходящий активный чат; стрим сохраняется когда send in-flight', async () => {
    const active = distinctiveBundle('N')  // isStreaming: true
    useProject.setState({
      activeChatId: 1,
      chats: { 1: { ...active, chatId: 1, hasUnread: false } },
      sendOwners: { 11: { kind: 'chat', chatId: 1, projectPath: 'C:/proj' } },  // in-flight
    }, false)

    await useProject.getState().newChatSession('new one')

    const st = useProject.getState()
    expect(st.activeChatId).toBe(100)  // created.id из createSpy
    const snap = st.chats[1]
    expect(snap).toBeDefined()
    expect(snap.messages).toBe(active.messages)
    expect(snap.isStreaming).toBe(true)   // in-flight → живой стрим уходящего чата сохранён
    expect(snap.pendingCommand).toBe(active.pendingCommand)
    // те же per-chat bundle-поля, что и у switch (drift-guard):
    expect(snap.checkpointId).toBe(active.checkpointId)
    expect(snap.preflights).toBe(active.preflights)
    expect(snap.subagentRuns).toBe(active.subagentRuns)
  })

  // 2.0.1 bug: switchChatSession сбрасывал openedReviewId/previewArtifactId, а
  // newChatSession — нет → состояние прошлого чата протекало в новый.
  it('новый чат сбрасывает openedReviewId/previewArtifactId/sessionUsage (не тащит из прошлого)', async () => {
    useProject.setState({
      activeChatId: 1, openedReviewId: 42, previewArtifactId: 'art-old',
    }, false)
    await useProject.getState().newChatSession('new one')
    const st = useProject.getState()
    expect(st.openedReviewId).toBeNull()
    expect(st.previewArtifactId).toBeNull()
    expect(active(st).sessionUsage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 })
  })

  it('гасит isStreaming уходящего чата когда send НЕ in-flight (анти-фантом стрима)', async () => {
    useProject.setState({
      activeChatId: 1,
      chats: { 1: { ...distinctiveBundle('phantom'), chatId: 1, hasUnread: false } },  // isStreaming: true
      sendOwners: {},  // нет активного send → не in-flight
    }, false)

    await useProject.getState().newChatSession()

    const snap = useProject.getState().chats[1]
    expect(snap).toBeDefined()
    expect(snap.isStreaming).toBe(false)      // висячий флаг снят
    expect(snap.streamStartedAt).toBeNull()
  })

  // VSK-FIX (дрейф найден в срезе 3 фазы 5): newChatSession не сбрасывал
  // chatHasMoreBefore/chatTotalCount — кнопка «загрузить старое» показывалась
  // в пустом новом чате, а счётчик сообщений врал про историю уходящего чата.
  it('новый чат сбрасывает пагинацию истории уходящего чата (chatHasMoreBefore/chatTotalCount)', async () => {
    useProject.setState({
      activeChatId: 1,
      chatHasMoreBefore: true,
      chatTotalCount: 137,
    }, false)

    await useProject.getState().newChatSession('new one')

    const st = useProject.getState()
    expect(st.chatHasMoreBefore).toBe(false)
    expect(st.chatTotalCount).toBe(0)
  })
})

describe('switchChatSession — provider/model preservation (#3)', () => {
  it('пишет provider входящего чата в настройки (не сбрасывается на дефолт)', async () => {
    useProject.setState({
      activeChatId: 1,
      chatSessions: [{ id: 2, providerId: 'claude', model: null }],
    } as never, false)

    await useProject.getState().switchChatSession(2)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    expect(setKeySpy).toHaveBeenCalledWith('provider', 'claude')
  })

  it('не-inflight стрим гасится и при switch (паритет с newChatSession)', async () => {
    useProject.setState({
      activeChatId: 1,
      chats: { 1: { ...distinctiveBundle('switch'), chatId: 1, hasUnread: false } },  // isStreaming: true
      sendOwners: {},  // не in-flight
    }, false)

    await useProject.getState().switchChatSession(2)

    const snap = useProject.getState().chats[1]
    expect(snap.isStreaming).toBe(false)
    expect(snap.streamStartedAt).toBeNull()
  })
})

// Ревью #3 нашло пред-существующий разрыв: openHelpChat снапшотил активный чат
// через captureBundle БЕЗ keepStreamingOnlyWhenInflight (в отличие от switch/new) →
// фантомный стрим-флаг уносился в снапшот и держал залипший индикатор фонового
// чата в списке, пока пользователь в справке. Приведено к паритету.
describe('openHelpChat — реконсиляция стрим-флага (паритет со switch/new, ревью #3)', () => {
  it('фантомный стрим (send НЕ in-flight) не уносится в снапшот активного чата', async () => {
    useProject.setState({
      activeChatId: 1,
      sendOwners: {},  // не in-flight → фантом
    }, false)

    await useProject.getState().openHelpChat()

    const snap = useProject.getState().chats[1]
    expect(snap).toBeDefined()
    expect(snap.isStreaming).toBe(false)
    expect(snap.streamStartedAt).toBeNull()
  })

  it('живой стрим (in-flight) сохраняется в снапшоте при уходе в справку', async () => {
    useProject.setState({
      activeChatId: 1,
      chats: { 1: { ...distinctiveBundle('help'), chatId: 1, hasUnread: false } },  // isStreaming, streamStartedAt: 1000
      sendOwners: { 11: { kind: 'chat', chatId: 1, projectPath: 'C:/proj' } },  // in-flight
    }, false)

    await useProject.getState().openHelpChat()

    const snap = useProject.getState().chats[1]
    expect(snap.isStreaming).toBe(true)
    expect(snap.streamStartedAt).toBe(1000)
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
      chats: { 2: distinctiveBundle('C') },
      reviews: { 9: { reviewChatId: 9, parentChatId: 1, providerId: 'grok', model: null, content: '', status: 'streaming', createdAt: 1, noteCount: -1, findings: [], accepted: [] } },
      openedReviewId: 9,
      activeChatId: 3,
    }, false)
    useProject.getState().pushPreflight({ callId: 'p1', summary: 's', affectedZones: ['z'], risk: 'low', riskReason: 'r', verifyAfter: [], outOfScope: [] })

    useProject.getState().closeProject()

    const st = useProject.getState()
    expect(st.path).toBeNull()
    expect(st.sendOwners).toEqual({})
    expect(st.helpMode).toBe(false)
    expect(st.sessions).toEqual({})
    expect(st.chats).toEqual({})
    expect(active(st).preflights).toEqual([])
    expect(active(st).subagentRuns).toEqual([])
    expect(st.reviews).toEqual({})
    expect(st.openedReviewId).toBeNull()
    expect(st.activeChatId).toBeNull()
    expect(active(st).pendingWrites).toEqual([])
  })
})
