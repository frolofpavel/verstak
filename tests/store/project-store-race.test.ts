// Состязательные (race) тесты projectStore — Фаза 2 §2.1 плана качества (срез 4).
// Проверяем поведение при быстрых переключениях чатов во время активного стрима и
// при ответах async-операций (history/reviews/settings) в «обратном» порядке.
//
// Большинство сценариев — characterization / lock-in: guard'ы уже есть
// (switchChatSessionToken для history, activeChatId-проверка для reviews,
// lane-generation для send'ов, leaveChat-снапшот для стрима). Тесты фиксируют
// это поведение, чтобы будущая LLM-правка не сломала его молча.
//
// Сценарий 4 (поздняя запись settings) на момент написания был КРАСНЫМ —
// блок записи provider/model НЕ имел token-guard'а, который есть у history-загрузки
// → стейл-switch дописывал модель поверх нового чата. Добавлен guard (мин. фикс).
import { describe, it, expect, beforeEach, vi } from 'vitest'

const appendSpy = vi.fn(async () => {})
const agentRunsListSpy = vi.fn(async () => [] as Array<{ runId: string }>)
const baseWindow = {
  api: {
    // Илья (reapply-2.0.7): гидратация перешла на оконный listWindow — форма ответа
    // {messages,totalCount,hasMoreBefore}. Смысл теста прежний: стейл-история отбрасывается.
    chats: {
      append: appendSpy,
      list: vi.fn(async () => []),
      listWindow: vi.fn(async () => ({ messages: [], totalCount: 0, hasMoreBefore: false }))
    },
    agentRuns: { list: agentRunsListSpy },
    settings: { getKey: vi.fn(async () => null), setKey: vi.fn(async () => {}) },
    chatSessions: {
      list: vi.fn(async () => []),
      listReviews: vi.fn(async () => []),
      setModel: vi.fn(async () => {}),
      create: vi.fn(async () => ({ id: 99 }))
    }
  }
}
vi.stubGlobal('window', baseWindow)

import { useProject } from '../../src/store/projectStore'
import type { ChatMessage } from '../../src/types/api'

/** Управляемый промис — резолвим вручную, чтобы навязать порядок гонки. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function resetStore() {
  useProject.setState({
    path: 'C:/proj',
    messages: [],
    isStreaming: false,
    streamStartedAt: null,
    pendingWrites: [],
    pendingCommand: null,
    activity: [],
    agentProgress: [],
    preflights: [],
    touchedFiles: {},
    activeChatId: null,
    chatSnapshots: {},
    chatSessions: [],
    sendOwners: {},
    chatLaneGenerations: {},
    reviews: {},
    openedReviewId: null,
    sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  }, false)
}

beforeEach(() => {
  vi.stubGlobal('window', baseWindow)
  resetStore()
  vi.clearAllMocks()
  agentRunsListSpy.mockResolvedValue([])
})

// ─── Сценарий 1: A→B, history приходит в обратном порядке ────────────────────
describe('Сц.1 — стейл-загрузка history отбрасывается при более новом switch', () => {
  it('history чата A (устаревшего) не затирает сообщения активного чата B', async () => {
    type Win = { messages: Array<{ id: number; role: string; content: string }>; totalCount: number; hasMoreBefore: boolean }
    const dA = deferred<Win>()
    const dB = deferred<Win>()
    baseWindow.api.chats.listWindow = vi.fn((id: number) => (id === 1 ? dA.promise : dB.promise)) as never
    useProject.setState({ chatSessions: [{ id: 1 }, { id: 2 }] as never }, false)

    await useProject.getState().switchChatSession(1) // active=1, ждёт dA
    await useProject.getState().switchChatSession(2) // active=2, ждёт dB, token++

    // Обратный порядок: сначала резолвим B (актуальный), потом A (устаревший).
    dB.resolve({ messages: [{ id: 20, role: 'assistant', content: 'ответ чата B' }], totalCount: 1, hasMoreBefore: false })
    await Promise.resolve()
    dA.resolve({ messages: [{ id: 10, role: 'user', content: 'история чата A' }], totalCount: 1, hasMoreBefore: false })
    await Promise.resolve(); await Promise.resolve()

    const st = useProject.getState()
    expect(st.activeChatId).toBe(2)
    // Активный чат B — его сообщения; стейл-history A отброшена guard'ом (токен).
    expect(st.messages).toEqual([{ role: 'assistant', content: 'ответ чата B', thinking: undefined, appliedSkills: undefined, createdAt: undefined, dbId: 20 }])
  })
})

// ─── Сценарий 2: переключение во время активного стрима ──────────────────────
describe('Сц.2 — switch во время стрима снапшотит уходящий чат (не теряет ответ)', () => {
  it('уходящий стримящий чат сохраняется в chatSnapshots с частичным ответом', async () => {
    // chat 2 имеет снапшот → restore-путь (без async-гидратации).
    useProject.setState({
      activeChatId: 1,
      isStreaming: true,
      streamStartedAt: 1000,
      messages: [
        { role: 'user', content: 'вопрос' },
        { role: 'assistant', content: 'частичный ответ' }
      ] as ChatMessage[],
      chatSessions: [{ id: 1 }, { id: 2 }] as never,
      sendOwners: { 7: { kind: 'chat', chatId: 1, projectPath: 'C:/proj', laneGeneration: 1 } } as never,
      chatLaneGenerations: { 'chat:1': 1 } as never,
      chatSnapshots: {
        2: { messages: [{ role: 'user', content: 'старое B' }], isStreaming: false, streamStartedAt: null, pendingWrites: [], pendingCommand: null, activity: [], agentProgress: [], sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, runningPlanStep: null, hasUnread: false, checkpointId: null, checkpointMessageId: null, preflights: [], subagentRuns: [] }
      } as never
    }, false)

    await useProject.getState().switchChatSession(2)

    const st = useProject.getState()
    expect(st.activeChatId).toBe(2)
    // Уходящий чат 1 снапшотнут со стримом и частичным ответом (не потерян).
    expect(st.chatSnapshots[1]).toBeDefined()
    expect(st.chatSnapshots[1].isStreaming).toBe(true)
    expect(st.chatSnapshots[1].messages).toEqual([
      { role: 'user', content: 'вопрос' },
      { role: 'assistant', content: 'частичный ответ' }
    ])
    // Активный чат B восстановлен из снапшота.
    expect(st.messages).toEqual([{ role: 'user', content: 'старое B' }])
  })
})

// ─── Сценарий 3: поздний refreshReviewsFor от старого чата ────────────────────
describe('Сц.3 — стейл refreshReviewsFor старого чата не инжектит ревью в новый', () => {
  it('ревью чата A, пришедшие после switch на B, отбрасываются', async () => {
    const dRev = deferred<Array<{ id: number; providerId: string; model: string | null; createdAt: number }>>()
    baseWindow.api.chatSessions.listReviews = vi.fn(() => dRev.promise) as never
    useProject.setState({ activeChatId: 2 }, false) // пользователь уже на чате B

    const p = useProject.getState().refreshReviewsFor(1) // запрос по старому чату A
    dRev.resolve([{ id: 55, providerId: 'grok', model: null, createdAt: 1 }])
    await p

    // active=2 ≠ parentChatId=1 → guard отбросил, ревью старого чата не добавлены.
    expect(useProject.getState().reviews[55]).toBeUndefined()
    expect(Object.keys(useProject.getState().reviews)).toEqual([])
  })
})

// ─── Сценарий 4: поздняя запись provider/model settings после нового switch ───
describe('Сц.4 — стейл-запись settings не дописывает модель поверх нового чата', () => {
  it('модель устаревшего switch не пишется после более нового switch (token-guard)', async () => {
    const dP1 = deferred() // setKey('provider', ...) чата 1
    const dP2 = deferred() // setKey('provider', ...) чата 2
    const setKeySpy = vi.fn((key: string) => {
      if (key === 'provider') {
        // Первый вызов — от switch(1), второй — от switch(2).
        return setKeySpy.mock.calls.filter(c => c[0] === 'provider').length === 1 ? dP1.promise : dP2.promise
      }
      return Promise.resolve()
    })
    const setModelSpy = vi.fn(async (_id: number, _provider: string | null, _model: string | null) => {})
    baseWindow.api.settings.setKey = setKeySpy as never
    baseWindow.api.chatSessions.setModel = setModelSpy as never

    // Оба чата — со снапшотами (синхронный restore, изолируем гонку settings).
    const snap = (msg: string) => ({ messages: [{ role: 'user', content: msg }], isStreaming: false, streamStartedAt: null, pendingWrites: [], pendingCommand: null, activity: [], agentProgress: [], sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, runningPlanStep: null, hasUnread: false, checkpointId: null, checkpointMessageId: null, preflights: [], subagentRuns: [] })
    useProject.setState({
      chatSessions: [{ id: 1, providerId: 'openai', model: 'gpt-x' }, { id: 2, providerId: 'grok', model: 'grok-x' }] as never,
      chatSnapshots: { 1: snap('A'), 2: snap('B') } as never
    }, false)

    await useProject.getState().switchChatSession(1) // provider openai (ждёт dP1)
    await useProject.getState().switchChatSession(2) // provider grok (ждёт dP2), token++

    // Обратный порядок: сначала завершается новый switch(2), потом стейл switch(1).
    dP2.resolve(); await Promise.resolve(); await Promise.resolve()
    dP1.resolve(); await Promise.resolve(); await Promise.resolve()

    // Модель активного чата 2 записана; модель стейл-чата 1 — НЕ должна (guard).
    const setModelChatIds = setModelSpy.mock.calls.map(c => c[0])
    expect(setModelChatIds).toContain(2)
    expect(setModelChatIds).not.toContain(1)
  })
})

// ─── Сценарий 5: два одновременных send — одна lane vs разные lanes ───────────
describe('Сц.5 — конкурентные send: одна lane инвалидирует стейл, разные — сосуществуют', () => {
  it('второй send в тот же чат делает первого стейл; send другого чата жив', () => {
    const s = useProject.getState()
    s.registerSendOwner(1, { kind: 'chat', chatId: 10 })
    s.registerSendOwner(2, { kind: 'chat', chatId: 20 }) // другая lane
    s.registerSendOwner(3, { kind: 'chat', chatId: 10 }) // та же lane, что и send 1 → стейл

    expect(useProject.getState().lookupSendOwner(1)).toBeNull()              // стейл
    expect(useProject.getState().lookupSendOwner(3)).toMatchObject({ chatId: 10, laneGeneration: 2 })
    expect(useProject.getState().lookupSendOwner(2)).toMatchObject({ chatId: 20 }) // жив
  })
})

// ─── Сценарий 6: stop старого send после открытия нового чата ─────────────────
describe('Сц.6 — позднее событие остановленного/стейл send не попадает в новый чат', () => {
  it('late-событие старого чата уходит в его snapshot, активный чат нетронут', () => {
    const activeMessages: ChatMessage[] = [{ role: 'user', content: 'новый чат B' }]
    useProject.setState({ activeChatId: 2, messages: activeMessages, isStreaming: false }, false)

    // Позднее событие от старого send чата 1 (после переключения на 2).
    useProject.getState().applyEventToChat(1, { type: 'text', text: 'хвост старого send' })

    const st = useProject.getState()
    // Ушло в snapshot чата 1, активный чат 2 не затронут (нет утечки).
    expect(st.chatSnapshots[1]?.messages).toEqual([{ role: 'assistant', content: 'хвост старого send' }])
    expect(st.messages).toBe(activeMessages)
    expect(st.activeChatId).toBe(2)
  })

  it('стейл sendOwner не резолвится после старта нового send в том же чате', () => {
    useProject.getState().registerSendOwner(7, { kind: 'chat', chatId: 1 })
    // Старый send «остановлен», в чате 1 стартовал новый send.
    useProject.getState().registerSendOwner(8, { kind: 'chat', chatId: 1 })
    expect(useProject.getState().lookupSendOwner(7)).toBeNull()
    expect(useProject.getState().lookupSendOwner(8)).toMatchObject({ chatId: 1, laneGeneration: 2 })
  })
})
