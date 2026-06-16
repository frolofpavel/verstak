import { create } from 'zustand'
import type { FileNode, ChatMessage, ProjectMeta, ChatSession, DevTask, ResumableRun } from '../types/api'
import { sortProjectsByName } from '../lib/project-sort'
import { isModelValidForProvider } from '../hooks/useProvider'
import { parseReviewFindings, type ReviewFinding } from '../lib/review-findings'
import {
  freshSnapshot,
  TOUCH_PRIORITY,
  type PendingWrite,
  type PendingCommand,
  type ActivityEntry,
  type TouchKind,
  type SessionUsage,
  type RunningPlanStep,
  type SessionSnapshot
} from './session-snapshot'

/** Preflight-карточка: агент объявил план перед сложной/деструктивной задачей.
 *  Эфемерное — живёт только в активной сессии, чистится как activity. */
export interface PreflightCard {
  callId: string
  summary: string
  affectedZones: string[]
  risk: 'low' | 'medium' | 'high'
  riskReason: string
  verifyAfter: string[]
  outOfScope: string[]
}

/** Sub-agent run card (fan-out V1): delegate_task делегировал подзадачу.
 *  Эфемерное — чистится на новом send как preflights. Upsert по callId
 *  (running → done/error). */
export interface SubagentRunCard {
  callId: string
  label: string
  provider?: string
  skill?: string
  task: string
  status: 'running' | 'done' | 'error'
  result?: string
  role?: string
  /** Сколько tool-вызовов выполнил субагент (Фаза 1 — субы используют tools). */
  toolCount?: number
}

export type ViewId = 'chat' | 'tasks' | 'journal' | 'plan' | 'workflow' | 'calendar' | 'feedback' | 'browser' | 'skills' | 'design' | 'video' | 'inspector' | 'memory-gov' | 'agents' | 'tasks-manager' | 'project-map' | 'task'

/**
 * Owner для in-flight sendId. Заменил собой 2 параллельных мапа
 * (sendIdToChatId + sendIdToReviewChatId). Единый источник правды снимает
 * класс race-багов: события из main роутятся через ОДИН lookup, не два.
 *
 * - 'chat': обычная переписка в main-чате. ownerId = chat_sessions.id.
 * - 'review': sub-chat ревьюера. parentChatId — какой main-чат он ревьюит.
 */
export type SendOwner =
  | { kind: 'chat'; chatId: number }
  | { kind: 'review'; reviewChatId: number; parentChatId: number }

/**
 * In-flight or completed Review для main-чата. Хранится в store пока активен
 * проект — при переключении проекта/чата подгружается из БД заново через
 * refreshReviewsFor(mainChatId).
 */
export interface ReviewState {
  /** chat_sessions.id review sub-чата. */
  reviewChatId: number
  /** К какому main-чату относится. */
  parentChatId: number
  /** Провайдер, который выдавал ревью. */
  providerId: string
  model: string | null
  /** Текст ревью, накапливаемый по text events. */
  content: string
  status: 'streaming' | 'done' | 'error'
  errorMessage?: string
  createdAt: number
  /** Парсится из первой строки «ЗАМЕЧАНИЙ: N». -1 пока стримится. */
  noteCount: number
  /** V2: структурированные findings, распарсенные из ```json блока content на
   *  finalizeReview. Пусто для старого текстового ревью без json-блока. */
  findings: ReviewFinding[]
  /** V2: id принятых пользователем findings (для «исправить выбранные»). */
  accepted: string[]
}

interface ProjectState {
  path: string | null
  tree: FileNode[]
  messages: ChatMessage[]
  isStreaming: boolean
  pendingWrites: PendingWrite[]
  pendingCommand: PendingCommand | null
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
  /** Review state, keyed by reviewChatId. Pre-loaded on chat switch via
   *  refreshReviewsFor() and updated live during streaming. */
  reviews: Record<number, ReviewState>
  /** Текущий раскрытый review panel (или null если все свёрнуты). Хранится
   *  в store чтобы pills и панель могли быть в разных компонентах. */
  openedReviewId: number | null
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
  updateProjectMeta: (path: string, patch: { name?: string; iconPath?: string | null }) => Promise<ProjectMeta | null>
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
  pushUserToChatSnapshot: (chatId: number, content: string) => void
  /** Switch to a different chat session within the active project. */
  switchChatSession: (id: number) => Promise<void>
  /** Refresh the chat sessions list (after create/rename/delete). */
  refreshChatSessions: () => Promise<void>
  /** Optimistically update a chat-session row without refetching the list.
   *  Used by rename — avoids the stream-disrupting re-render cascade. */
  patchChatSession: (id: number, patch: Partial<ChatSession>) => void
  /** Create a new chat session in the active project and switch to it. */
  newChatSession: (title?: string) => Promise<ChatSession | null>
  /** Подгрузить review sub-chats для указанного main-чата из БД. */
  refreshReviewsFor: (parentChatId: number) => Promise<void>
  /** Начать новое ревью текущего main-чата. Возвращает reviewChatId. */
  startReview: (opts: {
    providerId: string
    model: string | null
    payload: string  // готовый сериализованный last turn
  }) => Promise<number | null>
  /** Обновить накопленный текст ревью (text event). */
  appendReviewContent: (reviewChatId: number, text: string) => void
  /** Финализировать ревью: парсит noteCount + findings, status='done'. */
  finalizeReview: (reviewChatId: number) => void
  /** V2: переключить «принято» для одного finding по id. */
  toggleFinding: (reviewChatId: number, findingId: string) => void
  /** Помечает ревью как failed. */
  failReview: (reviewChatId: number, message: string) => void
  /** Раскрыть/свернуть review panel. */
  toggleReviewPanel: (reviewChatId: number | null) => void
  /** Очистить in-memory review state для удалённого main-чата. */
  cleanupReviewsFor: (parentChatId: number) => void
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
}

// Monotonic token used by setProject to cancel its own stale concurrent runs.
// If the user clicks project A then project B before A's async work finishes,
// only B's set() should land. We bump on entry, snapshot the value, and bail
// on every await boundary if our token is no longer current.
let setProjectToken = 0
let switchChatSessionToken = 0

export const LAST_PROJECT_PATH_KEY = 'last_project_path'



export const useProject = create<ProjectState>((set, get) => ({
  path: null,
  tree: [],
  messages: [],
  isStreaming: false,
  pendingWrites: [],
  pendingCommand: null,
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
  sessions: {},
  chatSnapshots: {},
  sendOwners: {},
  reviews: {},
  openedReviewId: null,
  artifacts: [],
  previewArtifactId: null,
  effortLevel: 'standard',
  resumableRuns: [],
  setProject: async (path) => {
    const myToken = ++setProjectToken
    const s = get()
    // 1) Snapshot current session before switching (so background streams keep their state)
    let nextSessions = s.sessions
    if (s.path && s.path !== path) {
      nextSessions = {
        ...s.sessions,
        [s.path]: {
          messages: s.messages,
          isStreaming: s.isStreaming,
          pendingWrites: s.pendingWrites,
          pendingCommand: s.pendingCommand,
          activity: s.activity,
          sessionUsage: s.sessionUsage,
          runningPlanStep: s.runningPlanStep,
          hasUnread: false
        }
      }
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

    const [tree, projectList, chatSessionsRaw] = await Promise.all([
      window.api.files.tree(path),
      window.api.projects.list(),
      window.api.chatSessions.list(path),
    ])
    if (myToken !== setProjectToken) return

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
      tree,
      messages: initialMessages,
      isStreaming: target.isStreaming,
      pendingWrites: target.pendingWrites,
      pendingCommand: target.pendingCommand,
      activity: target.activity,
      sessionUsage: target.sessionUsage,
      runningPlanStep: target.runningPlanStep,
      activeView: 'chat',
      projectList,
      chatSessions,
      activeChatId,
      sessions: nextSessions,
      // Reset per-session UI markers when switching project — they're scoped
      // to the active conversation, not the project itself.
      touchedFiles: {},
      checkpointId: null,
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
      resumableRuns: []
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
  },
  closeProject: () => set({
    path: null,
    tree: [],
    messages: [],
    activity: [],
    pendingWrites: [],
    pendingCommand: null
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
    if (state.path === path) {
      set({ path: null, tree: [], messages: [], projectList, activeChatId: null, chatSessions: [] })
    } else {
      set({ projectList })
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
  updateLastAssistant: (text) => set(s => {
    const msgs = [...s.messages]
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant') msgs[msgs.length - 1] = { ...last, content: last.content + text }
    return { messages: msgs }
  }),
  appendLastAssistantThinking: (text) => set(s => {
    const msgs = [...s.messages]
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant') {
      msgs[msgs.length - 1] = { ...last, thinking: (last.thinking ?? '') + text }
    }
    return { messages: msgs }
  }),
  setStreaming: (v) => set({ isStreaming: v }),
  addPendingWrite: (w) => set(s => ({ pendingWrites: [...s.pendingWrites, w] })),
  resolvePendingWrite: (callId) => set(s => ({ pendingWrites: s.pendingWrites.filter(w => w.callId !== callId) })),
  clearPendingWrites: () => set({ pendingWrites: [] }),
  setPendingCommand: (c) => set({ pendingCommand: c }),
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
    const next = { ...existing, hasUnread: true }
    const t = event.type
    if (t === 'text' && typeof event.text === 'string') {
      const msgs = [...next.messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: last.content + event.text }
      } else {
        msgs.push({ role: 'assistant', content: event.text })
      }
      next.messages = msgs
    } else if (t === 'done' || t === 'error') {
      next.isStreaming = false
      if (t === 'error' && typeof event.message === 'string') {
        const msgs = [...next.messages]
        const last = msgs[msgs.length - 1]
        if (last?.role === 'assistant') {
          msgs[msgs.length - 1] = { ...last, content: last.content + `\n\n[Ошибка: ${event.message}]` }
        }
        next.messages = msgs
      }
    } else if (t === 'pending-write' && typeof event.callId === 'string') {
      next.pendingWrites = [...next.pendingWrites, {
        callId: event.callId,
        path: String(event.path ?? ''),
        before: String(event.before ?? ''),
        after: String(event.after ?? '')
      }]
    } else if (t === 'pending-command' && typeof event.callId === 'string') {
      next.pendingCommand = { callId: event.callId, command: String(event.command ?? '') }
    } else if (t === 'usage' && event.usage && typeof event.usage === 'object') {
      const u = event.usage as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
      next.sessionUsage = {
        inputTokens: next.sessionUsage.inputTokens + (u.inputTokens ?? 0),
        outputTokens: next.sessionUsage.outputTokens + (u.outputTokens ?? 0),
        cachedInputTokens: next.sessionUsage.cachedInputTokens + (u.cachedInputTokens ?? 0)
      }
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
    const nextSnapshots = { ...s.chatSnapshots }
    if (s.activeChatId != null && s.activeChatId !== id) {
      nextSnapshots[s.activeChatId] = {
        messages: s.messages,
        isStreaming: s.isStreaming,
        pendingWrites: s.pendingWrites,
        pendingCommand: s.pendingCommand,
        activity: s.activity,
        sessionUsage: s.sessionUsage,
        runningPlanStep: s.runningPlanStep,
        hasUnread: false
      }
    }
    const restored = nextSnapshots[id]
    const session = s.chatSessions.find(c => c.id === id)

    if (restored) {
      delete nextSnapshots[id]
      set({
        activeChatId: id,
        messages: restored.messages,
        isStreaming: restored.isStreaming,
        pendingWrites: restored.pendingWrites,
        pendingCommand: restored.pendingCommand,
        activity: restored.activity,
        sessionUsage: restored.sessionUsage,
        runningPlanStep: restored.runningPlanStep,
        chatSnapshots: nextSnapshots,
        openedReviewId: null
      })
    } else {
      set({
        activeChatId: id,
        messages: [],
        isStreaming: false,
        pendingWrites: [],
        pendingCommand: null,
        activity: [],
        sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        runningPlanStep: null,
        chatSnapshots: nextSnapshots,
        openedReviewId: null,
        touchedFiles: {},
        checkpointId: null,
        artifacts: []
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
    const next = { ...existing, hasUnread: true }
    const t = event.type
    if (t === 'text' && typeof event.text === 'string') {
      const msgs = [...next.messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: last.content + event.text }
      } else {
        msgs.push({ role: 'assistant', content: event.text })
      }
      next.messages = msgs
    } else if (t === 'thought' && typeof event.text === 'string') {
      const msgs = [...next.messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, thinking: (last.thinking ?? '') + event.text }
      }
      next.messages = msgs
    } else if (t === 'done' || t === 'error') {
      next.isStreaming = false
      if (t === 'error' && typeof event.message === 'string') {
        const msgs = [...next.messages]
        const last = msgs[msgs.length - 1]
        if (last?.role === 'assistant') {
          msgs[msgs.length - 1] = { ...last, content: last.content + `\n\n[Ошибка: ${event.message}]` }
        }
        next.messages = msgs
      }
      // Persist the completed assistant message to DB so it survives reload
      const lastMsg = next.messages[next.messages.length - 1]
      if (lastMsg?.role === 'assistant' && lastMsg.content && s.path) {
        void window.api.chats.append(chatId, s.path, 'assistant', lastMsg.content).catch(() => {})
      }
    } else if (t === 'usage' && event.usage && typeof event.usage === 'object') {
      const u = event.usage as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
      next.sessionUsage = {
        inputTokens: next.sessionUsage.inputTokens + (u.inputTokens ?? 0),
        outputTokens: next.sessionUsage.outputTokens + (u.outputTokens ?? 0),
        cachedInputTokens: next.sessionUsage.cachedInputTokens + (u.cachedInputTokens ?? 0)
      }
    }
    return { chatSnapshots: { ...s.chatSnapshots, [chatId]: next } }
  }),
  seedChatSnapshot: (chatId, messages) => set(s => {
    const existing = s.chatSnapshots[chatId] ?? freshSnapshot()
    return { chatSnapshots: { ...s.chatSnapshots, [chatId]: { ...existing, messages } } }
  }),
  pushUserToChatSnapshot: (chatId, content) => set(s => {
    const existing = s.chatSnapshots[chatId] ?? freshSnapshot()
    return {
      chatSnapshots: {
        ...s.chatSnapshots,
        [chatId]: {
          ...existing,
          messages: [...existing.messages, { role: 'user', content }, { role: 'assistant', content: '' }],
          isStreaming: true,
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
    set({
      chatSessions: list,
      activeChatId: created.id,
      messages: [],
      activity: [],
      pendingWrites: [],
      pendingCommand: null,
      runningPlanStep: null,
      isStreaming: false,
      touchedFiles: {},
      checkpointId: null,
      artifacts: []
    })
    return created
  },
  refreshReviewsFor: async (parentChatId) => {
    try {
      const list = await window.api.chatSessions.listReviews(parentChatId)
      // Grok audit fix (race): к моменту получения ответа из БД пользователь
      // мог переключиться на другой чат. Проверяем, что parentChatId всё
      // ещё активен — иначе результат stale, выбрасываем.
      const activeNow = get().activeChatId
      if (activeNow !== parentChatId) return
      const toHydrate: number[] = []
      set(s => {
        const next = { ...s.reviews }
        for (const r of list) {
          // Не перезаписываем streaming/error entries в памяти данными из БД.
          // БД-версия — это «сохранённый факт ревью», память может содержать
          // живой стрим, который мы не должны затирать.
          if (next[r.id] && next[r.id].status !== 'done') continue
          if (!next[r.id]) {
            next[r.id] = {
              reviewChatId: r.id,
              parentChatId,
              providerId: r.providerId ?? 'unknown',
              model: r.model,
              content: '',
              status: 'done',
              createdAt: r.createdAt,
              noteCount: -1,
              findings: [],
              accepted: []
            }
            toHydrate.push(r.id)  // подгрузить сохранённый текст ревью ниже
          }
        }
        return { reviews: next }
      })
      // Гидратация content+findings из сохранённых сообщений review-чата (аудит
      // P0 #5): finalizeReview персистит текст ревью как assistant-сообщение
      // review-сессии. Без этого restored pill раскрывался пустым «фантомом».
      // Best-effort, по одному; повторно активный чат сверяем (анти-stale).
      for (const reviewChatId of toHydrate) {
        try {
          const msgs = await window.api.chats.list(reviewChatId)
          const content = [...msgs].reverse().find(mm => mm.role === 'assistant')?.content ?? ''
          if (!content.trim()) continue
          if (get().activeChatId !== parentChatId) return
          const firstLine = content.split('\n', 1)[0] ?? ''
          const m = firstLine.match(/ЗАМЕЧАНИЙ:\s*(\d+)/i)
          const noteCount = m ? parseInt(m[1], 10) : -1
          const findings = parseReviewFindings(content)
          set(s => {
            const cur = s.reviews[reviewChatId]
            if (!cur || cur.status !== 'done' || cur.content) return {}
            return { reviews: { ...s.reviews, [reviewChatId]: { ...cur, content, noteCount, findings } } }
          })
        } catch { /* гидратация best-effort — pill останется без содержимого */ }
      }
    } catch (err) {
      console.error('[store] refreshReviewsFor failed:', err)
    }
  },
  startReview: async ({ providerId, model, payload }) => {
    const s = get()
    if (!s.path || s.activeChatId == null) return null
    const parentChatId = s.activeChatId
    const reviewerLabel = providerId
    // 1. Создаём sub-chat в БД с kind='review' и привязкой к parent.
    let reviewChat
    try {
      reviewChat = await window.api.chatSessions.create(s.path, {
        title: `Review: ${reviewerLabel}`,
        providerId,
        model,
        kind: 'review',
        parentChatId
      })
    } catch (err) {
      console.error('[store] startReview create failed:', err)
      return null
    }
    // 2. Регистрируем ревью в локальном state СРАЗУ — pill в Timeline
    //    появится в статусе streaming.
    set(state => ({
      reviews: {
        ...state.reviews,
        [reviewChat.id]: {
          reviewChatId: reviewChat.id,
          parentChatId,
          providerId,
          model,
          content: '',
          status: 'streaming' as const,
          createdAt: Date.now(),
          noteCount: -1,
          findings: [],
          accepted: []
        }
      }
    }))
    // 2b. Логируем старт ревью в журнал проекта — это аудит-trail, чтобы
    //     потом можно было посмотреть когда / какой провайдер / каким был
    //     payload. Detail обрезаем до разумного размера.
    void window.api.journal.append(s.path, 'note',
      `🔍 Запущено ревью: ${providerId}`,
      payload.length > 500 ? payload.slice(0, 500) + '…' : payload
    ).catch(() => {})
    // 3. Стартуем ai:send с override провайдером + флагом useReviewerPrompt.
    //    Сам текст REVIEWER_SYSTEM_PROMPT живёт в electron/ai/ — renderer не
    //    может его импортнуть, поэтому шлём флаг, main process подставляет
    //    промпт сам (см. ipc/ai.ts).
    try {
      const sendId = await window.api.ai.sendWithOverrides(
        [{ role: 'user', content: payload }],
        s.path,
        {
          providerId,
          model,
          noTools: true,
          useReviewerPrompt: true
        }
      )
      // Grok audit fix: ai:send возвращает 0 если провайдер недоступен
      // (нет API key, не найден бинарь CLI, и т.п.). Error event улетел с
      // id=0 — наш routing его не словит, и pill повиснет в streaming.
      // Если sendId=0, сами помечаем review как failed с понятным сообщением.
      if (!sendId || sendId <= 0) {
        get().failReview(reviewChat.id,
          `Провайдер «${providerId}» недоступен (нет ключа, не установлен CLI, или другая ошибка инициализации). Проверь Settings.`)
        return reviewChat.id
      }
      get().registerSendOwner(sendId, { kind: 'review', reviewChatId: reviewChat.id, parentChatId })
      return reviewChat.id
    } catch (err) {
      console.error('[store] startReview sendWithOverrides failed:', err)
      get().failReview(reviewChat.id, err instanceof Error ? err.message : String(err))
      return reviewChat.id
    }
  },
  appendReviewContent: (reviewChatId, text) => set(s => {
    const r = s.reviews[reviewChatId]
    if (!r) return {}
    return { reviews: { ...s.reviews, [reviewChatId]: { ...r, content: r.content + text } } }
  }),
  finalizeReview: (reviewChatId) => {
    const r = get().reviews[reviewChatId]
    if (!r) return
    // Парсим «ЗАМЕЧАНИЙ: N» из первой строки (V1, на нём завязан pill noteCount).
    const firstLine = r.content.split('\n', 1)[0] ?? ''
    const m = firstLine.match(/ЗАМЕЧАНИЙ:\s*(\d+)/i)
    const noteCount = m ? parseInt(m[1], 10) : -1
    // V2: вытаскиваем структурированные findings из ```json блока (fallback на
    // старый текстовый формат внутри parseReviewFindings).
    const findings = parseReviewFindings(r.content)
    set(s => {
      const cur = s.reviews[reviewChatId]
      if (!cur) return {}
      return { reviews: { ...s.reviews, [reviewChatId]: { ...cur, status: 'done', noteCount, findings } } }
    })
    // Персист (аудит P0 #5): сохраняем текст ревью как сообщение review-чата,
    // чтобы после рестарта refreshReviewsFor восстановил content+findings, а не
    // показывал пустой «фантомный» pill. Best-effort.
    const path = get().path
    if (path && r.content.trim()) {
      void window.api.chats.append(reviewChatId, path, 'assistant', r.content).catch(() => {})
    }
  },
  toggleFinding: (reviewChatId, findingId) => set(s => {
    const r = s.reviews[reviewChatId]
    if (!r) return {}
    const accepted = r.accepted.includes(findingId)
      ? r.accepted.filter(id => id !== findingId)
      : [...r.accepted, findingId]
    return { reviews: { ...s.reviews, [reviewChatId]: { ...r, accepted } } }
  }),
  failReview: (reviewChatId, message) => set(s => {
    const r = s.reviews[reviewChatId]
    if (!r) return {}
    return { reviews: { ...s.reviews, [reviewChatId]: { ...r, status: 'error', errorMessage: message } } }
  }),
  toggleReviewPanel: (reviewChatId) => set(s => ({
    openedReviewId: s.openedReviewId === reviewChatId ? null : reviewChatId
  })),
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
  cleanupReviewsFor: (parentChatId) => set(s => {
    // Удаляем review entries этого main-чата + связанные sendOwners.
    // Закрываем openedReviewId если он был из этого чата.
    const nextReviews: typeof s.reviews = {}
    const removedIds = new Set<number>()
    for (const r of Object.values(s.reviews)) {
      if (r.parentChatId === parentChatId) {
        removedIds.add(r.reviewChatId)
      } else {
        nextReviews[r.reviewChatId] = r
      }
    }
    // Drain sendOwners: убираем review-owner'ы удалённых чатов + chat-owner
    // самого parentChatId (если main чат удалён, его in-flight sendId
    // больше некуда роутить).
    const nextOwners: typeof s.sendOwners = {}
    for (const [sid, owner] of Object.entries(s.sendOwners)) {
      if (owner.kind === 'review' && removedIds.has(owner.reviewChatId)) continue
      if (owner.kind === 'chat' && owner.chatId === parentChatId) continue
      nextOwners[Number(sid)] = owner
    }
    return {
      reviews: nextReviews,
      sendOwners: nextOwners,
      openedReviewId: (s.openedReviewId != null && removedIds.has(s.openedReviewId)) ? null : s.openedReviewId
    }
  })
}))

// Re-export pure session types из нового модуля, чтобы публичная поверхность
// projectStore не менялась (ActivityEntry/PendingCommand/SessionUsage/TouchKind
// раньше экспортировались отсюда).
export type { ActivityEntry, PendingCommand, SessionUsage, TouchKind }
