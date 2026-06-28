import { create } from 'zustand'
import type { FileNode, ChatMessage, ProjectMeta, ChatSession, DevTask, ResumableRun } from '../types/api'
import { sortProjectsByName } from '../lib/project-sort'
import { isModelValidForProvider } from '../hooks/useProvider'
import { isGenericChatTitle, titleFromFirstMessage } from '../lib/chat-session-title'
import { useSkills } from './skillStore'
import {
  freshSnapshot,
  captureBundle,
  restoreBundle,
  backgroundActiveChat,
  TOUCH_PRIORITY,
  type PendingWrite,
  type PendingCommand,
  type ActivityEntry,
  type TouchKind,
  type SessionUsage,
  type RunningPlanStep,
  type SessionSnapshot,
  type PreflightCard,
  type SubagentRunCard
} from './session-snapshot'
import { applySnapshotEvent } from './apply-snapshot-event'
import { appendThinkingToLastAssistant, appendToLastAssistant } from '../lib/chat-messages'
import { createPipelineSlice, type PipelineSlice } from './pipeline-slice'
import { createReviewSlice, type ReviewSlice } from './review-slice'
import { HELP_PROJECT_PATH } from '../lib/help-scope'
import {
  EMPTY_COMPOSER_DRAFT,
  isEmptyComposerDraft,
  pruneComposerDraftsForProject,
  type ComposerDraft,
} from '../lib/composer-drafts'
import { stampDurationOnStreamEnd } from '../lib/response-duration'

// PreflightCard / SubagentRunCard перенесены в session-snapshot.ts (store-agnostic),
// т.к. теперь входят в per-chat bundle. Re-export для существующих импортов (Chat.tsx).
export type { PreflightCard, SubagentRunCard } from './session-snapshot'

export type ViewId = 'chat' | 'tasks' | 'journal' | 'reminders' | 'plan' | 'workflow' | 'calendar' | 'feedback' | 'browser' | 'skills' | 'design' | 'video' | 'inspector' | 'memory-gov' | 'agents' | 'tasks-manager' | 'project-map' | 'task' | 'files' | 'decisions' | 'brain' | 'scheduler'

/**
 * Owner для in-flight sendId. Заменил собой 2 параллельных мапа
 * (sendIdToChatId + sendIdToReviewChatId). Единый источник правды снимает
 * класс race-багов: события из main роутятся через ОДИН lookup, не два.
 *
 * - 'chat': обычная переписка в main-чате. ownerId = chat_sessions.id.
 * - 'review': sub-chat ревьюера. parentChatId — какой main-чат он ревьюит.
 */
export type SendOwner =
  | { kind: 'chat'; chatId: number; isHelp?: boolean }
  | { kind: 'review'; reviewChatId: number; parentChatId: number }

export interface ProjectState extends PipelineSlice, ReviewSlice {
  path: string | null
  tree: FileNode[]
  messages: ChatMessage[]
  isStreaming: boolean
  streamStartedAt: number | null
  pendingWrites: PendingWrite[]
  pendingCommand: PendingCommand | null
  /** #3 plan-gate: план, ожидающий одобрения (foreground, top-level). */
  pendingPlan: { callId: string; title: string; stepCount: number; sendId?: number } | null
  activity: ActivityEntry[]
  /** Preflight-карточки текущей сессии. Эфемерные — чистятся на новом send. */
  preflights: PreflightCard[]
  /** Sub-agent runs текущей сессии (fan-out V1). Эфемерные — чистятся на send. */
  subagentRuns: SubagentRunCard[]
  /** Per-session "the AI has touched these files" map — feeds Sidebar markers
   *  (Gemini Ultra audit: Context Depth Visualizer). Keyed by project-relative
   *  path; value is the highest-priority kind observed. */
  touchedFiles: Record<string, TouchKind>
  /** Undo entry ID at the moment the user pressed "📍 Чекпоинт". Revert-to-
   *  checkpoint pops every entry whose id > this until back at this mark.
   *  Null when no checkpoint set. */
  checkpointId: number | null
  /** Dev Task Flow (Фаза 2): id активной dev_task текущего чата (или null).
   *  Привязывается при openDevTask, питает бейдж и вкладку «Задача». */
  activeDevTaskId: number | null
  /** Снимок активной dev_task — обновляется refreshDevTask. null если задачи нет. */
  devTask: DevTask | null
  activeView: ViewId
  sessionUsage: SessionUsage
  runningPlanStep: RunningPlanStep | null
  projectList: ProjectMeta[]
  /** Chat sessions of the active project. */
  chatSessions: ChatSession[]
  /** Currently active chat session id within the project. */
  activeChatId: number | null
  /** Глобальный чат справки (kind=help) — отдельно от проектов. */
  helpChatId: number | null
  /** Пользователь смотрит экран справки, а не рабочий чат проекта. */
  helpMode: boolean
  /** Состояние справки: сообщения, стрим, активность. */
  help: SessionSnapshot
  /** Per-project session snapshots for backgrounded projects. */
  sessions: Record<string, SessionSnapshot>
  /** Per-chat snapshots within active project — preserve state when switching
   *  between chats so a backgrounded chat's stream isn't lost. */
  chatSnapshots: Record<number, SessionSnapshot>
  /** Единый реестр in-flight sendId. Раньше было 2 параллельных мапа
   *  (sendIdToChatId + sendIdToReviewChatId), каждый со своим жизненным
   *  циклом — это давало race-баги в роутинге событий. Теперь один источник
   *  правды: каждый sendId привязан к owner'у с известным kind.
   *
   *  See SendOwner type для возможных видов владельцев. */
  sendOwners: Record<number, SendOwner>
  /** Артефакты сгенерированные агентом в активной сессии (generate_html /
   *  generate_docx). Сбрасываются при switchChatSession. */
  artifacts: Array<{ kind: 'html' | 'docx' | 'verification'; filename: string; path: string; sizeBytes: number; ts: number; overall?: 'passed' | 'failed' | 'partial' | 'not_run'; checksPassed?: number; checksTotal?: number }>
  /** Текущий артефакт открытый в preview pane (path как ID). null = закрыт. */
  previewArtifactId: string | null
  /** Crash-resume (P1): зависшие после краха прогоны текущего проекта для баннера
   *  «сессия прервана». Заполняется loadResumableRuns при открытии проекта. */
  resumableRuns: ResumableRun[]
  setProject: (path: string) => Promise<void>
  closeProject: () => void
  refreshProjectList: () => Promise<void>
  updateProjectMeta: (path: string, patch: { name?: string; iconPath?: string | null; hidden?: boolean }) => Promise<ProjectMeta | null>
  removeProject: (path: string, options?: { deleteData?: boolean }) => Promise<{ ok: boolean; error?: string }>
  setActiveView: (v: ViewId) => void
  addMessage: (msg: ChatMessage) => void
  /** Вставить сообщение перед последним (обычно — перед стримящим assistant). */
  insertMessageBeforeLast: (msg: ChatMessage) => void
  updateLastAssistant: (text: string) => void
  /** Append chain-of-thought text to the last assistant message. Rendered as
   *  a collapsible block, not as part of the visible answer. */
  appendLastAssistantThinking: (text: string) => void
  setStreaming: (v: boolean) => void
  addPendingWrite: (w: PendingWrite) => void
  resolvePendingWrite: (callId: string) => void
  clearPendingWrites: () => void
  setPendingCommand: (c: PendingCommand | null) => void
  setPendingPlan: (p: { callId: string; title: string; stepCount: number; sendId?: number } | null) => void
  /** T1.3 Inbox: снять pendingCommand конкретного чата (активного или фонового
   *  снапшота) — резолв approval из общего Inbox, не заходя в чат. */
  clearChatPendingCommand: (chatId: number) => void
  pushActivity: (entry: ActivityEntry) => void
  updateActivity: (id: string, patch: Partial<ActivityEntry>) => void
  clearActivity: () => void
  /** Добавить preflight-карточку (агент объявил план). */
  pushPreflight: (card: PreflightCard) => void
  /** Upsert sub-agent run card по callId (running → done/error). */
  upsertSubagentRun: (card: SubagentRunCard) => void
  /** Record that the AI just touched a file (read / write / list). Upgrades
   *  the marker if a higher-priority kind is observed. */
  markFileTouched: (path: string, kind: TouchKind) => void
  clearTouchedFiles: () => void
  /** Snap a checkpoint at the current undo head. Subsequent writes can be
   *  rolled back to this mark in one click. */
  setCheckpoint: (id: number | null) => void
  /** Dev Task Flow (Фаза 2): сделать задачу активной (id + снимок) и открыть
   *  вкладку «Задача». */
  openDevTask: (task: DevTask) => void
  /** Перечитать снимок активной dev_task из main (devtask:get). No-op без id. */
  refreshDevTask: () => Promise<void>
  /** Сбросить активную задачу (снимок + id). Вкладку не переключает. */
  closeDevTask: () => void
  addUsage: (delta: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }) => void
  resetUsage: () => void
  setRunningPlanStep: (s: RunningPlanStep | null) => void
  /** Apply an ai:event to a background session (used when projectPath !== current). */
  applyEventToSession: (projectPath: string, event: { type: string; [k: string]: unknown }) => void
  /** Mark a session as read (clear the unread badge). */
  markSessionRead: (projectPath: string) => void
  /** Зарегистрировать in-flight sendId с его владельцем (chat / review).
   *  Единая точка регистрации — все ai:event поступают сюда через lookup. */
  registerSendOwner: (sendId: number, owner: SendOwner) => void
  /** Найти владельца sendId. Используется в Chat.tsx event handler для
   *  роутинга событий (text/done/error в нужный snapshot). */
  lookupSendOwner: (sendId: number) => SendOwner | null
  /** Убрать sendId из реестра — обычно при done/error event. */
  forgetSendOwner: (sendId: number) => void
  /** Apply an ai:event to a background CHAT snapshot (within active project,
   *  but not the active chat). */
  applyEventToChat: (chatId: number, event: { type: string; [k: string]: unknown }) => void
  /** Replace the message list of a background CHAT snapshot. Used by SideChat
   *  to seed persisted history on first open without touching the active chat. */
  seedChatSnapshot: (chatId: number, messages: ChatMessage[]) => void
  /** Push a user message + empty assistant placeholder into a background CHAT
   *  snapshot. Used by SideChat's composer — streamed assistant text then lands
   *  via applyEventToChat (text events append to the last assistant message). */
  pushUserToChatSnapshot: (chatId: number, content: string, meta?: Partial<ChatMessage>) => void
  /** Switch to a different chat session within the active project. */
  switchChatSession: (id: number) => Promise<void>
  /** Refresh the chat sessions list (after create/rename/delete). */
  refreshChatSessions: () => Promise<void>
  /** Optimistically update a chat-session row without refetching the list.
   *  Used by rename — avoids the stream-disrupting re-render cascade. */
  patchChatSession: (id: number, patch: Partial<ChatSession>) => void
  /** Первое сообщение → осмысленный заголовок вместо «Новый чат» / Parallel chat. */
  autoTitleChatSession: (chatId: number, firstUserText: string) => Promise<void>
  /** Create a new chat session in the active project and switch to it. */
  newChatSession: (title?: string) => Promise<ChatSession | null>
  /** Tier-2 #3 — ветвление: форк сессии (копия истории) + переключение на ветку. */
  forkChat: (sourceId: number) => Promise<ChatSession | null>
  /** Открыть глобальный чат справки (скилл verstak-guide). */
  openHelpChat: () => Promise<void>
  /** Выйти из экрана справки в рабочий чат проекта. */
  leaveHelpMode: () => void
  applyEventToHelp: (event: { type: string; [k: string]: unknown }) => void
  markHelpRead: () => void
  setHelpStreaming: (v: boolean) => void
  addHelpMessage: (msg: ChatMessage) => void
  insertHelpMessageBeforeLast: (msg: ChatMessage) => void
  updateHelpLastAssistant: (text: string) => void
  appendHelpLastAssistantThinking: (text: string) => void
  clearHelpActivity: () => void
  pushHelpActivity: (entry: ActivityEntry) => void
  addHelpUsage: (delta: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }) => void
  /** Зарегистрировать сгенерированный артефакт (для Timeline pill). */
  recordArtifact: (a: { kind: 'html' | 'docx' | 'verification'; filename: string; path: string; sizeBytes: number; overall?: 'passed' | 'failed' | 'partial' | 'not_run'; checksPassed?: number; checksTotal?: number }) => void
  /** Прикрепить DoD-бейдж (overall/N/M) к последнему verification-артефакту. */
  setVerificationBadge: (badge: { overall: 'passed' | 'failed' | 'partial' | 'not_run'; checksPassed: number; checksTotal: number }) => void
  /** Сбросить артефакты (вызывается при смене чата / нового чата). */
  clearArtifacts: () => void
  /** Открыть preview панель для артефакта (по path как ID), или закрыть (null). */
  setPreviewArtifact: (path: string | null) => void
  /** Уровень усилий модели. Влияет на max_tokens / extended thinking. */
  effortLevel: 'quick' | 'standard' | 'deep'
  setEffortLevel: (level: 'quick' | 'standard' | 'deep') => void
  /** Crash-resume: подгрузить зависшие прогоны проекта для баннера. Fire-and-forget. */
  loadResumableRuns: (path: string) => Promise<void>
  /** Crash-resume: отклонить баннер для прогона (убрать из resumableRuns + main). */
  dismissResumableRun: (runId: string) => void
  /** Несохранённые черновики композера (текст + вложения) до выхода из приложения. */
  composerDrafts: Record<string, ComposerDraft>
  setComposerDraft: (key: string, draft: ComposerDraft) => void
  getComposerDraft: (key: string) => ComposerDraft
  clearComposerDraft: (key: string) => void
  /** Зафиксировать длительность ответа и сбросить таймер активного проектного чата. */
  finalizeActiveStreamDuration: () => void
  /** То же для глобальной справки. */
  finalizeHelpStreamDuration: () => void
}

// Monotonic token used by setProject to cancel its own stale concurrent runs.
// If the user clicks project A then project B before A's async work finishes,
// only B's set() should land. We bump on entry, snapshot the value, and bail
// on every await boundary if our token is no longer current.
let setProjectToken = 0
let switchChatSessionToken = 0

export const LAST_PROJECT_PATH_KEY = 'last_project_path'

function hasInflightChatSend(
  sendOwners: ProjectState['sendOwners'],
  chatId: number,
  isHelp: boolean
): boolean {
  return Object.values(sendOwners).some(
    o => o.kind === 'chat' && !!o.isHelp === isHelp && o.chatId === chatId
  )
}



export const useProject = create<ProjectState>((set, get, store) => ({
  path: null,
  tree: [],
  messages: [],
  isStreaming: false,
  streamStartedAt: null,
  pendingWrites: [],
  pendingCommand: null,
  pendingPlan: null,
  activity: [],
  preflights: [],
  subagentRuns: [],
  touchedFiles: {},
  checkpointId: null,
  activeDevTaskId: null,
  devTask: null,
  activeView: 'chat',
  sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  runningPlanStep: null,
  projectList: [],
  chatSessions: [],
  activeChatId: null,
  helpChatId: null,
  helpMode: false,
  help: freshSnapshot(),
  sessions: {},
  chatSnapshots: {},
  sendOwners: {},
  artifacts: [],
  previewArtifactId: null,
  effortLevel: 'standard',
  resumableRuns: [],
  composerDrafts: {},
  setComposerDraft: (key, draft) => set(s => {
    if (isEmptyComposerDraft(draft)) {
      if (!(key in s.composerDrafts)) return {}
      const next = { ...s.composerDrafts }
      delete next[key]
      return { composerDrafts: next }
    }
    return { composerDrafts: { ...s.composerDrafts, [key]: draft } }
  }),
  getComposerDraft: (key) => get().composerDrafts[key] ?? EMPTY_COMPOSER_DRAFT,
  clearComposerDraft: (key) => get().setComposerDraft(key, EMPTY_COMPOSER_DRAFT),
  finalizeActiveStreamDuration: () => set(s => {
    const stamped = stampDurationOnStreamEnd({
      messages: s.messages,
      isStreaming: s.isStreaming,
      streamStartedAt: s.streamStartedAt,
    })
    return { ...stamped }
  }),
  finalizeHelpStreamDuration: () => set(s => {
    const stamped = stampDurationOnStreamEnd(s.help)
    return { help: { ...s.help, ...stamped } }
  }),
  setProject: async (path) => {
    const myToken = ++setProjectToken
    const s = get()
    const wasHelp = s.helpMode
    if (wasHelp) get().leaveHelpMode()
    // Вернулись из справки в тот же проект — leaveHelpMode уже восстановил чат.
    if (wasHelp && s.path === path) {
      set({ activeView: 'chat' })
      return
    }
    // 1) Snapshot current session before switching (so background streams keep their state)
    let nextSessions = s.sessions
    if (s.path && s.path !== path) {
      nextSessions = { ...s.sessions, [s.path]: captureBundle(s) }
    }
    const existing = nextSessions[path]
    let target: SessionSnapshot
    if (existing) {
      // Returning to a backgrounded session — keep its state, clear unread badge
      target = { ...existing, hasUnread: false }
      // Remove from sessions map since it becomes the active one
      const { [path]: _drop, ...rest } = nextSessions
      void _drop
      nextSessions = rest
    } else {
      target = freshSnapshot()
    }

    void window.api.projects.setCurrent(path)
    void window.api.settings.setKey(LAST_PROJECT_PATH_KEY, path)

    const [projectList, chatSessionsRaw] = await Promise.all([
      window.api.projects.list(),
      window.api.chatSessions.list(path),
    ])
    if (myToken !== setProjectToken) return

    void window.api.files.tree(path).then(tree => {
      if (myToken !== setProjectToken) return
      if (get().path !== path) return
      set({ tree })
    }).catch(() => { /* files panel fills in later */ })

    let chatSessions = chatSessionsRaw
    if (chatSessions.length === 0) {
      const created = await window.api.chatSessions.create(path, { title: 'Основной чат' })
      if (myToken !== setProjectToken) return
      chatSessions = [created]
    }

    const activeChatId = chatSessions[0]?.id ?? null
    const needsDbHydrate = Boolean(
      activeChatId && (!existing || existing.messages.length === 0)
    )
    const initialMessages = needsDbHydrate ? [] : target.messages

    if (myToken !== setProjectToken) return
    set({
      path,
      tree: [],
      messages: initialMessages,
      isStreaming: target.isStreaming,
      streamStartedAt: target.streamStartedAt,
      pendingWrites: target.pendingWrites,
      pendingCommand: target.pendingCommand,
      activity: target.activity,
      sessionUsage: target.sessionUsage,
      runningPlanStep: target.runningPlanStep,
      // checkpointId/preflights/subagentRuns теперь per-chat в bundle —
      // восстанавливаем сохранённое для активного чата нового проекта (finding 2/3).
      checkpointId: target.checkpointId,
      preflights: target.preflights,
      subagentRuns: target.subagentRuns,
      activeView: 'chat',
      projectList,
      chatSessions,
      activeChatId,
      sessions: nextSessions,
      // touchedFiles/artifacts НЕ в bundle — сбрасываем при смене проекта
      // (scoped to active conversation, не к проекту).
      touchedFiles: {},
      // Dev Task Flow (Фаза 2): активная задача привязана к чату/проекту —
      // сбрасываем при смене проекта (бейдж переразрешит её для нового контекста).
      activeDevTaskId: null,
      devTask: null,
      // Сбрасываем chatSnapshots — при смене проекта снапшоты предыдущего
      // проекта не должны просачиваться если SQLite autoincrement ID пересекутся.
      chatSnapshots: {},
      // Сбрасываем reviews из памяти — для нового проекта подгружаем заново
      // через refreshReviewsFor (ниже).
      reviews: {},
      openedReviewId: null,
      artifacts: [],
      // Crash-resume: сбрасываем баннер предыдущего проекта; перезагрузим ниже.
      resumableRuns: [],
      // Pipeline: не тащим прогон другого проекта; подгрузим активный для path.
      activePipeline: null,
      helpMode: false,
    })
    if (needsDbHydrate && activeChatId != null) {
      const hydrateChatId = activeChatId
      void (async () => {
        const history = await window.api.chats.list(hydrateChatId)
        if (myToken !== setProjectToken) return
        const cur = get()
        if (cur.path !== path || cur.activeChatId !== hydrateChatId) return
        set({ messages: history.map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt })) })
      })()
    }

    if (activeChatId != null) {
      void get().refreshReviewsFor(activeChatId)
    }
    // Crash-resume: подгружаем зависшие после краха прогоны этого проекта для
    // баннера «сессия прервана». Fire-and-forget.
    void get().loadResumableRuns(path)
    void get().loadActivePipeline(path)
  },
  closeProject: () => set({
    // 5.3 (review P0): нет проекта = чистый лист. Раньше сбрасывалась лишь часть
    // полей → sendOwners/helpMode/sessions/snapshots/preflights/subagentRuns/
    // reviews утекали в следующий открытый проект. Полный сброс эфемерного
    // состояния сессии/чата (projectList/composerDrafts — кросс-проектные, не трогаем).
    path: null,
    tree: [],
    messages: [],
    isStreaming: false,
    streamStartedAt: null,
    pendingWrites: [],
    pendingCommand: null,
    pendingPlan: null, // #3 plan-gate: проект закрыт → снять модалку плана
    activity: [],
    preflights: [],
    subagentRuns: [],
    sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    runningPlanStep: null,
    activeChatId: null,
    chatSessions: [],
    chatSnapshots: {},
    sessions: {},
    sendOwners: {},
    reviews: {},
    openedReviewId: null,
    touchedFiles: {},
    checkpointId: null,
    artifacts: [],
    resumableRuns: [],
    activePipeline: null,
    activeDevTaskId: null,
    devTask: null,
    helpMode: false,
  }),
  refreshProjectList: async () => {
    const projectList = await window.api.projects.list()
    set({ projectList })
  },
  updateProjectMeta: async (path, patch) => {
    const updated = await window.api.projects.updateMeta(path, patch)
    if (!updated) return null
    set(s => ({
      projectList: sortProjectsByName(s.projectList.map(p => (p.path === path ? updated : p)))
    }))
    return updated
  },
  removeProject: async (path: string, options?: { deleteData?: boolean }) => {
    const result = await window.api.projects.remove(path, options)
    if (!result.ok) return result
    const projectList = await window.api.projects.list()
    const state = get()
    const composerDrafts = pruneComposerDraftsForProject(state.composerDrafts, path)
    if (state.path === path) {
      set({ path: null, tree: [], messages: [], projectList, activeChatId: null, chatSessions: [], composerDrafts })
    } else {
      set({ projectList, composerDrafts })
    }
    return result
  },
  setActiveView: (v) => set({ activeView: v }),
  addMessage: (msg) => set(s => ({
    messages: [...s.messages, { ...msg, createdAt: msg.createdAt ?? Date.now() }],
  })),
  insertMessageBeforeLast: (msg) => set(s => {
    const stamped = { ...msg, createdAt: msg.createdAt ?? Date.now() }
    const msgs = [...s.messages]
    if (msgs.length === 0) return { messages: [stamped] }
    const last = msgs[msgs.length - 1]
    const at = last?.role === 'assistant' ? msgs.length - 1 : msgs.length
    msgs.splice(at, 0, stamped)
    return { messages: msgs }
  }),
  updateLastAssistant: (text) => set(s => ({ messages: appendToLastAssistant(s.messages, text) })),
  appendLastAssistantThinking: (text) => set(s => ({ messages: appendThinkingToLastAssistant(s.messages, text) })),
  setStreaming: (v) => set(s => ({
    isStreaming: v,
    streamStartedAt: v ? Date.now() : s.streamStartedAt,
  })),
  addPendingWrite: (w) => set(s => ({ pendingWrites: [...s.pendingWrites, w] })),
  resolvePendingWrite: (callId) => set(s => ({ pendingWrites: s.pendingWrites.filter(w => w.callId !== callId) })),
  clearPendingWrites: () => set({ pendingWrites: [] }),
  setPendingCommand: (c) => set({ pendingCommand: c }),
  setPendingPlan: (p) => set({ pendingPlan: p }),
  clearChatPendingCommand: (chatId) => set(s => {
    const patch: Partial<ProjectState> = {}
    if (chatId === s.activeChatId && s.pendingCommand) patch.pendingCommand = null
    const snap = s.chatSnapshots[chatId]
    if (snap?.pendingCommand) {
      patch.chatSnapshots = { ...s.chatSnapshots, [chatId]: { ...snap, pendingCommand: null } }
    }
    return patch
  }),
  pushActivity: (entry) => set(s => ({ activity: [...s.activity, entry] })),
  updateActivity: (id, patch) => set(s => ({
    activity: s.activity.map(a => a.id === id ? { ...a, ...patch } : a)
  })),
  clearActivity: () => set({ activity: [], preflights: [], subagentRuns: [] }),
  pushPreflight: (card) => set(s => ({ preflights: [...s.preflights, card] })),
  upsertSubagentRun: (card) => set(s => {
    const idx = s.subagentRuns.findIndex(r => r.callId === card.callId)
    if (idx === -1) return { subagentRuns: [...s.subagentRuns, card] }
    const next = s.subagentRuns.slice()
    next[idx] = { ...next[idx], ...card }
    return { subagentRuns: next }
  }),
  markFileTouched: (path, kind) => set(s => {
    if (!path) return {}
    const existing = s.touchedFiles[path]
    if (existing && TOUCH_PRIORITY[existing] >= TOUCH_PRIORITY[kind]) return {}
    return { touchedFiles: { ...s.touchedFiles, [path]: kind } }
  }),
  clearTouchedFiles: () => set({ touchedFiles: {} }),
  setCheckpoint: (id) => set({ checkpointId: id }),
  openDevTask: (task) => set({ activeDevTaskId: task.id, devTask: task, activeView: 'task' }),
  refreshDevTask: async () => {
    const id = get().activeDevTaskId
    if (id == null) return
    try {
      const detail = await window.api.devtask.get(id)
      // Задача могла быть удалена/не найдена — снимаем активность.
      if (!detail?.task) { set({ devTask: null, activeDevTaskId: null }); return }
      set({ devTask: detail.task })
    } catch { /* IPC недоступен в dev — оставляем текущий снимок */ }
  },
  closeDevTask: () => set({ activeDevTaskId: null, devTask: null }),
  addUsage: (delta) => set(s => ({
    sessionUsage: {
      inputTokens: s.sessionUsage.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: s.sessionUsage.outputTokens + (delta.outputTokens ?? 0),
      cachedInputTokens: s.sessionUsage.cachedInputTokens + (delta.cachedInputTokens ?? 0)
    }
  })),
  resetUsage: () => set({ sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } }),
  setRunningPlanStep: (s) => set({ runningPlanStep: s }),
  applyEventToSession: (projectPath, event) => set(s => {
    const existing = s.sessions[projectPath] ?? freshSnapshot()
    let next = applySnapshotEvent({ ...existing, hasUnread: true }, event)
    // pending-write/command — специфика фоновой ПРОЕКТНОЙ сессии (не в общем ядре).
    const t = event.type
    if (t === 'pending-write' && typeof event.callId === 'string') {
      next = { ...next, pendingWrites: [...next.pendingWrites, {
        callId: event.callId,
        path: String(event.path ?? ''),
        before: String(event.before ?? ''),
        after: String(event.after ?? '')
      }] }
    } else if (t === 'pending-command' && typeof event.callId === 'string') {
      next = { ...next, pendingCommand: { callId: event.callId, command: String(event.command ?? ''), sendId: typeof event.sendId === 'number' ? event.sendId : undefined } }
    }
    return { sessions: { ...s.sessions, [projectPath]: next } }
  }),
  markSessionRead: (projectPath) => set(s => {
    const existing = s.sessions[projectPath]
    if (!existing) return {}
    return { sessions: { ...s.sessions, [projectPath]: { ...existing, hasUnread: false } } }
  }),
  switchChatSession: async (id) => {
    const myToken = ++switchChatSessionToken
    const s = get()
    if (!s.path) return
    get().leaveHelpMode()
    const nextSnapshots = backgroundActiveChat(s.chatSnapshots, s.activeChatId, id, s)
    const restored = nextSnapshots[id]
    const session = s.chatSessions.find(c => c.id === id)

    if (restored) {
      delete nextSnapshots[id]
      set({
        ...restoreBundle(restored),
        activeChatId: id,
        chatSnapshots: nextSnapshots,
        openedReviewId: null,
        // Эти поля НЕ входят в bundle (top-level стора) — без явного сброса они
        // утекают от предыдущего активного чата (артефакты/маркеры/checkpoint/preview).
        // touchedFiles/artifacts/previewArtifactId НЕ входят в bundle — сбрасываем
        // явно, иначе утекут от уходящего чата. А checkpointId/preflights/
        // subagentRuns теперь в bundle (restoreBundle выше) → восстанавливаются
        // per-chat, чужие не утекают (finding 2/3, ревью Verstak 23.06).
        touchedFiles: {},
        artifacts: [],
        previewArtifactId: null
      })
    } else {
      set({
        activeChatId: id,
        messages: [],
        isStreaming: false,
        streamStartedAt: null,
        pendingWrites: [],
        pendingCommand: null,
        activity: [],
        sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        runningPlanStep: null,
        chatSnapshots: nextSnapshots,
        openedReviewId: null,
        touchedFiles: {},
        checkpointId: null,
        artifacts: [],
        previewArtifactId: null,
        preflights: [],
        subagentRuns: []
      })
      void (async () => {
        const history = await window.api.chats.list(id)
        if (myToken !== switchChatSessionToken) return
        if (get().activeChatId !== id) return
        set({ messages: history.map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt })) })
      })()
    }

    if (session?.providerId) {
      void (async () => {
        try {
          await window.api.settings.setKey('provider', session.providerId!)
          if (session.model && isModelValidForProvider(session.providerId!, session.model)) {
            await window.api.settings.setKey(`model_${session.providerId}`, session.model)
          } else if (session.model) {
            await window.api.settings.setKey(`model_${session.providerId}`, '')
            await window.api.chatSessions.setModel(id, session.providerId!, null)
          }
        } catch { /* settings write failure shouldn't block chat switch */ }
      })()
    }
    void get().refreshReviewsFor(id)
  },
  registerSendOwner: (sendId, owner) => set(s => ({
    sendOwners: { ...s.sendOwners, [sendId]: owner }
  })),
  lookupSendOwner: (sendId) => get().sendOwners[sendId] ?? null,
  forgetSendOwner: (sendId) => set(s => {
    if (!(sendId in s.sendOwners)) return {}
    const next = { ...s.sendOwners }
    delete next[sendId]
    return { sendOwners: next }
  }),
  applyEventToChat: (chatId, event) => set(s => {
    const existing = s.chatSnapshots[chatId] ?? freshSnapshot()
    let next = applySnapshotEvent({ ...existing, hasUnread: true }, event)
    // 5.1 (review P0): pending-write/command фонового чата — в его snapshot (как
    // applyEventToSession). Иначе после switchChatSession confirm-модалка не
    // всплывёт (restoreBundle поднимает pending из снапшота в top-level) и main
    // зависнет на resolveWrite/resolveCommand.
    const t = event.type
    if (t === 'pending-write' && typeof event.callId === 'string') {
      next = { ...next, pendingWrites: [...next.pendingWrites, {
        callId: event.callId,
        path: String(event.path ?? ''),
        before: String(event.before ?? ''),
        after: String(event.after ?? '')
      }] }
    } else if (t === 'pending-command' && typeof event.callId === 'string') {
      next = { ...next, pendingCommand: { callId: event.callId, command: String(event.command ?? ''), sendId: typeof event.sendId === 'number' ? event.sendId : undefined } }
    }
    // Персист завершённого assistant-сообщения в БД (переживёт reload).
    if ((event.type === 'done' || event.type === 'error') && s.path) {
      const lastMsg = next.messages[next.messages.length - 1]
      if (lastMsg?.role === 'assistant' && lastMsg.content) {
        void window.api.chats.append(chatId, s.path, 'assistant', lastMsg.content).catch(() => {})
      }
    }
    return { chatSnapshots: { ...s.chatSnapshots, [chatId]: next } }
  }),
  seedChatSnapshot: (chatId, messages) => set(s => {
    const existing = s.chatSnapshots[chatId] ?? freshSnapshot()
    return { chatSnapshots: { ...s.chatSnapshots, [chatId]: { ...existing, messages } } }
  }),
  pushUserToChatSnapshot: (chatId, content, meta) => set(s => {
    const existing = s.chatSnapshots[chatId] ?? freshSnapshot()
    return {
      chatSnapshots: {
        ...s.chatSnapshots,
        [chatId]: {
          ...existing,
          messages: [...existing.messages, { ...meta, role: 'user', content }, { role: 'assistant', content: '' }],
          isStreaming: true,
          streamStartedAt: Date.now(),
          hasUnread: false
        }
      }
    }
  }),
  refreshChatSessions: async () => {
    const s = get()
    if (!s.path) return
    const list = await window.api.chatSessions.list(s.path)
    set({ chatSessions: list })
  },
  /**
   * Patch one chat-session in place — used by rename so we don't have to
   * refetch the whole list. переименование чата
   * во время стрима ломало ответ. Полная перезагрузка списка чатов давала
   * re-render волну, которая в некоторых условиях прерывала входящий
   * ai:event поток. Локальный optimistic patch убирает этот класс багов
   * целиком — ничего, кроме одного title, не меняется.
   */
  patchChatSession: (id, patch) => set(s => ({
    chatSessions: s.chatSessions.map(c => c.id === id ? { ...c, ...patch } : c)
  })),
  autoTitleChatSession: async (chatId, firstUserText) => {
    const s = get()
    const session = s.chatSessions.find(c => c.id === chatId)
    if (!session || !isGenericChatTitle(session.title)) return
    const title = titleFromFirstMessage(firstUserText)
    if (!title) return
    get().patchChatSession(chatId, { title })
    try {
      await window.api.chatSessions.rename(chatId, title)
    } catch (err) {
      console.warn('[projectStore] autoTitleChatSession rename failed:', err)
      await get().refreshChatSessions()
    }
  },
  newChatSession: async (title) => {
    const s = get()
    if (!s.path) return null
    // Inherit the currently-selected provider/model so a new chat doesn't
    // reset back to gemini-api when user is e.g. in the middle of working
    // with Claude.
    const currentProvider = await window.api.settings.getKey('provider')
    const currentModel = currentProvider ? await window.api.settings.getKey(`model_${currentProvider}`) : null
    const created = await window.api.chatSessions.create(s.path, {
      title,
      providerId: currentProvider ?? null,
      model: currentModel ?? null
    })
    const list = await window.api.chatSessions.list(s.path)
    // Снапшотим уходящий активный чат — как switchChatSession. Иначе при создании
    // нового чата во время стрима частичный ответ старого чата теряется, а его
    // фоновые события (включая финальный done) уходят в пустой freshSnapshot (#8).
    const nextSnapshots = backgroundActiveChat(s.chatSnapshots, s.activeChatId, created.id, s)
    set({
      chatSessions: list,
      activeChatId: created.id,
      chatSnapshots: nextSnapshots,
      messages: [],
      activity: [],
      pendingWrites: [],
      pendingCommand: null,
      runningPlanStep: null,
      isStreaming: false,
      streamStartedAt: null,
      touchedFiles: {},
      checkpointId: null,
      artifacts: [],
      // Эфемерные карточки активности уходящего чата — не тащим в новый (finding 3).
      preflights: [],
      subagentRuns: []
    })
    return created
  },
  forkChat: async (sourceId) => {
    const s = get()
    if (!s.path) return null
    // Не форкаем СТРИМЯЩИЙ чат: in-flight ответ ещё не персистнут в БД → ветка
    // получила бы усечённую историю без последней реплики (ревью 26.06).
    const streaming = (sourceId === s.activeChatId && s.isStreaming) || s.chatSnapshots[sourceId]?.isStreaming
    if (streaming) return null
    try {
      const branch = await window.api.chatSessions.fork(sourceId)
      if (!branch) return null
      const list = await window.api.chatSessions.list(s.path)
      set({ chatSessions: list })
      // switchChatSession снапшотит уходящий чат и грузит скопированную историю ветки.
      await get().switchChatSession(branch.id)
      return branch
    } catch (e) {
      console.error('[forkChat] fork failed:', e instanceof Error ? e.message : e)
      return null
    }
  },
  leaveHelpMode: () => {
    const s = get()
    if (!s.helpMode) return
    useSkills.getState().setActiveSkill(null)
    const chatId = s.activeChatId
    const snap = chatId != null ? s.chatSnapshots[chatId] : undefined
    if (snap && chatId != null) {
      const nextSnapshots = { ...s.chatSnapshots }
      delete nextSnapshots[chatId]
      const inflight = hasInflightChatSend(s.sendOwners, chatId, false)
      set({
        helpMode: false,
        // restoreBundle — единая форма восстановления (вкл. checkpointId/preflights/
        // subagentRuns per-chat). Стрим переопределяем ниже: восстанавливаем только
        // если он реально ещё в полёте (иначе залипает баннер «отвечает»).
        ...restoreBundle(snap),
        isStreaming: inflight && snap.isStreaming,
        streamStartedAt: inflight && snap.isStreaming ? snap.streamStartedAt : null,
        chatSnapshots: nextSnapshots,
      })
      return
    }
    set({ helpMode: false, isStreaming: false, streamStartedAt: null })
  },
  markHelpRead: () => set(s => ({
    help: { ...s.help, hasUnread: false }
  })),
  setHelpStreaming: (v) => set(s => ({
    help: {
      ...s.help,
      isStreaming: v,
      streamStartedAt: v ? Date.now() : s.help.streamStartedAt,
    }
  })),
  addHelpMessage: (msg) => set(s => ({
    help: { ...s.help, messages: [...s.help.messages, msg] }
  })),
  insertHelpMessageBeforeLast: (msg) => set(s => {
    const msgs = [...s.help.messages]
    if (msgs.length === 0) return { help: { ...s.help, messages: [msg] } }
    msgs.splice(msgs.length - 1, 0, msg)
    return { help: { ...s.help, messages: msgs } }
  }),
  updateHelpLastAssistant: (text) => set(s => {
    const msgs = [...s.help.messages]
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant') {
      msgs[msgs.length - 1] = { ...last, content: text }
    }
    return { help: { ...s.help, messages: msgs } }
  }),
  appendHelpLastAssistantThinking: (text) => set(s => ({ help: { ...s.help, messages: appendThinkingToLastAssistant(s.help.messages, text) } })),
  clearHelpActivity: () => set(s => ({
    help: { ...s.help, activity: [] }
  })),
  pushHelpActivity: (entry) => set(s => ({
    help: { ...s.help, activity: [...s.help.activity, entry] }
  })),
  addHelpUsage: (delta) => set(s => ({
    help: {
      ...s.help,
      sessionUsage: {
        inputTokens: s.help.sessionUsage.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: s.help.sessionUsage.outputTokens + (delta.outputTokens ?? 0),
        cachedInputTokens: s.help.sessionUsage.cachedInputTokens + (delta.cachedInputTokens ?? 0)
      }
    }
  })),
  applyEventToHelp: (event) => set(s => {
    const next = applySnapshotEvent({ ...s.help, hasUnread: s.helpMode ? false : true }, event)
    const t = event.type
    if (t === 'done' || t === 'error') {
      // Персист завершённого assistant-сообщения справки в БД.
      const lastMsg = next.messages[next.messages.length - 1]
      const chatId = s.helpChatId
      if (lastMsg?.role === 'assistant' && lastMsg.content && chatId != null) {
        void window.api.chats.append(chatId, HELP_PROJECT_PATH, 'assistant', lastMsg.content).catch(() => {})
      }
    } else if (t === 'info' && typeof event.text === 'string') {
      // info → активити-плашка (специфика справки, не в общем ядре).
      return { help: { ...next, activity: [...next.activity, {
        id: `info-${Date.now()}`,
        kind: 'read',
        label: event.text,
        detail: '',
        status: 'ok',
        timestamp: Date.now()
      }] } }
    }
    return { help: next }
  }),
  openHelpChat: async () => {
    const s = get()
    if (s.helpMode) {
      get().leaveHelpMode()
      return
    }
    const helpSession = await window.api.chatSessions.getOrCreateHelp()
    if (s.path && s.activeChatId != null) {
      const nextSnapshots = { ...s.chatSnapshots }
      // captureBundle вместо рукописного литерала — единый источник формы снапшота
      // (вкл. checkpointId/preflights/subagentRuns), чтобы не забыть поле (#8/#17).
      nextSnapshots[s.activeChatId] = captureBundle(s)
      // Стрим проекта уходит в chatSnapshots; в корне сбрасываем — иначе после
      // выхода из справки send блокируется, пока фоновый прогон не завершится.
      set({
        chatSnapshots: nextSnapshots,
        isStreaming: false,
        streamStartedAt: null,
        pendingWrites: [],
        pendingCommand: null,
      })
    }
    let helpState = s.help
    if (helpState.messages.length === 0) {
      const history = await window.api.chats.list(helpSession.id)
      helpState = {
        ...helpState,
        messages: history.map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt }))
      }
    }
    set({
      helpChatId: helpSession.id,
      helpMode: true,
      help: { ...helpState, hasUnread: false },
      activeView: 'chat'
    })
    useSkills.getState().setActiveSkill('verstak-guide')
  },
  recordArtifact: (a) => set(s => ({
    artifacts: [...s.artifacts, { ...a, ts: Date.now() }]
  })),
  setVerificationBadge: (badge) => set(s => {
    // Патчим последний verification-артефакт DoD-бейджем. Хендлер шлёт
    // artifact-created(kind=verification) синхронно перед verification-attested,
    // так что последний verification в списке — наш.
    const idx = [...s.artifacts].map(a => a.kind).lastIndexOf('verification')
    if (idx < 0) return {}
    const next = s.artifacts.slice()
    next[idx] = { ...next[idx], ...badge }
    return { artifacts: next }
  }),
  clearArtifacts: () => set({ artifacts: [], previewArtifactId: null }),
  setPreviewArtifact: (path) => set({ previewArtifactId: path }),
  setEffortLevel: (level) => set({ effortLevel: level }),
  loadResumableRuns: async (path) => {
    try {
      const runs = await window.api.agentRuns.listResumable(path)
      // Гонка смены проекта: применяем только если проект всё ещё активен.
      if (get().path !== path) return
      set({ resumableRuns: runs })
    } catch (err) {
      console.warn('[crash-resume] loadResumableRuns failed:', err)
    }
  },
  dismissResumableRun: (runId) => {
    void window.api.agentRuns.dismissResumable(runId)
    set(s => ({ resumableRuns: s.resumableRuns.filter(r => r.runId !== runId) }))
  },
  // §5 распил: pipeline + review вынесены в отдельные слайсы (спред справа от main-полей).
  ...createPipelineSlice(set, get, store),
  ...createReviewSlice(set, get, store),
}))

// Re-export pure session types из нового модуля, чтобы публичная поверхность
// projectStore не менялась (ActivityEntry/PendingCommand/SessionUsage/TouchKind
// раньше экспортировались отсюда).
export type { ActivityEntry, PendingCommand, SessionUsage, TouchKind }
// §5 распил: ReviewState переехал в review-slice; ре-экспорт держит публичную поверхность.
export type { ReviewState } from './review-slice'
