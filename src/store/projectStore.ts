import { create } from 'zustand'
import type { FileNode, ChatMessage, ProjectMeta, ChatSession } from '../types/api'

interface PendingWrite {
  callId: string
  path: string
  before: string
  after: string
}

interface PendingCommand {
  callId: string
  command: string
}

interface ActivityEntry {
  id: string
  kind: 'read' | 'list' | 'write' | 'command' | 'blocked'
  label: string
  detail?: string
  status: 'pending' | 'ok' | 'rejected' | 'error' | 'blocked'
  timestamp: number
}

export type ViewId = 'chat' | 'tasks' | 'journal' | 'plan' | 'workflow' | 'calendar' | 'feedback'

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
  setProject: (path: string) => Promise<void>
  closeProject: () => void
  refreshProjectList: () => Promise<void>
  removeProject: (path: string) => Promise<void>
  setActiveView: (v: ViewId) => void
  addMessage: (msg: ChatMessage) => void
  updateLastAssistant: (text: string) => void
  setStreaming: (v: boolean) => void
  addPendingWrite: (w: PendingWrite) => void
  resolvePendingWrite: (callId: string) => void
  clearPendingWrites: () => void
  setPendingCommand: (c: PendingCommand | null) => void
  pushActivity: (entry: ActivityEntry) => void
  updateActivity: (id: string, patch: Partial<ActivityEntry>) => void
  clearActivity: () => void
  addUsage: (delta: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }) => void
  resetUsage: () => void
  setRunningPlanStep: (s: RunningPlanStep | null) => void
  /** Apply an ai:event to a background session (used when projectPath !== current). */
  applyEventToSession: (projectPath: string, event: { type: string; [k: string]: unknown }) => void
  /** Mark a session as read (clear the unread badge). */
  markSessionRead: (projectPath: string) => void
  /** Switch to a different chat session within the active project. */
  switchChatSession: (id: number) => Promise<void>
  /** Refresh the chat sessions list (after create/rename/delete). */
  refreshChatSessions: () => Promise<void>
  /** Create a new chat session in the active project and switch to it. */
  newChatSession: (title?: string) => Promise<ChatSession | null>
}

export const useProject = create<ProjectState>((set, get) => ({
  path: null,
  tree: [],
  messages: [],
  isStreaming: false,
  pendingWrites: [],
  pendingCommand: null,
  activity: [],
  activeView: 'chat',
  sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  runningPlanStep: null,
  projectList: [],
  chatSessions: [],
  activeChatId: null,
  sessions: {},
  setProject: async (path) => {
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
    await window.api.projects.setCurrent(path)
    const projectList = await window.api.projects.list()
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
    if (chatSessions.length === 0) {
      const created = await window.api.chatSessions.create(path, { title: 'Основной чат' })
      chatSessions = [created]
    }
    // Pick the most recent active session (top of list)
    const activeChatId = chatSessions[0]?.id ?? null
    if (activeChatId && !existing) {
      const history = await window.api.chats.list(activeChatId)
      target.messages = history.map(m => ({ role: m.role, content: m.content }))
    }

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
      sessions: nextSessions
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
    const history = await window.api.chats.list(id)
    set({
      activeChatId: id,
      messages: history.map(m => ({ role: m.role, content: m.content })),
      activity: [],
      pendingWrites: [],
      pendingCommand: null,
      runningPlanStep: null
    })
  },
  refreshChatSessions: async () => {
    const s = get()
    if (!s.path) return
    const list = await window.api.chatSessions.list(s.path)
    set({ chatSessions: list })
  },
  newChatSession: async (title) => {
    const s = get()
    if (!s.path) return null
    const created = await window.api.chatSessions.create(s.path, { title })
    const list = await window.api.chatSessions.list(s.path)
    set({
      chatSessions: list,
      activeChatId: created.id,
      messages: [],
      activity: [],
      pendingWrites: [],
      pendingCommand: null,
      runningPlanStep: null
    })
    return created
  }
}))

export type { ActivityEntry, PendingCommand }
