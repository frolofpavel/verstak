export interface FileNode { name: string; path: string; isDirectory: boolean; children?: FileNode[] }
export interface Attachment { name: string; mimeType: string; data: string; size: number }
export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; attachments?: Attachment[]; thinking?: string }
export interface StoredChatMessage { id: number; role: 'user' | 'assistant' | 'system'; content: string; createdAt: number }
export interface ChatSession { id: number; projectPath: string; title: string; providerId: string | null; model: string | null; createdAt: number; lastMessageAt: number }
export interface Task { id: number; text: string; done: boolean; createdAt: number; doneAt: number | null }
export type JournalKind = 'manual' | 'session' | 'tool' | 'note'
export interface JournalEntry { id: number; kind: JournalKind; title: string; detail: string | null; createdAt: number }
export interface UndoEntry { id: number; filePath: string; beforeContent: string | null; afterContent: string | null; createdAt: number }
export type PlanStatus = 'draft' | 'running' | 'done' | 'cancelled'
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export interface PlanStep { id: number; planId: number; idx: number; title: string; detail: string | null; status: StepStatus; result: string | null }
export interface Plan { id: number; title: string; status: PlanStatus; createdAt: number; completedAt: number | null; steps: PlanStep[] }
export interface FeedbackEntry { id: number; projectPath: string | null; providerId: string | null; rating: number | null; message: string; createdAt: number }
export interface ProjectMeta { path: string; name: string; color: string; lastOpenedAt: number }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface UsageDelta {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  model?: string
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'pending-write'; callId: string; path: string; before: string; after: string }
  | { type: 'pending-command'; callId: string; command: string }
  | { type: 'command-result'; callId: string; command: string; status: 'ok' | 'error' | 'rejected'; exitCode?: number; stdout?: string; stderr?: string; error?: string }
  | { type: 'tool-blocked'; callId: string; name: string; command?: string; reason: string }
  | { type: 'turns-exhausted'; used: number; maxBudget: number; canContinue: boolean; suggestedAdd: number }
  | { type: 'tool-activity'; callId: string; name: string; label: string; detail: string; status: 'ok' | 'error' }
  | { type: 'plan-created'; planId: number; title: string; stepCount: number }
  | { type: 'usage'; usage: UsageDelta }
  | { type: 'done' }
  | { type: 'error'; message: string }

declare global {
  interface Window {
    api: {
      projects: {
        pick: () => Promise<string | null>
        setCurrent: (path: string | null) => Promise<void>
        list: () => Promise<ProjectMeta[]>
        rename: (path: string, name: string) => Promise<void>
        remove: (path: string) => Promise<void>
      }
      files: {
        tree: (root: string) => Promise<FileNode[]>
        read: (path: string) => Promise<string>
      }
      settings: {
        getKey: (key: string) => Promise<string | null>
        setKey: (key: string, value: string) => Promise<void>
      }
      ai: {
        send: (messages: ChatMessage[], projectPath: string | null) => Promise<number>
        sendWithBudget: (messages: ChatMessage[], projectPath: string | null, budget: number) => Promise<number>
        resolveWrite: (callId: string, accept: boolean, sendId?: number) => Promise<void>
        resolveCommand: (callId: string, accept: boolean, sendId?: number) => Promise<void>
        stop: (sendId: number) => Promise<boolean>
        countTokens: (text: string, projectPath: string | null, historyMessages?: ChatMessage[]) => Promise<{ tokens: number; exact: boolean; providerId: string }>
        onEvent: (cb: (data: { id: number; event: ChatEvent; projectPath: string | null }) => void) => () => void
      }
      chatSessions: {
        list: (projectPath: string) => Promise<ChatSession[]>
        create: (projectPath: string, opts?: { title?: string; providerId?: string | null; model?: string | null }) => Promise<ChatSession>
        rename: (id: number, title: string) => Promise<void>
        setModel: (id: number, providerId: string | null, model: string | null) => Promise<void>
        remove: (id: number) => Promise<void>
      }
      chats: {
        list: (sessionId: number) => Promise<StoredChatMessage[]>
        append: (sessionId: number, projectPath: string, role: 'user' | 'assistant', content: string) => Promise<void>
      }
      tasks: {
        list: (projectPath: string) => Promise<Task[]>
        add: (projectPath: string, text: string) => Promise<Task>
        toggle: (id: number, done: boolean) => Promise<void>
        remove: (id: number) => Promise<void>
        clearDone: (projectPath: string) => Promise<number>
      }
      journal: {
        list: (projectPath: string, limit?: number) => Promise<JournalEntry[]>
        append: (projectPath: string, kind: JournalKind, title: string, detail?: string | null) => Promise<JournalEntry>
        remove: (id: number) => Promise<void>
        clear: (projectPath: string) => Promise<number>
      }
      undo: {
        list: (projectPath: string) => Promise<UndoEntry[]>
        count: (projectPath: string) => Promise<number>
        clear: (projectPath: string) => Promise<number>
        revert: (projectPath: string, id?: number) => Promise<{ ok: boolean; filePath?: string; reason?: string }>
      }
      feedback: {
        list: (projectPath: string | null, limit?: number) => Promise<FeedbackEntry[]>
        submit: (input: { projectPath: string | null; providerId: string | null; rating: number | null; message: string }) => Promise<FeedbackEntry>
        remove: (id: number) => Promise<void>
      }
      plans: {
        list: (projectPath: string) => Promise<Plan[]>
        get: (id: number) => Promise<Plan | null>
        create: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) => Promise<Plan>
        setStatus: (id: number, status: PlanStatus) => Promise<void>
        updateStep: (id: number, patch: { status?: StepStatus; result?: string | null }) => Promise<void>
        remove: (id: number) => Promise<void>
      }
      verify: {
        exec: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
      }
      term: {
        spawn: (cwd: string) => Promise<number>
        write: (id: number, data: string) => Promise<void>
        resize: (id: number, cols: number, rows: number) => Promise<void>
        kill: (id: number) => Promise<void>
        onData: (cb: (data: { id: number; data: string }) => void) => () => void
        onExit: (cb: (data: { id: number }) => void) => () => void
      }
      autonomous: {
        status: () => Promise<AutonomousStatus>
        runOnce: () => Promise<AutonomousStatus>
        start: (intervalMin: number) => Promise<AutonomousStatus>
        stop: () => Promise<AutonomousStatus>
      }
    }
  }
}
export interface AutonomousStatus {
  enabled: boolean
  intervalMin: number
  lastRunAt: number | null
  lastRunSuggestions: number
  lastRunError: string | null
  nextRunAt: number | null
}
export {}
