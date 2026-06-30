// Общие типы и хелперы для модулей tool-handlers/*.
// Вынесено из electron/ipc/tool-handlers.ts при распиле монолита — поведение не меняется.
import type { Attachment, ToolCall, ToolResult } from '../../ai/types'
import type { FileTools } from '../../ai/tools'
import type { AgentMode } from '../../ai/mode-policy'
import type { McpClient } from '../../mcp/client'
import type { ProviderId } from '../../ai/registry'
import type { NewDecisionRecord, DecisionRecord } from '../../storage/project-brain'

/** Stable identifier for an in-flight `ai:send` call. */
export type SendId = number

export interface TaggedSender {
  send: (channel: string, payload: { id: SendId; event: unknown }) => void
  exec: (code: string) => Promise<unknown>
}

export interface ConnectorRegistry {
  list: () => Array<{ id: string; label: string; kind: string; status: string; detail?: string }>
  query: (id: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}

/** Context every tool handler receives. */
export interface ToolContext {
  sender: TaggedSender
  sendId: SendId
  signal: AbortSignal
  projectPath: string
  tools: FileTools
  recordWrite: (projectPath: string, filePath: string, before: string | null, after: string) => void
  recordPlan: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) => { id: number }
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void
  /** Read recent journal entries — used by the `read_journal` AI tool for self-reflection. */
  readJournal: (projectPath: string, limit: number) => Array<{ kind: string; title: string; detail: string | null; createdAt: number }>
  /** Сохранить запись в долговременную память проекта. */
  saveMemory: (projectPath: string, type: string, content: string, tags: string[]) => { id: string }
  /** Ось 4 #2: пометить воспоминание устаревшим (soft-invalidate) для реконсиляции. */
  invalidateMemory?: (id: string, supersededBy?: string | null) => boolean
  /** Сохранить структурированное Decision Record в Decision Memory (project-brain). */
  saveDecision: (projectPath: string, rec: NewDecisionRecord) => DecisionRecord
  /** Поиск по долговременной памяти проекта. */
  searchMemories: (projectPath: string, query: string, limit: number) => Array<{ id: string; type: string; content: string; tags: string[]; created_at: number }>
  /** Полнотекстовый поиск по истории разговоров проекта. */
  searchConversations: (projectPath: string, query: string, limit: number) => Array<{ session_id: number; role: string; content: string; created_at: number }>
  connectors: ConnectorRegistry
  /** Mutated by browser_screenshot; flushed by the agent loop into next user msg. */
  pendingAttachments: Attachment[]
  /** Shared maps used by the diff-confirm flow. */
  pendingWrites: Map<string, { sendId: SendId; resolve: (accept: boolean) => void }>
  pendingCommands: Map<string, { sendId: SendId; resolve: (accept: boolean) => void }>
  /** #3 plan-gate: ожидающие одобрения планы (create_plan в plan-режиме). */
  pendingPlans?: Map<string, { sendId: SendId; resolve: (d: { decision: 'approve' | 'revise' | 'reject'; feedback?: string }) => void }>
  scopedKey: (sendId: SendId, callId: string) => string
  /** Active agent mode — controls auto-accept / confirm / block per tool. */
  agentMode: AgentMode
  /** NL-cron: unattended-прогон → connector_query разрешён ТОЛЬКО для read-only op'ов
   *  (op-level политика). Пишущие/выполняющие коннекторы (ssh/telegram send/вебхуки)
   *  блокируются без надзора. См. connector-readonly.ts. */
  readOnlyConnectors?: boolean
  /** ось 3 I: per-tool auto-approve — пользовательские категорийные тумблеры (edits/
   *  commands) поверх mode-policy.decide(). Повышают confirm→auto-accept. См. mode-policy. */
  autoApprove?: import('../../ai/mode-policy').AutoApprove
  /** Декларативные permission-правила allow/deny/ask по паттернам (поверх режима).
   *  Грузятся из ~/.verstak/permissions.json + project. Хендлеры решают через
   *  resolveDecision(). deny бьёт даже bypass; правила не ослабляют plan. См. permission-rules. */
  permissionRules?: import('../../ai/permission-rules').CompiledPermissionRules
  /** H (ось 3): new_task — агент пакует дистиллят, контекст очистится до него на след. turn. */
  requestNewTask?: (summary: string) => void
  /** #3 plan-gate: переключить режим прогона на остаток (approve → выполнение).
   *  Пишет в мутабельный holder уровня прогона — следующий turn видит новый режим. */
  setAgentMode?: (mode: AgentMode) => void
  /** Skill registry для delegate_task (опционально — V3 фича). */
  skillRegistry?: {
    list: () => Array<{ id: string; name?: string; default_provider?: string; default_model?: string; systemPrompt: string }>
  }
  /** Secret reader для delegate_task — нужен чтобы достать API key
   *  альтернативного провайдера. */
  getSecretForDelegate?: (key: string) => string | null
  /** ID текущего провайдера чата — используется как fallback в delegate_task. */
  currentProviderId?: string
  /** MCP client для роутинга вызовов внешних MCP-инструментов. */
  mcpClient?: McpClient
  /** Опциональный аппендер в audit_log — вызывается после каждого tool call. */
  appendAudit?: (action: string, detail: string) => void
  /** Cost guard сессии — прокидывается в sub-agent loop, чтобы токены субагентов
   *  учитывались в общий cap (Фаза 1 мультиагентности). */
  subCostGuard?: import('../../ai/cost-guard').CostGuard
  /** Provider id субагента — для cost-guard учёта внутри sub-loop. */
  subProviderId?: ProviderId
  /** Модель субагента — для cost-guard учёта внутри sub-loop. */
  subModel?: string
  /** ID главного чата — родитель для персистентных суб-сессий (Фаза 2). */
  parentChatId?: number | null
  /** Глубина агента в дереве делегирования (Фаза 4, Идея 3). Главный=0, его
   *  суб=1, под-суб=2. delegate_* гейтятся по depth < MAX_DELEGATION_DEPTH. */
  delegationDepth?: number
  /** callId агента-родителя в дереве (Фаза 4) — связывает узлы для визуализации
   *  иерархии в панели Agents. null/undefined у субов главного агента. */
  parentCallId?: string | null
  /** Счётчик всех суб-агентов прогона (Фаза 4) — общий потолок на всё дерево,
   *  а не на отдельную ветку. Один инстанс на ai:send. */
  agentCounter?: import('../../ai/delegation-limits').SessionAgentCounter
  /** Фасад персистентных суб-сессий (Фаза 2, Идея 1). Опционально — без него
   *  субагенты работают как прежде (только эфемерная карточка). */
  subSessions?: {
    create: (opts: { projectPath: string; parentChatId: number | null; role?: string | null; task?: string | null; group?: string | null; callId?: string | null; providerId?: string | null; model?: string | null; depth?: number | null; parentCallId?: string | null }) => number
    update: (id: number, patch: { status?: string; toolCount?: number; costCents?: number; endedAt?: number }) => void
    /** Сохранить одно сообщение turn суба (user/assistant) в историю сессии. */
    appendMessage: (subSessionId: number, projectPath: string, role: 'user' | 'assistant', content: string) => void
  }
  /** Фасад TodoGate (Фаза 3, Идея 2) — оркестрационный todo-лист сессии.
   *  Опционально: без него todo_* tools вернут понятную ошибку. */
  sessionTodos?: {
    createBatch: (opts: { projectPath: string; sessionId: number | null; goal?: string | null; titles: string[] }) => Array<{ id: number; title: string; status: string; ord: number }>
    update: (id: number, patch: { status?: string; assigneeCallId?: string | null }) => void
    list: (projectPath: string, sessionId?: number | null) => Array<{ id: number; title: string; status: string; assigneeCallId: string | null; ord: number }>
    findByTitle: (projectPath: string, sessionId: number | null, title: string) => { id: number; title: string; status: string } | null
  }
  /** ID агентного прогона этого ai:send (Multi-agent Manager, Фаза 4). */
  runId?: string
  /** Записать событие в Timeline прогона (Фаза 4). ОПЦИОНАЛЬНОЕ, best-effort:
   *  ai.ts подкладывает реализацию с try/catch поверх agentRuns.appendEvent.
   *  Дёргается РЯДОМ с существующими ai:event-эмиттерами (emitActivity/
   *  diffConfirmWrite/delegate/artifact/verify), не плодя новые точки. */
  recordRunEvent?: (kind: string, payload: { label?: string | null; detail?: string | null; ref?: string | null; status?: string | null }) => void
  /** Файлы, реально записанные за этот прогон (write_file/apply_patch, accepted).
   *  Источник истины для attest_verification — сверка claimed vs actual.
   *  Опционально: ai.ts отдаёт снимок filesTouched; без него actual=claimed. */
  runFilesTouched?: () => string[]
  /** Фасад истории Verification Artifact (Фаза 3). attest_verification после
   *  writeVerificationArtifact пишет строку (best-effort). Опционально: без него
   *  артефакт-файл всё равно создаётся, в БД истории просто не попадает. */
  verifications?: {
    insert: (row: {
      projectPath: string
      chatId: number | null
      runId: string | null
      overall: 'passed' | 'failed' | 'partial' | 'not_run'
      checksTotal: number
      checksPassed: number
      changedFilesCount: number
      artifactPath: string
      htmlPath: string | null
      taskSummary: string | null
      createdAt: number
    }) => number
  }
}

export type ToolMode = 'parallel-read' | 'sequential' | 'confirm-write'

export interface ToolHandler {
  mode: ToolMode
  handle(call: ToolCall, ctx: ToolContext): Promise<ToolResult>
}

// Значимые tool-вызовы для Timeline задачи (Фаза 4). НЕ пишем read_file/
// list_directory/search_project/find_files/get_project_map и прочую read-only
// мелочь — иначе Timeline раздувается. Команда/коннектор/делегирование значимы.
const TIMELINE_TOOL_CALLS = new Set([
  'run_command', 'connector_query', 'delegate_task', 'delegate_parallel'
])

export function emitActivity(ctx: ToolContext, call: ToolCall, status: 'ok' | 'error', label: string, detail: string): void {
  ctx.sender.send('ai:event', {
    id: ctx.sendId,
    event: { type: 'tool-activity', callId: call.id, name: call.name, label, detail, status }
  })
  // Audit log — fire-and-forget, не критично
  if (ctx.appendAudit) {
    try {
      const auditDetail = JSON.stringify({ callId: call.id, status, detail: detail.slice(0, 200) })
      ctx.appendAudit(status === 'error' ? 'error' : 'tool_call', auditDetail)
    } catch { /* not critical */ }
  }
  // Timeline задачи (Фаза 4): значимые tool-вызовы → событие tool_call. check_diagnostics
  // — это верификация, поэтому пишется как kind='verify' (status pass/fail) рядом
  // со своим emitActivity, а не здесь. recordRunEvent best-effort (ai.ts оборачивает
  // в try/catch); вызываем только для «крупных» вызовов из TIMELINE_TOOL_CALLS.
  if (ctx.recordRunEvent && TIMELINE_TOOL_CALLS.has(call.name)) {
    ctx.recordRunEvent('tool_call', { label: call.name, detail, status })
  }
}

/**
 * Ждать подтверждения команды/коннектора, РАЗРЫВАЯ ожидание на ctx.signal.abort
 * (аудит B2). Без этого per-task таймаут субагента (180с) и групповая отмена роя
 * не освобождали ожидание → весь ai:send висел до ручного Stop. Тот же паттерн,
 * что в diffConfirmWrite для write_file.
 */
export function awaitCommandConfirm(ctx: ToolContext, callId: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false
    const key = ctx.scopedKey(ctx.sendId, callId)
    const finish = (v: boolean) => {
      if (settled) return
      settled = true
      ctx.pendingCommands.delete(key)
      ctx.signal.removeEventListener('abort', onAbort)
      resolve(v)
    }
    const onAbort = () => finish(false)
    ctx.pendingCommands.set(key, { sendId: ctx.sendId, resolve: finish })
    if (ctx.signal.aborted) { onAbort(); return }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
  })
}


export function summarizeToolCall(name: string, args: Record<string, unknown>, result: unknown): { label: string; detail: string } | null {
  if (name === 'read_file') {
    const p = String(args.path ?? '')
    const len = typeof result === 'string' ? result.length : 0
    return { label: 'read_file', detail: `${p} · ${len} символов` }
  }
  if (name === 'list_directory') {
    const p = String(args.path ?? '.')
    const count = Array.isArray(result) ? result.length : 0
    return { label: 'list_directory', detail: `${p} · ${count} элементов` }
  }
  if (name === 'search_project') {
    const q = String(args.query ?? '')
    const r = result as { matches?: unknown[] } | undefined
    const hits = Array.isArray(r?.matches) ? r!.matches!.length : 0
    return { label: 'search_project', detail: `"${q}" · ${hits} совпадений` }
  }
  if (name === 'find_files') {
    const pattern = String(args.pattern ?? '')
    const r = result as { files?: unknown[] } | undefined
    const hits = Array.isArray(r?.files) ? r!.files!.length : 0
    return { label: 'find_files', detail: `${pattern} · ${hits} файлов` }
  }
  if (name === 'list_connectors') {
    const arr = typeof result === 'string' ? JSON.parse(result) as Array<{ label?: string }> : []
    return { label: 'list_connectors', detail: `${arr.length} коннекторов` }
  }
  if (name === 'connector_query') {
    return { label: 'connector_query', detail: `${String(args.id ?? '?')}${args.entity ? ` · ${args.entity}` : ''}` }
  }
  if (name === 'browser_navigate') {
    return { label: 'browser_navigate', detail: String(args.url ?? '') }
  }
  if (name === 'browser_read_page') {
    return { label: 'browser_read_page', detail: args.selector ? String(args.selector) : '(вся страница)' }
  }
  if (name === 'browser_screenshot') {
    return { label: 'browser_screenshot', detail: '' }
  }
  if (name === 'get_project_map' || name === 'refresh_project_map') {
    return { label: name, detail: '' }
  }
  return null
}
