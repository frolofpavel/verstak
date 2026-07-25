// Characterization-харнес ChatSessionLifecycle (фаза 5, срез 3): пины патчей,
// которые РАНЬШЕ были рукописными литералами в projectStore (switchChatSession ×2,
// newChatSession, setProject ×2 фазы, closeProject, leaveHelpMode). Поведение 1-в-1:
// каждый expect — это бывший inline-литерал. Любая правка билдера, меняющая патч,
// упадёт здесь ДО того как уедет в store.
import { describe, expect, it } from 'vitest'
import type { ChatSession } from '../../src/types/api'
import {
  buildCloseProjectPatch,
  buildFreshSwitchPatch,
  buildLeaveHelpRestorePatch,
  buildNewChatPatch,
  buildRestoredSwitchPatch,
  buildSetProjectPatch,
} from '../../src/store/chat-lifecycle'
import { freshSnapshot, type SessionSnapshot } from '../../src/store/session-snapshot'

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }

const chat = (id: number): ChatSession => ({
  id, projectPath: '/p', title: `Чат ${id}`, kind: 'main',
  providerId: null, model: null, parentChatId: null,
  createdAt: 1, updatedAt: 1,
} as unknown as ChatSession)

const usedSnapshot = (patch: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  ...freshSnapshot(),
  chatId: 7,
  messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
  isStreaming: true,
  streamStartedAt: 123,
  checkpointId: 55,
  checkpointMessageId: 56,
  preflights: [{ callId: 'c1', summary: 's', affectedZones: [], risk: 'low', riskReason: '', verifyAfter: [], outOfScope: [] }],
  subagentRuns: [{ callId: 'd1', label: 'sub', task: 't', status: 'running' }],
  hasUnread: true,
  ...patch,
})

describe('chat-lifecycle — пины бывших inline-патчей projectStore', () => {
  it('buildFreshSwitchPatch = else-ветка switchChatSession (нет снапшота)', () => {
    const snapshots = { 1: freshSnapshot() }
    expect(buildFreshSwitchPatch({ activeChatId: 2, chatSnapshots: snapshots })).toEqual({
      activeChatId: 2,
      messages: [],
      chatHasMoreBefore: false,
      chatTotalCount: 0,
      isStreaming: false,
      streamStartedAt: null,
      pendingWrites: [],
      pendingCommand: null,
      activity: [],
      agentProgress: [],
      sessionUsage: ZERO_USAGE,
      runningPlanStep: null,
      chatSnapshots: snapshots,
      openedReviewId: null,
      touchedFiles: {},
      checkpointId: null,
      checkpointMessageId: null,
      artifacts: [],
      previewArtifactId: null,
      preflights: [],
      subagentRuns: [],
    })
  })

  it('buildRestoredSwitchPatch = if-ветка switchChatSession: bundle из снапшота + non-bundle сброс', () => {
    const snap = usedSnapshot()
    const snapshots = { 1: freshSnapshot() }
    const patch = buildRestoredSwitchPatch({ activeChatId: 7, restored: snap, chatSnapshots: snapshots })
    // per-chat поля восстанавливаются ИЗ снапшота (finding 2/3 — чужие не утекают)
    expect(patch.messages).toEqual(snap.messages)
    expect(patch.isStreaming).toBe(true)
    expect(patch.streamStartedAt).toBe(123)
    expect(patch.checkpointId).toBe(55)
    expect(patch.checkpointMessageId).toBe(56)
    expect(patch.preflights).toEqual(snap.preflights)
    expect(patch.subagentRuns).toEqual(snap.subagentRuns)
    // non-bundle — явный сброс (2.0.1: раньше протекали от уходящего чата)
    expect(patch.touchedFiles).toEqual({})
    expect(patch.artifacts).toEqual([])
    expect(patch.previewArtifactId).toBeNull()
    expect(patch.openedReviewId).toBeNull()
    expect(patch.activeChatId).toBe(7)
    expect(patch.chatSnapshots).toBe(snapshots)
    // hasUnread — свойство фона, в top-level не поднимается
    expect(patch).not.toHaveProperty('hasUnread')
  })

  it('buildNewChatPatch = newChatSession. ПИН ДРЕЙФА: chatHasMoreBefore/chatTotalCount НЕ сбрасываются (как inline)', () => {
    const snapshots = { 1: freshSnapshot() }
    const patch = buildNewChatPatch({ activeChatId: 3, chatSnapshots: snapshots, chatSessions: [chat(3)] })
    expect(patch).toEqual({
      chatSessions: [chat(3)],
      activeChatId: 3,
      chatSnapshots: snapshots,
      messages: [],
      activity: [],
      agentProgress: [],
      pendingWrites: [],
      pendingCommand: null,
      runningPlanStep: null,
      isStreaming: false,
      streamStartedAt: null,
      touchedFiles: {},
      checkpointId: null,
      checkpointMessageId: null,
      artifacts: [],
      openedReviewId: null,
      previewArtifactId: null,
      sessionUsage: ZERO_USAGE,
      preflights: [],
      subagentRuns: [],
    })
    // Известный дрейф inline-версии (кандидат на отдельный фикс, НЕ в рефакторе):
    // новый чат наследует пагинацию истории уходящего чата.
    expect(patch).not.toHaveProperty('chatHasMoreBefore')
    expect(patch).not.toHaveProperty('chatTotalCount')
  })

  it('buildLeaveHelpRestorePatch: стрим восстанавливается только при реальном inflight', () => {
    const snap = usedSnapshot()
    const snapshots = { 2: freshSnapshot() }

    const inflight = buildLeaveHelpRestorePatch({ snap, chatSnapshots: snapshots, inflight: true })
    expect(inflight.isStreaming).toBe(true)
    expect(inflight.streamStartedAt).toBe(123)
    expect(inflight.helpMode).toBe(false)
    expect(inflight.messages).toEqual(snap.messages)
    expect(inflight.chatSnapshots).toBe(snapshots)

    // Фоновый прогон завершился, пока были в справке → «отвечает…» не залипает
    const stale = buildLeaveHelpRestorePatch({ snap, chatSnapshots: snapshots, inflight: false })
    expect(stale.isStreaming).toBe(false)
    expect(stale.streamStartedAt).toBeNull()

    // Не стримил и не inflight → тоже false
    const quiet = buildLeaveHelpRestorePatch({ snap: usedSnapshot({ isStreaming: false }), chatSnapshots: snapshots, inflight: true })
    expect(quiet.isStreaming).toBe(false)
    expect(quiet.streamStartedAt).toBeNull()
  })

  it('buildCloseProjectPatch = closeProject: полный сброс эфемерного состояния', () => {
    expect(buildCloseProjectPatch()).toEqual({
      path: null,
      tree: [],
      messages: [],
      chatHasMoreBefore: false,
      chatTotalCount: 0,
      isStreaming: false,
      streamStartedAt: null,
      pendingWrites: [],
      pendingCommand: null,
      pendingPlan: null,
      activity: [],
      agentProgress: [],
      preflights: [],
      subagentRuns: [],
      sessionUsage: ZERO_USAGE,
      runningPlanStep: null,
      activeChatId: null,
      chatSessions: [],
      chatSnapshots: {},
      sessions: {},
      sendOwners: {},
      chatLaneGenerations: {},
      reviews: {},
      openedReviewId: null,
      touchedFiles: {},
      checkpointId: null,
      checkpointMessageId: null,
      artifacts: [],
      resumableRuns: [],
      activePipeline: null,
      activeDevTaskId: null,
      devTask: null,
      helpMode: false,
    })
  })

  it('buildSetProjectPatch: фазы отличаются только messages/chatSessions/activeChatId', () => {
    const target = usedSnapshot({ chatId: 9 })
    const sessions = { '/other': freshSnapshot() }
    const phase1 = buildSetProjectPatch({
      path: '/p', target, sessions, messages: target.messages, chatSessions: [], activeChatId: 9,
    })
    const phase2 = buildSetProjectPatch({
      path: '/p', target, sessions, messages: [], chatSessions: [chat(9)], activeChatId: 9,
    })
    // Общая часть фаз идентична (бывший дублированный литерал). chatTotalCount —
    // производная messages (messages.length), поэтому тоже варьируется по фазам.
    const { messages: _m1, chatSessions: _c1, activeChatId: _a1, chatTotalCount: _t1, ...rest1 } = phase1
    const { messages: _m2, chatSessions: _c2, activeChatId: _a2, chatTotalCount: _t2, ...rest2 } = phase2
    expect(rest1).toEqual(rest2)
    expect(rest1).toEqual({
      path: '/p',
      tree: [],
      chatHasMoreBefore: false,
      isStreaming: true,
      streamStartedAt: 123,
      pendingWrites: [],
      pendingCommand: null,
      activity: [],
      agentProgress: [],
      sessionUsage: target.sessionUsage,
      runningPlanStep: null,
      checkpointId: 55,
      checkpointMessageId: 56,
      preflights: target.preflights,
      subagentRuns: target.subagentRuns,
      activeView: 'chat',
      sessions,
      touchedFiles: {},
      activeDevTaskId: null,
      devTask: null,
      chatSnapshots: {},
      reviews: {},
      openedReviewId: null,
      artifacts: [],
      resumableRuns: [],
      activePipeline: null,
      helpMode: false,
    })
    expect(phase1.messages).toEqual(target.messages)
    expect(phase1.chatTotalCount).toBe(2)
    expect(phase1.chatSessions).toEqual([])
    expect(phase2.messages).toEqual([])
    expect(phase2.chatSessions).toEqual([chat(9)])
    expect(phase2.chatTotalCount).toBe(0)
  })

  it('buildSetProjectPatch: agentProgress undefined в старом снапшоте → [] (legacy-защита)', () => {
    const legacy = { ...usedSnapshot(), agentProgress: undefined as unknown as SessionSnapshot['agentProgress'] }
    const patch = buildSetProjectPatch({
      path: '/p', target: legacy, sessions: {}, messages: [], chatSessions: [], activeChatId: null,
    })
    expect(patch.agentProgress).toEqual([])
  })
})
