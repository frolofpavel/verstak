import { describe, it, expect, beforeEach, vi } from 'vitest'

// PerChatState 4.2 — sync-страж SSOT: после КАЖДОГО экшена, трогающего chat-bundle,
// инвариант обязан держаться:
//   1. фоновые: chats[id] ≡ chatSnapshots[id] (вьюха зеркалит SSOT);
//   2. foreground активный: chats[activeChatId] ≡ top-level bundle-поля,
//      hasUnread=false, chatId совпадает;
//   3. без лишних ключей: chats = chatSnapshots ∪ {activeChatId}.
// Это страховка на время 4.2-4.3, пока top-level — поддерживаемая проекция:
// тихая рассинхронизация упадёт здесь, а не в проде.

const windowStub = {
  api: {
    chats: {
      listWindow: vi.fn(async () => ({ messages: [], totalCount: 0, hasMoreBefore: false })),
      list: vi.fn(async () => []),
      append: vi.fn(async () => {}),
    },
    settings: { setKey: vi.fn(async () => {}), getKey: vi.fn(async () => null) },
    skills: { recordUse: vi.fn(async () => {}) },
    chatSessions: {
      listReviews: vi.fn(async () => []),
      getOrCreateHelp: vi.fn(async () => ({ id: 99 })),
      create: vi.fn(async (_p: string, opts?: { title?: string }) => ({
        id: 4, projectPath: _p, title: opts?.title ?? 'Новый чат', kind: 'main',
        providerId: null, model: null, parentChatId: null, createdAt: 1, updatedAt: 1,
      })),
      list: vi.fn(async (p: string) => [
        { id: 1, projectPath: p, title: 'Чат 1', kind: 'main', providerId: null, model: null, parentChatId: null, createdAt: 1, updatedAt: 1 },
        { id: 2, projectPath: p, title: 'Чат 2', kind: 'main', providerId: null, model: null, parentChatId: null, createdAt: 1, updatedAt: 1 },
        { id: 3, projectPath: p, title: 'Чат 3', kind: 'main', providerId: null, model: null, parentChatId: null, createdAt: 1, updatedAt: 1 },
        { id: 4, projectPath: p, title: 'Новый чат', kind: 'main', providerId: null, model: null, parentChatId: null, createdAt: 1, updatedAt: 1 },
      ]),
    },
  },
}
vi.stubGlobal('window', windowStub)

import { useProject, type ProjectState } from '../../src/store/projectStore'
import { freshSnapshot, restoreBundle } from '../../src/store/session-snapshot'

const BUNDLE_KEYS = [
  'messages', 'isStreaming', 'streamStartedAt', 'pendingWrites', 'pendingCommand',
  'activity', 'agentProgress', 'sessionUsage', 'runningPlanStep',
  'checkpointId', 'checkpointMessageId', 'preflights', 'subagentRuns',
] as const

function pickBundle(o: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {}
  for (const k of BUNDLE_KEYS) r[k] = o[k]
  return r
}

function assertChatSync(s: ProjectState) {
  // 1. фоновые: chats ≡ chatSnapshots
  for (const [idRaw, snap] of Object.entries(s.chatSnapshots)) {
    expect(s.chats[Number(idRaw)], `chats[${idRaw}] зеркалит chatSnapshots`).toEqual(snap)
  }
  // 2. активный foreground: chats[activeChatId] ≡ top-level bundle.
  //    Исключение: активный уведён в фон справкой (helpMode + есть снапшот) —
  //    тогда он фоновый и покрыт пунктом 1.
  const backgroundedActive = s.activeChatId != null && s.helpMode && s.chatSnapshots[s.activeChatId] != null
  if (s.activeChatId != null && !backgroundedActive) {
    const entry = s.chats[s.activeChatId]
    expect(entry, 'chats[activeChatId] обязан существовать').toBeDefined()
    expect(pickBundle(entry as unknown as Record<string, unknown>)).toEqual(
      pickBundle(s as unknown as Record<string, unknown>)
    )
    expect(entry.hasUnread).toBe(false)
    expect(entry.chatId).toBe(s.activeChatId)
  }
  // 3. без лишних ключей: chats = chatSnapshots ∪ {activeChatId}
  const expected = new Set(Object.keys(s.chatSnapshots).map(Number))
  if (s.activeChatId != null) expected.add(s.activeChatId)
  const sortNum = (a: number, b: number) => a - b
  expect(Object.keys(s.chats).map(Number).sort(sortNum)).toEqual([...expected].sort(sortNum))
}

const chatRow = (id: number) => ({
  id, projectPath: '/p', title: `Чат ${id}`, kind: 'main' as const,
  providerId: null, model: null, parentChatId: null, createdAt: 1, updatedAt: 1, lastMessageAt: 1,
})

describe('PerChatState 4.2 — sync-страж chats (SSOT) после экшенов', () => {
  beforeEach(() => {
    // vitest конфиг: unstubGlobals — стаб снимается после КАЖДОГО теста,
    // поэтому перевыставляем (как в edit-via-fork.test.ts).
    vi.stubGlobal('window', windowStub)
    useProject.getState().closeProject()
    // Сидируем «открытый проект» с активным чатом 1 (foreground в SSOT).
    useProject.setState({
      path: '/p',
      activeChatId: 1,
      chatSessions: [chatRow(1), chatRow(2), chatRow(3)],
      chats: { 1: { ...restoreBundle(freshSnapshot()), chatId: 1, hasUnread: false } },
    })
  })

  it('writers активного чата: top-level ≡ chats[1] после каждого', () => {
    const st = () => useProject.getState()
    st().addMessage({ role: 'user', content: 'привет' })
    assertChatSync(st())
    // Пустой assistant-плейсхолдер — как в реальном send; updateLastAssistant
    // дописывает в ПОСЛЕДНЕЕ assistant-сообщение (на user — no-op).
    st().addMessage({ role: 'assistant', content: '' })
    st().setStreaming(true)
    assertChatSync(st())
    st().updateLastAssistant('ответ')
    assertChatSync(st())
    st().addUsage({ inputTokens: 100, outputTokens: 5 })
    assertChatSync(st())
    st().pushActivity({ id: 'a1', kind: 'read', label: 'read_file', status: 'ok', timestamp: 1 })
    assertChatSync(st())
    st().pushPreflight({ callId: 'c1', summary: 's', affectedZones: [], risk: 'low', riskReason: '', verifyAfter: [], outOfScope: [] })
    assertChatSync(st())
    st().upsertSubagentRun({ callId: 'd1', label: 'sub', task: 't', status: 'running' })
    assertChatSync(st())
    st().setCheckpoint(55, 56)
    assertChatSync(st())
    st().finalizeActiveStreamDuration()
    assertChatSync(st())
    // Контроль: значения реально доехали в SSOT, не только «равны».
    expect(st().chats[1].messages).toHaveLength(2)
    expect(st().chats[1].sessionUsage.inputTokens).toBe(100)
    expect(st().chats[1].checkpointId).toBe(55)
  })

  it('writers фоновых чатов: chats ≡ chatSnapshots для каждого фона', () => {
    const st = () => useProject.getState()
    st().applyEventToChat(2, { type: 'text', text: 'фон' })
    assertChatSync(st())
    st().pushUserToChatSnapshot(3, 'вопрос в фоне')
    assertChatSync(st())
    st().applyEventToChat(2, { type: 'pending-command', callId: 'cmd1', command: 'ls' })
    assertChatSync(st())
    st().clearChatPendingCommand(2)
    assertChatSync(st())
    // Контроль содержимого.
    expect(st().chats[2].hasUnread).toBe(true)
    expect(st().chats[3].isStreaming).toBe(true)
    expect(st().messages).toEqual([]) // top-level активного не тронут
  })

  it('switchChatSession на фоновый чат: восстановленный ≡ chats, ушедший зеркален', async () => {
    const st = () => useProject.getState()
    st().applyEventToChat(2, { type: 'text', text: 'фон' })
    st().setStreaming(true) // фантом у уходящего чата 1 (нет in-flight send)
    await st().switchChatSession(2)
    assertChatSync(st())
    expect(st().activeChatId).toBe(2)
    // Фантомный стрим чата 1 снят keepStreamingOnlyWhenInflight — и в вьюхе, и в SSOT.
    expect(st().chatSnapshots[1].isStreaming).toBe(false)
    expect(st().chats[1].isStreaming).toBe(false)
    // Активный восстановлен из снапшота.
    expect(st().messages[st().messages.length - 1]?.content).toBe('фон')
  })

  it('newChatSession: свежий активный в SSOT, ушедший зеркален', async () => {
    const st = () => useProject.getState()
    st().addMessage({ role: 'user', content: 'старое' })
    await st().newChatSession()
    assertChatSync(st())
    expect(st().activeChatId).toBe(4)
    expect(st().chats[4].messages).toEqual([])
    expect(st().chatSnapshots[1].messages).toHaveLength(1)
  })

  it('helpMode: активный фоновый зеркален; события идут в снапшот; выход восстанавливает', async () => {
    const st = () => useProject.getState()
    st().addMessage({ role: 'user', content: 'до справки' })
    await st().openHelpChat()
    assertChatSync(st())
    expect(st().helpMode).toBe(true)
    // Активный фоновый: chats[1] ≡ chatSnapshots[1].
    expect(st().chats[1]).toEqual(st().chatSnapshots[1])
    // Событие чата во время справки → в снапшот/SSOT, не в top-level.
    st().applyEventToChat(1, { type: 'text', text: 'пока читал справку' })
    assertChatSync(st())
    expect(st().chatSnapshots[1].messages.some(m => m.content.includes('пока читал справку'))).toBe(true)
    st().leaveHelpMode()
    assertChatSync(st())
    expect(st().helpMode).toBe(false)
    // Восстановленный top-level несёт то, что пришло во время справки.
    expect(st().messages.some(m => m.content.includes('пока читал справку'))).toBe(true)
    expect(st().chatSnapshots[1]).toBeUndefined()
  })

  it('closeProject: SSOT и вьюха пусты', () => {
    const st = () => useProject.getState()
    st().applyEventToChat(2, { type: 'text', text: 'фон' })
    st().closeProject()
    assertChatSync(st())
    expect(st().chats).toEqual({})
    expect(st().chatSnapshots).toEqual({})
  })
})
