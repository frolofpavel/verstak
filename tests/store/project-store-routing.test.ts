import { describe, it, expect, beforeEach, vi } from 'vitest'

// projectStore actions reference window.api inside a few branches (e.g.
// applyEventToChat persists the finished assistant message via
// window.api.chats.append). Stub a minimal surface BEFORE importing the store
// so module load + the actions under test don't blow up on `window.api`.
// Keep it minimal — only the methods the tested actions actually call.
const appendSpy = vi.fn(async () => {})
const agentRunsListSpy = vi.fn(async (_path?: string, _opts?: { status?: string }) => [] as Array<{ runId: string }>)
const windowStub = { api: { chats: { append: appendSpy }, agentRuns: { list: agentRunsListSpy } } }
// Стабим ДО импорта стора (безопасность загрузки модуля). Переставляем в
// beforeEach: глобальный afterEach (tests/setup.ts) снимает все стабы после
// каждого теста, иначе window исчезает со второго теста файла.
vi.stubGlobal('window', windowStub)

import { useProject } from '../../src/store/projectStore'
import type { SendOwner, PreflightCard } from '../../src/store/projectStore'
import type { ChatMessage } from '../../src/types/api'

// Snapshot of the pristine zustand state so each test starts clean.
const INITIAL = useProject.getState()

function resetStore() {
  useProject.setState({
    path: INITIAL.path,
    messages: [],
    isStreaming: false,
    pendingWrites: [],
    pendingCommand: null,
    activity: [],
    agentProgress: [],
    preflights: [],
    touchedFiles: {},
    activeChatId: null,
    chatSnapshots: {},
    sendOwners: {},
    reviews: {},
    openedReviewId: null
  }, false)
}

beforeEach(() => {
  vi.stubGlobal('window', windowStub)
  resetStore()
  appendSpy.mockClear()
  agentRunsListSpy.mockClear()
  agentRunsListSpy.mockResolvedValue([] as Array<{ runId: string }>)
})

describe('reconcileStreamingState', () => {
  it('снимает ложный streaming, если в БД ещё running, но живого sendOwner уже нет', async () => {
    agentRunsListSpy.mockImplementation(async (_path?: string, opts?: { status?: string }) => (
      opts?.status === 'running' ? [{ runId: 'stale' }] : []
    ))
    useProject.setState({
      path: 'C:/proj',
      activeChatId: 1,
      isStreaming: true,
      streamStartedAt: 1000,
      messages: [
        { role: 'user', content: 'вопрос' },
        { role: 'assistant', content: '' }
      ] as ChatMessage[],
      chatSnapshots: {
        2: {
          messages: [{ role: 'assistant', content: '' }] as ChatMessage[],
          isStreaming: true,
          streamStartedAt: 1000,
          pendingWrites: [],
          pendingCommand: null,
          activity: [],
          agentProgress: [],
          sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
          runningPlanStep: null,
          hasUnread: false,
          checkpointId: null,
          checkpointMessageId: null,
          preflights: [],
          subagentRuns: []
        }
      },
      sendOwners: {}
    }, false)

    await useProject.getState().reconcileStreamingState('C:/proj')

    const st = useProject.getState()
    expect(st.isStreaming).toBe(false)
    expect(st.streamStartedAt).toBeNull()
    expect(st.chatSnapshots[2].isStreaming).toBe(false)
    expect(st.chatSnapshots[2].streamStartedAt).toBeNull()
  })
})

describe('SendRegistry — registerSendOwner / lookupSendOwner / forgetSendOwner', () => {
  it('register затем lookup возвращает того же владельца (chat)', () => {
    const owner: SendOwner = { kind: 'chat', chatId: 42 }
    useProject.getState().registerSendOwner(7, owner)
    expect(useProject.getState().lookupSendOwner(7)).toEqual(owner)
  })

  it('forget удаляет владельца, после чего lookup возвращает null', () => {
    useProject.getState().registerSendOwner(7, { kind: 'chat', chatId: 42 })
    useProject.getState().forgetSendOwner(7)
    expect(useProject.getState().lookupSendOwner(7)).toBeNull()
  })

  it('lookup неизвестного sendId возвращает null', () => {
    expect(useProject.getState().lookupSendOwner(999)).toBeNull()
  })

  it('forget несуществующего id не падает и не трогает другие записи', () => {
    useProject.getState().registerSendOwner(1, { kind: 'chat', chatId: 10 })
    useProject.getState().forgetSendOwner(123)
    expect(useProject.getState().lookupSendOwner(1)).toEqual({ kind: 'chat', chatId: 10 })
  })

  it('review-owner и chat-owner живут параллельно под разными sendId', () => {
    const chatOwner: SendOwner = { kind: 'chat', chatId: 10 }
    const reviewOwner: SendOwner = { kind: 'review', reviewChatId: 55, parentChatId: 10 }
    useProject.getState().registerSendOwner(1, chatOwner)
    useProject.getState().registerSendOwner(2, reviewOwner)
    expect(useProject.getState().lookupSendOwner(1)).toEqual(chatOwner)
    expect(useProject.getState().lookupSendOwner(2)).toEqual(reviewOwner)
  })
})

describe('Routing — события фонового чата идут в chatSnapshots, не в активный чат', () => {
  it('applyEventToChat для НЕактивного чата пишет в chatSnapshots[chatId], активный нетронут', () => {
    // Active chat 1 has its own messages + activity.
    const activeMessages: ChatMessage[] = [{ role: 'user', content: 'привет' }]
    const activeActivity = [{ id: 'a1', kind: 'read' as const, label: 'read', status: 'ok' as const, timestamp: 1 }]
    useProject.setState({
      activeChatId: 1,
      messages: activeMessages,
      activity: activeActivity,
      isStreaming: true
    }, false)

    // Background chat 2 receives a text event.
    useProject.getState().applyEventToChat(2, { type: 'text', text: 'ответ фонового чата' })

    const st = useProject.getState()
    // Background landed in its snapshot.
    expect(st.chatSnapshots[2]).toBeDefined()
    expect(st.chatSnapshots[2].messages).toEqual([{ role: 'assistant', content: 'ответ фонового чата' }])
    expect(st.chatSnapshots[2].hasUnread).toBe(true)
    // Active chat top-level state is untouched — core race-bug guard.
    expect(st.messages).toBe(activeMessages)
    expect(st.activity).toBe(activeActivity)
    expect(st.isStreaming).toBe(true)
    expect(st.chatSnapshots[1]).toBeUndefined()
  })

  it('несколько text events одного фонового чата аккумулируются в его snapshot', () => {
    useProject.getState().applyEventToChat(5, { type: 'text', text: 'часть1 ' })
    useProject.getState().applyEventToChat(5, { type: 'text', text: 'часть2' })
    expect(useProject.getState().chatSnapshots[5].messages).toEqual([
      { role: 'assistant', content: 'часть1 часть2' }
    ])
  })

  it('события двух разных фоновых чатов не смешиваются между собой', () => {
    useProject.getState().applyEventToChat(2, { type: 'text', text: 'для двойки' })
    useProject.getState().applyEventToChat(3, { type: 'text', text: 'для тройки' })
    const snaps = useProject.getState().chatSnapshots
    expect(snaps[2].messages[0].content).toBe('для двойки')
    expect(snaps[3].messages[0].content).toBe('для тройки')
  })

  it('done event снимает isStreaming у фонового snapshot и персистит ответ в БД', () => {
    useProject.setState({ path: 'C:/proj' }, false)
    useProject.getState().applyEventToChat(2, { type: 'text', text: 'готовый ответ' })
    useProject.getState().applyEventToChat(2, { type: 'done' })
    expect(useProject.getState().chatSnapshots[2].isStreaming).toBe(false)
    // Завершённый ассистентский ответ сохраняется в БД (переживёт reload).
    expect(appendSpy).toHaveBeenCalledWith(2, 'C:/proj', 'assistant', 'готовый ответ')
  })

  it('done event фонового чата сохраняет ответ с projectPath владельца, а не текущего проекта', () => {
    useProject.setState({ path: 'C:/other-project' }, false)
    useProject.getState().applyEventToChat(7, {
      type: 'text',
      text: 'ответ из другого проекта',
      projectPath: 'C:/real-project'
    })
    useProject.getState().applyEventToChat(7, { type: 'done', projectPath: 'C:/real-project' })

    expect(appendSpy).toHaveBeenCalledWith(7, 'C:/real-project', 'assistant', 'ответ из другого проекта')
  })

  it('background project chat event lands in the project session, not in the currently opened project chatSnapshots', () => {
    useProject.setState({
      path: 'C:/project-b',
      activeChatId: 22,
      messages: [{ role: 'user', content: 'project b task' }] as ChatMessage[],
      sessions: {
        'C:/project-a': {
          chatId: 11,
          messages: [
            { role: 'user', content: 'project a task' },
            { role: 'assistant', content: '' }
          ] as ChatMessage[],
          isStreaming: true,
          streamStartedAt: 1000,
          pendingWrites: [],
          pendingCommand: null,
          activity: [],
          agentProgress: [],
          sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
          runningPlanStep: null,
          hasUnread: false,
          checkpointId: null,
          checkpointMessageId: null,
          preflights: [],
          subagentRuns: []
        }
      }
    }, false)

    useProject.getState().applyEventToSession('C:/project-a', {
      type: 'text',
      text: 'finished while user was elsewhere',
      chatId: 11,
      projectPath: 'C:/project-a'
    })
    useProject.getState().applyEventToSession('C:/project-a', {
      type: 'done',
      chatId: 11,
      projectPath: 'C:/project-a'
    })

    const st = useProject.getState()
    expect(st.messages).toEqual([{ role: 'user', content: 'project b task' }])
    expect(st.chatSnapshots[11]).toBeUndefined()
    expect(st.sessions['C:/project-a'].chatId).toBe(11)
    expect(st.sessions['C:/project-a'].messages.at(-1)?.content).toBe('finished while user was elsewhere')
    expect(st.sessions['C:/project-a'].isStreaming).toBe(false)
    expect(st.sessions['C:/project-a'].hasUnread).toBe(true)
  })

  it('error event дописывает текст ошибки в последнее сообщение фонового чата', () => {
    useProject.getState().applyEventToChat(2, { type: 'text', text: 'частичный' })
    useProject.getState().applyEventToChat(2, { type: 'error', message: 'таймаут' })
    const snap = useProject.getState().chatSnapshots[2]
    expect(snap.isStreaming).toBe(false)
    expect(snap.messages[0].content).toContain('частичный')
    expect(snap.messages[0].content).toContain('таймаут')
  })

  it('usage event фонового чата накапливает токены только в его snapshot', () => {
    useProject.getState().applyEventToChat(2, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } })
    useProject.getState().applyEventToChat(2, { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } })
    const snap = useProject.getState().chatSnapshots[2]
    expect(snap.sessionUsage.inputTokens).toBe(13)
    expect(snap.sessionUsage.outputTokens).toBe(6)
    // Активная сессия (top-level) не затронута.
    expect(useProject.getState().sessionUsage.inputTokens).toBe(0)
  })
})

describe('Pending writes / commands — scoping и очистка', () => {
  it('clearPendingWrites убирает pending writes предыдущего send', () => {
    useProject.getState().addPendingWrite({ callId: 'w1', path: 'a.ts', before: '', after: 'x', sendId: 1 })
    expect(useProject.getState().pendingWrites).toHaveLength(1)
    useProject.getState().clearPendingWrites()
    expect(useProject.getState().pendingWrites).toEqual([])
  })

  it('resolvePendingWrite убирает только write с совпавшим callId', () => {
    useProject.getState().addPendingWrite({ callId: 'w1', path: 'a.ts', before: '', after: 'x' })
    useProject.getState().addPendingWrite({ callId: 'w2', path: 'b.ts', before: '', after: 'y' })
    useProject.getState().resolvePendingWrite('w1')
    const ids = useProject.getState().pendingWrites.map(w => w.callId)
    expect(ids).toEqual(['w2'])
  })

  it('pendingCommand из send A не виден после старта send B (setPendingCommand(null))', () => {
    useProject.getState().setPendingCommand({ callId: 'c1', command: 'rm -rf /', sendId: 1 })
    expect(useProject.getState().pendingCommand?.callId).toBe('c1')
    // Новый send B стартует — старая pending-confirmation должна обнулиться.
    useProject.getState().setPendingCommand(null)
    expect(useProject.getState().pendingCommand).toBeNull()
  })

  it('pending state фонового чата живёт в его snapshot, не в активном', () => {
    useProject.setState({ activeChatId: 1, pendingCommand: null, pendingWrites: [] }, false)
    useProject.getState().applyEventToChat(2, { type: 'pending-command', callId: 'bg', command: 'ls' })
    // Активный чат без pending; фоновый имеет своё.
    expect(useProject.getState().pendingCommand).toBeNull()
  })

  // 5.1 (review P0): фоновый чат должен СОХРАНЯТЬ pending-write/command в свой
  // snapshot — иначе после switchChatSession confirm-модалка не всплывёт (DiffView
  // читает top-level, restoreBundle поднимает из снапшота) и main зависнет на
  // resolveWrite. Тест выше проверял лишь что активный не загрязнён — это скрывало
  // потерю pending у фонового чата.
  it('5.1: pending-write фонового чата сохраняется в его snapshot', () => {
    useProject.setState({ activeChatId: 1, pendingCommand: null, pendingWrites: [] }, false)
    useProject.getState().applyEventToChat(2, { type: 'pending-write', callId: 'bgw', path: 'a.ts', before: '', after: 'x' })
    const snap = useProject.getState().chatSnapshots[2]
    expect(snap.pendingWrites).toHaveLength(1)
    expect(snap.pendingWrites[0].callId).toBe('bgw')
    expect(snap.pendingWrites[0].path).toBe('a.ts')
    expect(useProject.getState().pendingWrites).toEqual([])
  })

  it('5.1: pending-command фонового чата сохраняется в его snapshot', () => {
    useProject.setState({ activeChatId: 1, pendingCommand: null, pendingWrites: [] }, false)
    useProject.getState().applyEventToChat(2, { type: 'pending-command', callId: 'bgc', command: 'ls' })
    const snap = useProject.getState().chatSnapshots[2]
    expect(snap.pendingCommand?.callId).toBe('bgc')
    expect(snap.pendingCommand?.command).toBe('ls')
    expect(useProject.getState().pendingCommand).toBeNull()
  })
})

describe('clearActivity — сброс activity + preflights на новом send', () => {
  it('clearActivity обнуляет и activity, и preflights одним действием', () => {
    useProject.getState().pushActivity({ id: 'a1', kind: 'read', label: 'r', status: 'ok', timestamp: 1 })
    const card: PreflightCard = {
      callId: 'p1', summary: 's', affectedZones: ['z'], risk: 'low', riskReason: 'r', verifyAfter: [], outOfScope: []
    }
    useProject.getState().pushPreflight(card)
    expect(useProject.getState().activity).toHaveLength(1)
    expect(useProject.getState().preflights).toHaveLength(1)

    useProject.getState().clearActivity()
    expect(useProject.getState().activity).toEqual([])
    expect(useProject.getState().preflights).toEqual([])
  })

  it('новый send стартует с чистым activity (нет утечки из прошлого)', () => {
    useProject.getState().pushActivity({ id: 'old', kind: 'write', label: 'w', status: 'ok', timestamp: 1 })
    // Эмуляция начала нового send.
    useProject.getState().clearActivity()
    useProject.getState().pushActivity({ id: 'new', kind: 'read', label: 'r', status: 'pending', timestamp: 2 })
    const ids = useProject.getState().activity.map(a => a.id)
    expect(ids).toEqual(['new'])
  })
})

describe('cleanupReviewsFor — дренаж review-owners при удалении main-чата', () => {
  it('удаляет review entries и связанные sendOwners удалённого main-чата', () => {
    // main chat 10 has an in-flight chat send + a review send.
    useProject.getState().registerSendOwner(1, { kind: 'chat', chatId: 10 })
    useProject.getState().registerSendOwner(2, { kind: 'review', reviewChatId: 55, parentChatId: 10 })
    // unrelated chat 20 send must survive.
    useProject.getState().registerSendOwner(3, { kind: 'chat', chatId: 20 })
    useProject.setState({
      path: 'C:/proj',
      messages: [{ role: 'user', content: 'жив' }],
      reviews: {
        55: { reviewChatId: 55, parentChatId: 10, providerId: 'grok', model: null, content: '', status: 'streaming', createdAt: 1, noteCount: -1, findings: [], accepted: [] }
      }
    }, false)

    useProject.getState().cleanupReviewsFor(10)

    const st = useProject.getState()
    // review entry gone
    expect(st.reviews[55]).toBeUndefined()
    // both owners of chat 10 drained
    expect(st.lookupSendOwner(1)).toBeNull()
    expect(st.lookupSendOwner(2)).toBeNull()
    // unrelated chat 20 owner survives
    expect(st.lookupSendOwner(3)).toEqual({ kind: 'chat', chatId: 20 })
    // §5 распил, страж partial-merge: cleanupReviewsFor (review-slice) пишет
    // sendOwners (поле MainSlice) одним set — main-поля НЕ должны обнулиться.
    expect(st.path).toBe('C:/proj')
    expect(st.messages).toEqual([{ role: 'user', content: 'жив' }])
  })
})

describe('newChatSession — снапшот уходящего стримящего чата (#8)', () => {
  it('создание нового чата во время стрима снапшотит старый чат (не теряет ответ)', async () => {
    // Расширенный window stub: newChatSession читает settings + chatSessions.
    vi.stubGlobal('window', {
      api: {
        chats: { append: appendSpy },
        settings: { getKey: async () => null },
        chatSessions: {
          create: async () => ({ id: 99 }),
          list: async () => [{ id: 1 }, { id: 99 }]
        }
      }
    })
    useProject.setState({
      path: 'C:/proj',
      activeChatId: 1,
      isStreaming: true,
      messages: [
        { role: 'user', content: 'вопрос' },
        { role: 'assistant', content: 'частичный ответ' }
      ] as ChatMessage[],
      chatSnapshots: {},
      sendOwners: {
        7: { kind: 'chat', chatId: 1, projectPath: 'C:/proj' }
      }
    }, false)

    await useProject.getState().newChatSession()

    const st = useProject.getState()
    // активный чат переключился на новый
    expect(st.activeChatId).toBe(99)
    // снапшот старого чата 1 СОХРАНЁН (раньше был undefined → потеря ответа)
    expect(st.chatSnapshots[1]).toBeDefined()
    expect(st.chatSnapshots[1].messages).toEqual([
      { role: 'user', content: 'вопрос' },
      { role: 'assistant', content: 'частичный ответ' }
    ])
    expect(st.chatSnapshots[1].isStreaming).toBe(true)
  })
})
