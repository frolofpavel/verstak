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
  /** 2.0.11-B: id строки в `chats`. Renderer шлёт его в ai:send с самого начала (store
   *  кладёт `dbId: m.id`), но main-тип этого не описывал — поле доезжало «само».
   *  Компакции оно нужно ЯВНО: по нему история режется по границе снапшота. Нет dbId —
   *  сообщение считается свежим (ещё не в БД) и всегда идёт модели. Зеркало поля в
   *  src/types/api.d.ts (§5 дубли renderer↔main). */
  dbId?: number
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

export type { NormalizedUsage, InputAccounting } from '../../shared/contracts/usage'
import type { InputAccounting } from '../../shared/contracts/usage'

/**
 * Событие usage. 2.0.8-E: совместимый СУПЕРСЕТ — адаптеры кладут полный NormalizedUsage (через
 * `normalizedUsage()`), старые construction-сайты (тесты) — частичный старый shape. Все поля
 * optional, чтобы оба варианта типизировались. Commit 2 мигрирует потребителей на
 * cacheReadTokens/cacheWriteTokens/inputAccounting + billableInputTokens; старые имена — мост.
 */
export interface UsageDelta {
  inputTokens?: number | null
  outputTokens?: number | null
  /** @deprecated старое имя cacheReadTokens (мост до commit 2). */
  cachedInputTokens?: number
  /** @deprecated старое имя cacheWriteTokens (мост до commit 2). */
  cacheCreationInputTokens?: number
  /** 2.0.8-E: прочитано из кэша (null = не сообщил). */
  cacheReadTokens?: number | null
  /** 2.0.8-E: записано в кэш — Claude cache write ~1.25× (null = не сообщил/не поддерживает). */
  cacheWriteTokens?: number | null
  /** 2.0.8-E: входит ли cached в reported input (exclusive=Claude / inclusive=OpenAI/Gemini / unknown). */
  inputAccounting?: InputAccounting
  /** 2.0.8-E: raw reported input до нормализации billable. */
  providerReportedInputTokens?: number
  model?: string
}

export type ChatEvent =
  | { type: 'text'; text: string }
  /** Model's internal reasoning. Streamed separately from text so the UI
   *  can render it as a collapsible block. */
  | { type: 'thought'; text: string }
  | { type: 'agent-progress'; id?: string; phase: 'understand' | 'context' | 'model' | 'reasoning' | 'tool' | 'command' | 'write' | 'verify' | 'final'; title: string; detail?: string; status?: 'pending' | 'running' | 'done' | 'error' | 'blocked' }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'pending-write'; callId: string; path: string; before: string; after: string }
  | { type: 'pending-command'; callId: string; command: string }
  | { type: 'command-result'; callId: string; command: string; status: 'ok' | 'error' | 'rejected'; exitCode?: number; stdout?: string; stderr?: string; error?: string }
  | { type: 'tool-blocked'; callId: string; name: string; command?: string; reason: string }
  | { type: 'plan-created'; planId: number; title: string; stepCount: number; quality?: { score: number; status: 'pass' | 'revise' | 'block'; warnings: string[] } }
  | { type: 'plan-approval'; callId: string; planId: number; title: string; stepCount: number; quality?: { score: number; status: 'pass' | 'revise' | 'block'; warnings: string[] } }
  | { type: 'task-contract-created'; pipelineId: number; revision: number; contract: import('../../shared/contracts/outcome').TaskContractV1 }
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
  /** 2.0.8-D: автоматическая смена маршрута прогона (ротация аккаунта / fallback провайдера /
   *  refresh токена). Structured — пользователь по Timeline объясняет КАЖДУЮ смену (инвариант 8).
   *  Renderer-safe: только provider/model + безопасные LABELS аккаунтов (без accountId/секретов).
   *  reason — код RouteReason. resetAt — epoch ms восстановления лимита; null = неизвестно
   *  (UI обязан показать «нет данных», НЕ выдуманное время/«безлимит»). */
  | { type: 'route-changed'; action: 'rotate-account' | 'model-fallback' | 'refresh-auth'; reason: string; attempt: number; requested: { providerId: string; model: string }; actual: { providerId: string; model: string }; resetAt: number | null; accounts: { fromLabel: string | null; toLabel: string | null } | null }
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
