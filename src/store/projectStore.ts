import { create } from 'zustand'
import type { FileNode, ChatMessage, ProjectMeta, ChatSession } from '../types/api'

/**
 * Sanity check for stored chat-session (providerId, model) pairs.
 * Earlier bug: switching provider in ModelPicker saved the OLD provider's
 * model on the new provider's session entry (e.g. claude-cli + gemini-3.5-flash).
 * This guard rejects such impossible pairs at switch time.
 */
const PROVIDER_MODEL_MAP: Record<string, string[]> = {
  'gemini-api': ['gemini-3-pro', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'gemini-cli': ['auto', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'claude': ['claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  'claude-cli': ['auto', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-5'],
  'grok': ['grok-4', 'grok-4-fast', 'grok-3'],
  'grok-cli': ['auto', 'grok-4', 'grok-4-fast', 'grok-code-fast-1', 'grok-3'],
  'openai': ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
  'codex-cli': ['auto', 'gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini', 'gpt-4o'],
  // Российские провайдеры
  'yandex-gpt': ['yandexgpt/latest', 'yandexgpt-lite/latest', 'yandexgpt-32k/latest'],
  'gigachat': ['GigaChat', 'GigaChat-Plus', 'GigaChat-Pro', 'GigaChat-Max'],
  // OpenAI-compatible extra-провайдеры (зеркало EXTRA_PROVIDERS в main)
  'openrouter': ['anthropic/claude-opus-4-5', 'anthropic/claude-sonnet-4-6', 'openai/gpt-5', 'openai/gpt-5-mini', 'google/gemini-3-pro', 'google/gemini-3.5-flash', 'x-ai/grok-4', 'deepseek/deepseek-v3', 'meta-llama/llama-3.3-70b-instruct'],
  'deepseek': ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
  'mistral': ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest', 'ministral-8b-latest'],
  'groq': ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
  'ollama': ['llama3.3', 'qwen2.5-coder', 'deepseek-r1', 'mistral', 'gemma2'],
  'custom-openai': []  // Заполняется пользователем — любая модель валидна
}
function isModelValidForProvider(providerId: string, model: string): boolean {
  const allowed = PROVIDER_MODEL_MAP[providerId]
  if (allowed === undefined) return false
  // custom-openai: пользователь задаёт модели сам — любая непустая строка валидна
  if (allowed.length === 0) return model.length > 0
  return allowed.includes(model)
}

interface PendingWrite {
  callId: string
  path: string
  before: string
  after: string
  /** sendId of the ai:send that produced this write — used for strict
   *  resolveWrite lookup in main (avoids endsWith-based collisions). */
  sendId?: number
}

interface PendingCommand {
  callId: string
  command: string
  /** sendId for strict resolve lookup. */
  sendId?: number
}

interface ActivityEntry {
  id: string
  kind: 'read' | 'list' | 'write' | 'command' | 'blocked'
  label: string
  detail?: string
  status: 'pending' | 'ok' | 'rejected' | 'error' | 'blocked'
  timestamp: number
}

/**
 * Marker shown next to a file in the project tree to indicate that the AI
 * has touched it during the current session. Priority: write > read > list.
 * Recorded per project-relative path so the Sidebar can render a small badge.
 */
export type TouchKind = 'read' | 'write' | 'list'
const TOUCH_PRIORITY: Record<TouchKind, number> = { write: 3, read: 2, list: 1 }

export type ViewId = 'chat' | 'tasks' | 'journal' | 'plan' | 'workflow' | 'calendar' | 'feedback' | 'browser' | 'skills' | 'design' | 'video'

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

interface RunningPlanStep {
  planId: number
  stepId: number
  title: string
}

interface SessionSnapshot {
  messages: ChatMessage[]
  isStreaming: boolean
  pendingWrites: PendingWrite[]
  pendingCommand: PendingCommand | null
  activity: ActivityEntry[]
  sessionUsage: SessionUsage
  runningPlanStep: RunningPlanStep | null
  /** True when bg session got new content since user last viewed it. */
  hasUnread: boolean
}

function freshSnapshot(): SessionSnapshot {
  return {
    messages: [],
    isStreaming: false,
    pendingWrites: [],
    pendingCommand: null,
    activity: [],
    sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    runningPlanStep: null,
    hasUnread: false
  }
}

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
}

interface ProjectState {
  path: string | null
  tree: FileNode[]
  messages: ChatMessage[]
  isStreaming: boolean
  pendingWrites: PendingWrite[]
  pendingCommand: PendingCommand | null
  activity: ActivityEntry[]
  /** Per-session "the AI has touched these files" map — feeds Sidebar markers
   *  (Gemini Ultra audit: Context Depth Visualizer). Keyed by project-relative
   *  path; value is the highest-priority kind observed. */
  touchedFiles: Record<string, TouchKind>
  /** Undo entry ID at the moment the user pressed "📍 Чекпоинт". Revert-to-
   *  checkpoint pops every entry whose id > this until back at this mark.
   *  Null when no checkpoint set. */
  checkpointId: number | null
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
  artifacts: Array<{ kind: 'html' | 'docx'; filename: string; path: string; sizeBytes: number; ts: number }>
  /** Текущий артефакт открытый в preview pane (path как ID). null = закрыт. */
  previewArtifactId: string | null
  setProject: (path: string) => Promise<void>
  closeProject: () => void
  refreshProjectList: () => Promise<void>
  removeProject: (path: string) => Promise<void>
  setActiveView: (v: ViewId) => void
  addMessage: (msg: ChatMessage) => void
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
  /** Record that the AI just touched a file (read / write / list). Upgrades
   *  the marker if a higher-priority kind is observed. */
  markFileTouched: (path: string, kind: TouchKind) => void
  clearTouchedFiles: () => void
  /** Snap a checkpoint at the current undo head. Subsequent writes can be
   *  rolled back to this mark in one click. */
  setCheckpoint: (id: number | null) => void
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
  /** Финализировать ревью: парсит noteCount, status='done'. */
  finalizeReview: (reviewChatId: number) => void
  /** Помечает ревью как failed. */
  failReview: (reviewChatId: number, message: string) => void
  /** Раскрыть/свернуть review panel. */
  toggleReviewPanel: (reviewChatId: number | null) => void
  /** Очистить in-memory review state для удалённого main-чата. */
  cleanupReviewsFor: (parentChatId: number) => void
  /** Зарегистрировать сгенерированный артефакт (для Timeline pill). */
  recordArtifact: (a: { kind: 'html' | 'docx'; filename: string; path: string; sizeBytes: number }) => void
  /** Сбросить артефакты (вызывается при смене чата / нового чата). */
  clearArtifacts: () => void
  /** Открыть preview панель для артефакта (по path как ID), или закрыть (null). */
  setPreviewArtifact: (path: string | null) => void
  /** Уровень усилий модели. Влияет на max_tokens / extended thinking. */
  effortLevel: 'quick' | 'standard' | 'deep'
  setEffortLevel: (level: 'quick' | 'standard' | 'deep') => void
}

// Monotonic token used by setProject to cancel its own stale concurrent runs.
// If the user clicks project A then project B before A's async work finishes,
// only B's set() should land. We bump on entry, snapshot the value, and bail
// on every await boundary if our token is no longer current.
let setProjectToken = 0

export const useProject = create<ProjectState>((set, get) => ({
  path: null,
  tree: [],
  messages: [],
  isStreaming: false,
  pendingWrites: [],
  pendingCommand: null,
  activity: [],
  touchedFiles: {},
  checkpointId: null,
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
    // 2) Build the target snapshot — either restore from sessions or seed from chat history
    const tree = await window.api.files.tree(path)
    if (myToken !== setProjectToken) return  // a newer setProject took over
    await window.api.projects.setCurrent(path)
    if (myToken !== setProjectToken) return
    const projectList = await window.api.projects.list()
    if (myToken !== setProjectToken) return
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

    // Load chat sessions list. Create a default one if project has none yet.
    let chatSessions = await window.api.chatSessions.list(path)
    if (myToken !== setProjectToken) return
    if (chatSessions.length === 0) {
      const created = await window.api.chatSessions.create(path, { title: 'Основной чат' })
      if (myToken !== setProjectToken) return
      chatSessions = [created]
    }
    // Pick the most recent active session (top of list)
    const activeChatId = chatSessions[0]?.id ?? null
    if (activeChatId && !existing) {
      const history = await window.api.chats.list(activeChatId)
      if (myToken !== setProjectToken) return
      target.messages = history.map(m => ({ role: m.role, content: m.content }))
    }

    if (myToken !== setProjectToken) return  // final safety before commit
    set({
      path,
      tree,
      messages: target.messages,
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
      // Сбрасываем chatSnapshots — при смене проекта снапшоты предыдущего
      // проекта не должны просачиваться если SQLite autoincrement ID пересекутся.
      chatSnapshots: {},
      // Сбрасываем reviews из памяти — для нового проекта подгружаем заново
      // через refreshReviewsFor (ниже).
      reviews: {},
      openedReviewId: null,
      artifacts: []
    })
    // Подгружаем ревью для активного чата (если есть). Fire-and-forget.
    if (activeChatId != null) {
      void get().refreshReviewsFor(activeChatId)
    }
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
  removeProject: async (path: string) => {
    await window.api.projects.remove(path)
    const projectList = await window.api.projects.list()
    const state = get()
    if (state.path === path) {
      set({ path: null, tree: [], messages: [], projectList })
    } else {
      set({ projectList })
    }
  },
  setActiveView: (v) => set({ activeView: v }),
  addMessage: (msg) => set(s => ({ messages: [...s.messages, msg] })),
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
  clearActivity: () => set({ activity: [] }),
  markFileTouched: (path, kind) => set(s => {
    if (!path) return {}
    const existing = s.touchedFiles[path]
    if (existing && TOUCH_PRIORITY[existing] >= TOUCH_PRIORITY[kind]) return {}
    return { touchedFiles: { ...s.touchedFiles, [path]: kind } }
  }),
  clearTouchedFiles: () => set({ touchedFiles: {} }),
  setCheckpoint: (id) => set({ checkpointId: id }),
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
    const s = get()
    if (!s.path) return
    // 1) Snapshot CURRENT chat state so its in-flight stream survives the
    //    switch. Do NOT call ai.stop — events for the old sendId will be
    //    routed into chatSnapshots[oldChatId] by Chat.tsx event handler.
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
    // 2) Restore target — from snapshot if it has one (chat was backgrounded
    //    earlier in this session), otherwise load history from DB.
    const restored = nextSnapshots[id]
    let messages: ChatMessage[]
    let isStreaming = false
    let pendingWrites: PendingWrite[] = []
    let pendingCommand: PendingCommand | null = null
    let activity: ActivityEntry[] = []
    let sessionUsage: SessionUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
    let runningPlanStep: RunningPlanStep | null = null
    if (restored) {
      messages = restored.messages
      isStreaming = restored.isStreaming
      pendingWrites = restored.pendingWrites
      pendingCommand = restored.pendingCommand
      activity = restored.activity
      sessionUsage = restored.sessionUsage
      runningPlanStep = restored.runningPlanStep
      delete nextSnapshots[id]  // it becomes active, no need to keep snapshot
    } else {
      const history = await window.api.chats.list(id)
      messages = history.map(m => ({ role: m.role, content: m.content }))
    }
    // Per-chat provider: if the session has providerId / model saved, apply
    // them to the global settings so the next ai:send uses that provider.
    // Sanity check: if stored (providerId, model) pair is invalid (e.g. older
    // bug saved gemini's model on a claude session), drop the model so
    // useProvider falls back to the provider's default.
    const session = s.chatSessions.find(c => c.id === id)
    if (session?.providerId) {
      try {
        await window.api.settings.setKey('provider', session.providerId)
        if (session.model && isModelValidForProvider(session.providerId, session.model)) {
          await window.api.settings.setKey(`model_${session.providerId}`, session.model)
        } else if (session.model) {
          // Clear stale/invalid model — useProvider will pick the default
          await window.api.settings.setKey(`model_${session.providerId}`, '')
          await window.api.chatSessions.setModel(id, session.providerId, null)
        }
      } catch { /* settings write failure shouldn't block chat switch */ }
    }
    set({
      activeChatId: id,
      messages,
      isStreaming,
      pendingWrites,
      pendingCommand,
      activity,
      sessionUsage,
      runningPlanStep,
      chatSnapshots: nextSnapshots,
      // Grok audit fix: openedReviewId переживал смену чата и мог показать
      // панель чужого ревью. Сбрасываем при каждом switch.
      openedReviewId: null
    })
    // Подгружаем review sub-chats этого main-чата (fire-and-forget — pills
    // появятся когда подгрузятся; основная навигация не блокируется).
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
      set(s => {
        const next = { ...s.reviews }
        for (const r of list) {
          // Не перезаписываем streaming/error entries в памяти данными из БД.
          // БД-версия — это «сохранённый факт ревью», память может содержать
          // живой стрим, который мы не должны затирать.
          if (next[r.id] && next[r.id].status !== 'done') continue
          next[r.id] = next[r.id] ?? {
            reviewChatId: r.id,
            parentChatId,
            providerId: r.providerId ?? 'unknown',
            model: r.model,
            content: '',
            // V1: текст ревью НЕ сохраняем в chats — он живёт только в памяти
            // до перезапуска. При перезапуске restored entries имеют пустой
            // content и noteCount=-1 (запись в chat_sessions с kind='review'
            // остаётся для аудита).
            status: 'done',
            createdAt: r.createdAt,
            noteCount: -1
          }
        }
        return { reviews: next }
      })
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
          noteCount: -1
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
  finalizeReview: (reviewChatId) => set(s => {
    const r = s.reviews[reviewChatId]
    if (!r) return {}
    // Парсим «ЗАМЕЧАНИЙ: N» из первой строки.
    const firstLine = r.content.split('\n', 1)[0] ?? ''
    const m = firstLine.match(/ЗАМЕЧАНИЙ:\s*(\d+)/i)
    const noteCount = m ? parseInt(m[1], 10) : -1
    return { reviews: { ...s.reviews, [reviewChatId]: { ...r, status: 'done', noteCount } } }
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
  clearArtifacts: () => set({ artifacts: [], previewArtifactId: null }),
  setPreviewArtifact: (path) => set({ previewArtifactId: path }),
  setEffortLevel: (level) => set({ effortLevel: level }),
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

export type { ActivityEntry, PendingCommand }
