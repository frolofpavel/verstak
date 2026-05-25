export interface FileNode { name: string; path: string; isDirectory: boolean; children?: FileNode[] }
export interface Attachment { name: string; mimeType: string; data: string; size: number }
export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; attachments?: Attachment[]; thinking?: string }
export interface StoredChatMessage { id: number; role: 'user' | 'assistant' | 'system'; content: string; createdAt: number }
export type ChatKind = 'main' | 'review'
export interface ChatSession {
  id: number
  projectPath: string
  title: string
  providerId: string | null
  model: string | null
  createdAt: number
  lastMessageAt: number
  kind: ChatKind
  parentChatId: number | null
}
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

/** User profile — multi-user поддержка команды агентства (14 человек). */
export interface UserProfile {
  id: number
  name: string
  role: string | null
  defaultProvider: string | null
  defaultModel: string | null
  skillsEnabled: string[] | null
  createdAt: number
  isActive: boolean
}

/** Skill — переиспользуемый агентский пресет (system prompt + tools + provider).
 *  См. electron/ai/skills/types.ts для серверной структуры. */
export interface Skill {
  id: string
  name?: string
  description?: string
  icon?: string
  default_provider?: string
  default_model?: string
  default_mode?: 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'
  slash?: string
  tools_allow?: string[]
  suggested_prompts?: string[]
  context_loaders?: Array<{ id: string; impl: string; runs_on: 'chat_open' | 'slash_arg'; args?: Record<string, unknown> }>
  systemPrompt: string
  source: 'server' | 'user' | 'built-in'
  sourceRef: string
}
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
  | { type: 'artifact-created'; callId: string; kind: 'html' | 'docx'; filename: string; path: string; sizeBytes: number }
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
        /** Открыть папку в системном проводнике через electron.shell.openPath. */
        revealInExplorer: (path: string) => Promise<{ ok: boolean; error: string | null }>
        /** Конвертация DOCX → HTML body через mammoth.js (для embedded preview). */
        docxToHtml: (path: string) => Promise<{ ok: true; html: string; warnings: string[] } | { ok: false; error: string }>
      }
      settings: {
        getKey: (key: string) => Promise<string | null>
        setKey: (key: string, value: string) => Promise<void>
      }
      ai: {
        send: (messages: ChatMessage[], projectPath: string | null) => Promise<number>
        sendWithBudget: (messages: ChatMessage[], projectPath: string | null, budget: number) => Promise<number>
        sendWithOverrides: (
          messages: ChatMessage[],
          projectPath: string | null,
          overrides: { providerId?: string; model?: string | null; noTools?: boolean; systemPrompt?: string; useReviewerPrompt?: boolean }
        ) => Promise<number>
        resolveWrite: (callId: string, accept: boolean, sendId?: number) => Promise<void>
        resolveCommand: (callId: string, accept: boolean, sendId?: number) => Promise<void>
        stop: (sendId: number) => Promise<boolean>
        countTokens: (text: string, projectPath: string | null, historyMessages?: ChatMessage[]) => Promise<{ tokens: number; exact: boolean; providerId: string }>
        onEvent: (cb: (data: { id: number; event: ChatEvent; projectPath: string | null }) => void) => () => void
      }
      chatSessions: {
        list: (projectPath: string) => Promise<ChatSession[]>
        listReviews: (parentChatId: number) => Promise<ChatSession[]>
        create: (projectPath: string, opts?: {
          title?: string
          providerId?: string | null
          model?: string | null
          kind?: ChatKind
          parentChatId?: number | null
        }) => Promise<ChatSession>
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
        /** Snap a checkpoint. Returns the id of the newest entry, or 0 if
         *  the stack is currently empty (0 is below any real autoincrement
         *  id, so `id > 0` naturally matches every future entry). */
        checkpoint: (projectPath: string) => Promise<number>
        /** Revert every entry with id > checkpointId. */
        revertToCheckpoint: (projectPath: string, checkpointId: number) => Promise<{
          ok: boolean
          restored: string[]
          count: number
          failed?: Array<{ id: number; filePath: string; reason: string }>
        }>
      }
      skills: {
        list: () => Promise<Skill[]>
        get: (id: string) => Promise<Skill | null>
        refresh: () => Promise<{ added: number; updated: number; failed: string[] }>
        status: () => Promise<{ lastRefreshAt: number | null; serverReachable: boolean; total: number }>
        runLoaders: (skillId: string, opts: { arg?: string; projectPath?: string | null; trigger: 'chat_open' | 'slash_arg' }) =>
          Promise<{ context: string; labels: string[] }>
      }
      cliAuth: {
        logout: (providerId: string) => Promise<{
          ok: boolean
          method: 'logout-cmd' | 'creds-deleted' | 'both'
          removedFiles: string[]
          stdout?: string
          stderr?: string
          message?: string
        }>
        relogin: (providerId: string) => Promise<{
          ok: boolean
          message?: string
          command?: string
        }>
        statusAll: () => Promise<Record<'claude-cli' | 'gemini-cli' | 'grok-cli' | 'codex-cli', {
          installed: boolean
          loggedIn: boolean
          credPath?: string
        }>>
      }
      userProfiles: {
        list: () => Promise<UserProfile[]>
        getActive: () => Promise<UserProfile | null>
        create: (input: { name: string; role?: string; defaultProvider?: string; defaultModel?: string; skillsEnabled?: string[] }) => Promise<UserProfile>
        setActive: (id: number) => Promise<void>
        update: (id: number, patch: { name?: string; role?: string; defaultProvider?: string; defaultModel?: string; skillsEnabled?: string[] }) => Promise<void>
        remove: (id: number) => Promise<void>
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
      memory: {
        save(projectPath: string, type: string, content: string, tags: string[]): Promise<Memory>
        search(projectPath: string, query: string, limit?: number): Promise<Memory[]>
        list(projectPath: string): Promise<Memory[]>
        delete(id: string): Promise<boolean>
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
        onErrorDetected: (cb: (data: { id: number; error: { kind: string; file?: string; line?: number; message: string; raw: string } }) => void) => () => void
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
/** Воспоминание агента — факт, решение, баг или паттерн, привязанный к проекту. */
export interface Memory {
  id: string
  project_path: string
  type: 'fact' | 'decision' | 'bug' | 'preference' | 'pattern'
  content: string
  tags: string[]
  created_at: number
  accessed_at: number
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
