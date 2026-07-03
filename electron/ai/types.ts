export type Role = 'user' | 'assistant' | 'system'

export interface Attachment {
  /** Display name (file name or auto-generated like "Скриншот 1.png") */
  name: string
  /** MIME type, e.g. "image/png", "application/pdf", "text/plain" */
  mimeType: string
  /** Base64-encoded raw bytes (without data:URL prefix) */
  data: string
  /** Decoded byte size, for UI display */
  size: number
}

export interface ChatMessage {
  role: Role
  content: string
  attachments?: Attachment[]
  /** Tool calls emitted by the assistant (only set on assistant messages). */
  toolCalls?: ToolCall[]
  /** Tool results being fed back to the assistant (only set on user messages
   *  that exist to carry these results — content may be empty). */
  toolResults?: ToolResult[]
  /** Model's internal reasoning / chain-of-thought (Gemini 3 thought parts,
   *  Claude extended thinking, OpenAI o1 reasoning). Rendered as a
   *  collapsible block in the chat, not part of the visible answer. */
  thinking?: string
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /**
   * Provider-specific opaque token that some models (Gemini 3+) require to be
   * sent back unchanged on the next turn so they can correlate the tool result
   * with their internal "thought" reasoning. We treat it as opaque and just
   * round-trip it.
   */
  thoughtSignature?: string
  /**
   * Native tool-call пришёл, но `arguments` не распарсились в JSON (модель отдала
   * битый/оборванный JSON). Раньше это молча превращалось в `args: {}` → тулза
   * исполнялась с пустыми аргументами. Теперь агентный цикл видит typed-причину и
   * делает bounded corrective retry «повтори вызов валидным JSON» (Этап 2).
   */
  argsError?: 'malformed_json'
}

export interface ToolResult {
  id: string
  /** Tool call name (some providers — Claude — don't require it, others — Gemini — do). */
  name: string
  /** Whatever the tool returned; will be JSON-stringified before sending. */
  result: unknown
  /** If the tool failed, the error message. When set, `result` is the error context. */
  error?: string
  /** Файлы, реально записанные тулзой (propose_edits — принятые правки). agent-loop
   *  добавляет их в filesTouched для attest-сверки claimed-vs-actual (#12). */
  filesWritten?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}

export interface UsageDelta {
  /** Tokens in the prompt for this turn */
  inputTokens?: number
  /** Tokens produced by the model in this turn */
  outputTokens?: number
  /** Tokens already cached on the provider side (Anthropic / OpenAI) */
  cachedInputTokens?: number
  /** Tokens записанные В кэш на этом ходу (Anthropic cache write, ~1.25× цены input).
   *  Нужен для честной оценки стоимости 1-го хода в cost-controller. */
  cacheCreationInputTokens?: number
  /** Model that produced the usage, helps cost lookup */
  model?: string
}

export type ChatEvent =
  | { type: 'text'; text: string }
  /** Model's internal reasoning. Streamed separately from text so the UI
   *  can render it as a collapsible block. */
  | { type: 'thought'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'pending-write'; callId: string; path: string; before: string; after: string }
  | { type: 'pending-command'; callId: string; command: string }
  | { type: 'command-result'; callId: string; command: string; status: 'ok' | 'error' | 'rejected'; exitCode?: number; stdout?: string; stderr?: string; error?: string }
  | { type: 'tool-blocked'; callId: string; name: string; command?: string; reason: string }
  | { type: 'plan-created'; planId: number; title: string; stepCount: number }
  | { type: 'plan-approval'; callId: string; planId: number; title: string; stepCount: number }
  /** Preflight: агент объявил план перед сложной/деструктивной задачей.
   *  Эфемерное — карточка в чате, в БД не пишется. */
  | { type: 'preflight'; callId: string; summary: string; affectedZones: string[]; risk: 'low' | 'medium' | 'high'; riskReason: string; verifyAfter: string[]; outOfScope: string[] }
  /** Sub-agent run: delegate_task делегировал подзадачу другому скиллу/модели.
   *  Эфемерное — карточка в чате для видимости fan-out. В БД не пишется. */
  | { type: 'subagent-run'; callId: string; label: string; provider?: string; skill?: string; task: string; status: 'running' | 'done' | 'error'; result?: string; role?: string; toolCount?: number; swarm?: string }
  | { type: 'artifact-created'; callId: string; kind: 'html' | 'docx' | 'verification'; filename: string; path: string; sizeBytes: number }
  /** Verification attested: attest_verification перепрогнал проверки и собрал DoD-артефакт.
   *  Эфемерный бейдж для UI (overall + N/M); БД-персист — Фаза 3. */
  | { type: 'verification-attested'; callId: string; overall: 'passed' | 'failed' | 'partial' | 'not_run'; checksTotal: number; checksPassed: number; changedFilesCount: number }
  | { type: 'usage'; usage: UsageDelta }
  /** Context window auto-compact is running or has just finished. */
  | { type: 'context-compact'; phase: 'start'; reason: 'context-window' }
  | { type: 'context-compact'; phase: 'done'; beforeChars: number; afterChars: number; droppedTurns: number; keptTurns: number; reason: 'context-window' }
  | { type: 'context-compact'; phase: 'cancel'; reason: 'context-window' }
  /** Информационное сообщение для UI (тост). Не блокирует сессию. */
  | { type: 'info'; text: string }
  /** Результат авто-кросс-верификации: другой провайдер просмотрел изменённые файлы. */
  | { type: 'cross-verify'; result: string; provider: string; ok: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface ChatProvider {
  id: string
  name: string
  models: string[]
  send: (
    messages: ChatMessage[],
    tools: ToolDefinition[],
    toolResults?: ToolResult[],
    /** Аудит B3: abort-сигнал агентного цикла. API-провайдеры пробрасывают его
     *  в SDK/fetch, чтобы Stop реально рвал HTTP-стрим (иначе платим за токены,
     *  которые сервер генерит уже после нажатия Stop). CLI-провайдеры игнорируют. */
    signal?: AbortSignal
  ) => AsyncIterable<ChatEvent>
}
