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
  'claude': ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20251101', 'claude-haiku-4-5-20251101'],
  'claude-cli': ['auto', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-5'],
  'grok': ['grok-4', 'grok-4-fast', 'grok-3'],
  'grok-cli': ['auto', 'grok-4', 'grok-4-fast', 'grok-code-fast-1', 'grok-3'],
  'openai': ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
  'codex-cli': ['auto', 'gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini', 'gpt-4o']
}
function isModelValidForProvider(providerId: string, model: string): boolean {
  const allowed = PROVIDER_MODEL_MAP[providerId]
  return !!allowed && allowed.includes(model)
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

export type ViewId = 'chat' | 'tasks' | 'journal' | 'plan' | 'workflow' | 'calendar' | 'feedback' | 'browser'

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
  /** Map of in-flight sendId → chatSessionId that initiated it. Used to route
   *  ai:event for backgrounded chats into the correct snapshot. */
  sendIdToChatId: Record<number, number>
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
  /** Bind an in-flight send (sendId) to the chat session that started it. */
  registerSend: (sendId: number, chatId: number) => void
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
  sendIdToChatId: {},
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
      checkpointId: null
    })
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
      chatSnapshots: nextSnapshots
    })
  },
  registerSend: (sendId, chatId) => set(s => ({
    sendIdToChatId: { ...s.sendIdToChatId, [sendId]: chatId }
  })),
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
   * refetch the whole list. Pavel feedback 2026-05-21: переименование чата
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
      checkpointId: null
    })
    return created
  }
}))

export type { ActivityEntry, PendingCommand }
