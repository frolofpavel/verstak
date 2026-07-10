import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { notifyRunEvent, shouldSendAutoProofReport } from '../ai/run-notify'
import { scanText } from '../ai/secret-scanner'
import { globalProcessRegistry, type ProcessCompletion, type ProcessRegistry } from '../ai/process-registry'
import { clearRunUntilGreenForSend, clearSmartApproveForSend } from './tool-handlers/command'
import { createFileTools, createToolsForProject, TOOL_DEFS } from '../ai/tools'
import { isWithinKnownRoots } from '../ai/path-policy'
import { createProvider, PROVIDERS, type ProviderId } from '../ai/registry'
import type { McpClient } from '../mcp/client'
import { prepareSystemContext } from '../ai/compose-system'
import { applyRecipeToSkillPrompt } from '../ai/skills/recipe'
import type { RecipeSpec } from '../ai/skills/types'
import {
  isMutatingToolName, snapshotVerifyBaseline, isReviewGatePassResult,
  decideReviewGate, buildReviewGateRequiredNudge, REVIEW_GATE_STOP_MESSAGE,
  MAX_REVIEW_GATE_NUDGES, type VerifyRun,
} from '../ai/review-gate'
import { systemForProvider, stripCacheBreakpoint } from '../ai/compose-prompt'
import { MAX_STEPS_REPORT } from '../ai/model-presets'
import { buildCliPrompt, type CliProviderId } from '../ai/cli-prompt'
import { createLegacyMemoryProvider } from '../ai/memory/provider'
import { buildRunMemorySnapshot, memorySnapshotFingerprint, snapshotPromptMemories } from '../ai/memory/run-snapshot'
import { REVIEWER_SYSTEM_PROMPT } from '../ai/review-prompt'
import { compactToolHistory, shouldAutoCompact, buildCompactSummaryPrompt, createCompactedHistory, microcompactIfNeeded, formatFocusChain, buildNewTaskContext } from '../ai/compact-history'
import { estimateTokens } from '../ai/context-limits'
import { withInitialRetry } from '../ai/with-retry'
import { classifyProviderError } from '../ai/provider-error'
import { createCostGuard } from '../ai/cost-guard'
import { SessionAgentCounter } from '../ai/delegation-limits'
import type { AgentMode } from '../ai/mode-policy'
import { loadPermissionRules } from '../ai/permission-rules'
import { hooksEnabled, hooksProjectEnabled, loadHooks, runHooks, type CompiledHooks } from '../ai/hooks'
import type { ChatMessage, ToolCall, ToolResult, ChatProvider, Attachment } from '../ai/types'
import { lookupHandler, type ToolContext, type TaggedSender as HandlerTaggedSender } from './tool-handlers'
// Распил ai.ts (1.9.8 #1): эмиссия прогресса (срез 1) + supplements (срез 2).
import { tagSender, compactProgressText, modelProgressLabel, emitAgentProgress, createModelWaitHeartbeat } from '../ai/runner-progress'
import { registerConversationSupplements, unregisterConversationSupplements, pushConversationSupplement, formatConversationSupplement } from '../ai/runner-supplements'
import { selectAllowedToolDefs, retriableErrorEvent } from '../ai/runner-util'
import { type FallbackOpts, MAX_FALLBACK_ATTEMPTS, MAX_ACCOUNT_SWITCHES } from '../ai/runner-shared'
// Распил ai.ts (1.9.8 #1, срез 4b): CLI-путь вынесен в runner-plain.
import { runPlainConversation } from '../ai/runner-plain'
import { captureToolObservation } from '../ai/memory-hooks'
import type { NewDecisionRecord, DecisionRecord } from '../storage/project-brain'
import { trackToolForPatterns, type ToolEvent } from '../ai/procedural-memory'
import { pickReviewProvider, buildCrossVerifyPrompt, runCrossVerify, getConfiguredApiProviders, type TurnChange } from '../ai/cross-verify'
import { shouldFallback, getNextFallback, classifyFallbackReason } from '../ai/smart-fallback'
import { detectSubscriptionLimit } from '../ai/subscription-limits'
import { resolveToolMode, isCoaxableProvider, JSON_TOOL_INSTRUCTION, IGNORED_TOOLS_NUDGE } from '../ai/tool-mode'
import { estimateComplexity, recommendModel, complexityLabel, detectCliWorthiness } from '../ai/smart-router'
import { type ExitReason, callSignature, detectVerifyScriptsForHint, writeSessionJournal } from '../ai/session-journal'
import {
  AGENT_RUN_TIMEOUT_SETTING_KEY,
  abortAgentRunForTimeout,
  exitReasonToAgentRunStatus,
  isAgentRunTimeoutAbort,
  resolveAgentRunTimeoutPolicy,
  shouldFireRunTimeout,
} from '../ai/run-lifecycle'
import { parseResumeCheckpoint, canReplayCheckpoint } from '../ai/resume-checkpoint'
import { decideCheckpointSave, type CheckpointThrottleState } from '../ai/checkpoint-throttle'
import { intensityConfig, parseIntensity } from '../ai/intensity'
import { isTypeScriptFile, shouldAutoDiagnose, formatDiagnosticHint } from '../ai/diagnostic-loop'
import { isLspDiagnosableFile, formatLspDiagnosticHint } from '../ai/lang-servers'
import { runLspDiagnostics } from '../ai/lsp-diagnose'
import { ALLOWED_WRITE_ROOTS_KEY, parseAllowedWriteRoots } from '../ai/allowed-write-roots'
import { join as joinPath } from 'node:path'
import type { AgentRuns, AgentRunOwner } from '../storage/agent-runs'
import { pickResumeGuardTool } from '../storage/agent-runs'
import { expandOfficeAttachments } from '../ai/attachment-text'
import { logRuntime, logRuntimeError } from '../runtime-log'

export type { ProviderId } from '../ai/registry'

interface AiDeps {
  getSecret: (key: string) => string | null
  getProviderId: () => ProviderId
  getProviderModel: (id: ProviderId) => string | null
  /** 1.9.3 мультиаккаунт: активный аккаунт подписки провайдера. Резолвит секрет из
   *  SafeStorage по cred_ref, метаданные env-биндинга (config_dir/base_url) и touch'ит
   *  last_used_at. null = нет заведённых аккаунтов (тогда рантайм падает на legacy-секрет). */
  resolveSubscriptionAccount?: (providerId: string) => { accountId: number; secret: string | null; configDir: string | null; baseUrl: string | null } | null
  /** 1.9.4: активный аккаунт провайдера исчерпал лимит → пометить cooling и переключить на
   *  следующий готовый аккаунт пула. switched:false = пул исчерпан (падаем на provider-fallback). */
  switchSubscriptionAccountOnLimit?: (providerId: string, resetEta: number | null) => { switched: boolean }
  /** Корни зарегистрированных проектов — для валидации projectPath из рендерера. */
  getKnownRoots: () => string[]
  /** Persist a write so the user can ↶ revert it later. */
  recordWrite: (projectPath: string, filePath: string, before: string | null, after: string) => void
  /** Fetch the N most recent accepted writes for the Context Pack. */
  recentWrites: (projectPath: string, limit: number) => Array<{ filePath: string; createdAt: number }>
  /** Project Brain (Итер.4): прогретый ContextPack под задачу. null если не прогрет. */
  getBrainContext?: (projectPath: string, lastUserMessage: string) => { content: string; packType: string; tokenEstimate?: number | null } | null
  /** Persist a plan emitted by the AI. */
  recordPlan: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) => { id: number }
  /** Auto-append a brief entry to the dev journal (file write, command, plan, session summary). */
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void
  /** Read recent journal entries — exposed to the AI as the read_journal tool. */
  readJournal: (projectPath: string, limit: number) => Array<{ kind: string; title: string; detail: string | null; createdAt: number }>
  /** Сохранить запись в долговременную память проекта. */
  saveMemory: (projectPath: string, type: string, content: string, tags: string[]) => { id: string }
  /** Ось 4 #2: пометить воспоминание устаревшим (soft-invalidate) — для реконсиляции
   *  противоречащих фактов агентом. supersededBy — id заменившего воспоминания. */
  invalidateMemory: (id: string, supersededBy?: string | null) => boolean
  /** Сохранить структурированное Decision Record в Decision Memory (project-brain). */
  saveDecision: (projectPath: string, rec: NewDecisionRecord) => DecisionRecord
  /** Поиск по долговременной памяти проекта. */
  searchMemories: (projectPath: string, query: string, limit: number) => Array<{ id: string; type: string; content: string; tags: string[]; created_at: number }>
  /** memory-nudge консолидации: system-хинт если воспоминания накопились, иначе null. */
  memoryConsolidationHint?: (projectPath: string) => string | null
  /** Полнотекстовый поиск по истории разговоров проекта. */
  searchConversations: (projectPath: string, query: string, limit: number) => Array<{ session_id: number; role: string; content: string; created_at: number }>
  /** Connector registry (list / query external services like 1C). */
  connectors: {
    list: () => Array<{ id: string; label: string; kind: string; status: string; detail?: string }>
    query: (id: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  }
  /** Active agent mode — auto-accept / confirm / block per tool category. */
  getAgentMode: () => AgentMode
  /** Skill registry для delegate_task (V3). Optional — без него delegate_task
   *  всё равно работает с generic prompt. */
  skillRegistry?: {
    list: () => Array<{ id: string; name?: string; default_provider?: string; default_model?: string; systemPrompt: string }>
  }
  /** MCP client — внешние серверы, опционально. */
  mcpClient?: McpClient
  /** Процедурная память — детектирует паттерны решения задач из tool events. */
  trackToolPattern?: (projectPath: string, event: ToolEvent) => void
  /** Опциональный аппендер в audit_log — вызывается после каждого tool call.
   *  runId — ID агентного запуска (один ai:send = один run); group-by в инспекторе. */
  appendAudit?: (projectPath: string, chatId: number | null, action: string, detail: string, providerId: string | null, model: string | null, runId: string | null) => void
  /** Опциональный снапшот реального входа run'а для Debug Packet. Вызывается на
   *  старте run'а в API-пути, где собран композитный system prompt. */
  saveRunInput?: (input: { runId: string; projectPath: string | null; chatId: number | null; timestamp: number; providerId: string | null; model: string | null; systemPrompt: string; userMessage: string }) => void
  /** Opt-in delivery: long successful main run can send its Proof Pack through the existing proof service. */
  sendProofReport?: (runId: string) => Promise<{ ok: boolean; error?: string }>
  /** Фасад персистентных суб-сессий (Фаза 2, Идея 1). Прокидывается в ToolContext,
   *  чтобы delegate_task/delegate_parallel сохраняли историю субагентов в БД. */
  subSessions?: ToolContext['subSessions']
  /** Фасад TodoGate (Фаза 3, Идея 2) — оркестрационный todo-лист сессии. */
  sessionTodos?: ToolContext['sessionTodos']
  /** Фасад Multi-agent Manager (Фаза 1) — agent_runs. Прокинут заранее; запись
   *  прогонов (create/finish/recordRunEvent) подключит Фаза 2 — здесь НЕ используется. */
  agentRuns?: AgentRuns
  /** #5 worktree-lifecycle: ре-рут file-тулзов на persistent worktree изолированного чата. */
  worktreeSessions?: import('../storage/worktree-sessions').WorktreeSessions
  /** Фасад истории Verification Artifact (Фаза 3) — attest_verification пишет
   *  строку после writeVerificationArtifact. Прокидывается в ToolContext. */
  verifications?: ToolContext['verifications']
  /** Dev Task Flow (Фаза 2) — привязка прогона к активной dev_task чата. Best-
   *  effort: если у чата есть открытая (не committed/cancelled) задача, прогон
   *  линкуется к ней (один dev_task ↔ N run_id). Опционально — без него
   *  dev_task просто не накапливает run_id'ы (откат всё равно работает через
   *  checkpoint). Возвращает true если связал. */
  linkDevTaskRun?: (projectPath: string, chatId: number | null, runId: string) => void
}

let currentSendId = 0
const activeAborts = new Map<number, AbortController>()
const autoProofReportsSent = new Set<string>()
// 1.9.7 #7: троттлинг crash-resume чекпойнтов — последний записанный hash/turn
// на прогон (skip-if-unchanged + every-N). Чистится на clearCheckpoint/finish.
const checkpointThrottle = new Map<string, CheckpointThrottleState>()

function formatProcessCompletionNote(completion: ProcessCompletion): string {
  const runtimeMs = Math.max(0, completion.exitedAt - completion.startedAt)
  const tail = completion.outputTail.trim()
  return [
    `[SYSTEM: background process ${completion.id} finished]`,
    `status: ${completion.status}`,
    `exitCode: ${completion.exitCode ?? 'unknown'}`,
    `runtimeMs: ${runtimeMs}`,
    `command: ${completion.command}`,
    'redacted output tail:',
    tail || '(empty)',
  ].join('\n')
}

// Track which chats have already received memory injection in this process
// lifetime. Replaces the old isFirstTurn check so memory is injected on the
// first ai:send for a chat in this app session — not only on truly-first-ever
// turns (which broke reopened old chats with existing assistant messages).
const memorizedChats = new Set<string>()

/**
 * Remove a single chat key from the memory-injection cache.
 * Call when a chat session is deleted so a new session reusing the same
 * numeric id (or projectPath fallback) gets a fresh memory injection.
 */
export function forgetMemorizedChat(key: string): void {
  memorizedChats.delete(key)
}

/**
 * Remove a projectPath fallback key when a project is removed.
 * Only relevant for chats where no chatId was provided to ai:send.
 */
export function forgetMemorizedProject(projectPath: string): void {
  memorizedChats.delete(projectPath)
}

// Local TaggedSender alias — shape-compatible with tool-handlers.TaggedSender.
type TaggedSender = HandlerTaggedSender

// Keyed by `${sendId}::${callId}` so concurrent ai:send invocations cannot
// resolve each other's pending confirmations. The renderer still identifies
// modals by callId (it doesn't know about sendId), so we look up by callId
// suffix when resolving — but isolation is enforced when CLEARING (ai:stop).
interface PendingWrite { sendId: number; resolve: (accept: boolean) => void }
const pendingWrites = new Map<string, PendingWrite>()

interface PendingCommand { sendId: number; resolve: (accept: boolean) => void }
const pendingCommands = new Map<string, PendingCommand>()

// #3 plan-gate: ожидающие одобрения планы (create_plan в plan-режиме блокирует-и-ждёт).
interface PendingPlan { sendId: number; resolve: (d: { decision: 'approve' | 'revise' | 'reject'; feedback?: string }) => void }
const pendingPlans = new Map<string, PendingPlan>()

// #4 suspend: sendId'ы, прерванные как ПРИОСТАНОВКА (не Stop) — finally помечает их
// прогон статусом 'suspended' (чекпойнт уже сохраняется на abort) для ↻ Продолжить.
const suspendedSends = new Set<number>()

function scopedKey(sendId: number, callId: string): string {
  return `${sendId}::${callId}`
}

/**
 * Прерывает активный ai:send по sendId — то же ядро, что и ai:stop. Вынесено в
 * экспорт, чтобы Multi-agent Manager ('agent-runs:stop', Фаза 4) переиспользовал
 * ровно тот же путь: abort каскадит в субы/sub-queue через ctx.signal, дренирует
 * pending-подтверждения этой сессии. Возвращает true если что-то прервали.
 *
 *  sendId <= 0 → emergency abort: останавливает ВСЕ активные стримы + отклоняет
 *  все подтверждения (Shift+Esc). Иначе — точечно по sendId.
 */
export function abortSend(sendId: number): boolean {
  logRuntime('ai.abort.request', { sendId, activeCount: activeAborts.size })
  if (sendId <= 0) {
    for (const [k, c] of activeAborts) { c.abort(); activeAborts.delete(k) }
    for (const [k, p] of pendingWrites) { p.resolve(false); pendingWrites.delete(k) }
    for (const [k, p] of pendingCommands) { p.resolve(false); pendingCommands.delete(k) }
    for (const [k, p] of pendingPlans) { p.resolve({ decision: 'reject' }); pendingPlans.delete(k) }
    logRuntime('ai.abort.all')
    return true
  }
  const ctrl = activeAborts.get(sendId)
  if (!ctrl) {
    logRuntime('ai.abort.miss', { sendId }, 'warn')
    return false
  }
  ctrl.abort()
  activeAborts.delete(sendId)
  clearRunUntilGreenForSend(sendId) // ось 3 E: счётчик run_until_green этого прогона
  // Reject ONLY this session's pending confirmations — other concurrent
  // ai:send streams (background sessions) keep theirs intact.
  for (const [k, p] of pendingWrites) {
    if (p.sendId === sendId) { p.resolve(false); pendingWrites.delete(k) }
  }
  for (const [k, p] of pendingCommands) {
    if (p.sendId === sendId) { p.resolve(false); pendingCommands.delete(k) }
  }
  for (const [k, p] of pendingPlans) {
    if (p.sendId === sendId) { p.resolve({ decision: 'reject' }); pendingPlans.delete(k) }
  }
  logRuntime('ai.abort.ok', { sendId })
  return true
}

/**
 * Fire-and-forget: запускаем кросс-верификацию асинхронно после done.
 * Никогда не бросает — любые ошибки логируем и тихо игнорируем.
 * Результат приходит как cross-verify event ПОСЛЕ done основного ответа.
 */
function fireCrossVerify(
  sender: TaggedSender,
  sendId: number,
  changes: TurnChange[],
  currentProviderId: ProviderId | undefined,
  getSecret: (key: string) => string | null
): void {
  if (!changes.length) return
  if (!currentProviderId) return
  // Проверяем настройку cross_verify (по умолчанию включена)
  if (getSecret('cross_verify') === 'false') return

  // Асинхронно, не блокируем
  void (async () => {
    try {
      const configured = getConfiguredApiProviders(getSecret)
      const reviewProviderId = pickReviewProvider(currentProviderId, configured)
      if (!reviewProviderId) return  // только 1 провайдер — пропускаем

      const prompt = buildCrossVerifyPrompt(changes)
      const cvResult = await runCrossVerify(reviewProviderId, prompt, getSecret)

      sender.send('ai:event', {
        id: sendId,
        event: { type: 'cross-verify', result: cvResult.result, provider: cvResult.provider, ok: cvResult.ok }
      })
    } catch (err) {
      console.warn('[cross-verify] unexpected error:', err instanceof Error ? err.message : err)
    }
  })()
}

// Read-only набор для unattended-прогона. Локальные read-тулзы + connector_query/
// list_connectors — НО connector_query гейтится op-level политикой (ctx.readOnlyConnectors):
// проходят только читающие op'ы (Ozon/WB/Метрика-данные), пишущие/выполняющие (ssh
// run_remote, telegram send, вебхуки) блокируются. БЕЗ write_file/apply_patch/run_command/
// browser/delegate. Так live-аудиты внешних данных безопасны без надзора.
// Набор инструментов для unattended NL-cron прогона (runScheduledHeadless).
// ТОЛЬКО read-only: фоновый прогон без надзора не должен писать файлы / выполнять
// команды / мутировать внешние системы. Экспортирован для security-guard теста
// (1.9.7 #8): регрессия, добавившая сюда write_file/run_command/…, обязана падать.
// connector_query оставлен намеренно — это ЧТЕНИЕ коннектора (не запись).
export const SCHEDULED_READONLY_TOOLS = [
  'read_file', 'list_directory', 'search_project', 'find_files', 'get_project_map', 'impact_analysis',
  'read_journal', 'conversation_search', 'memory_search', 'read_spreadsheet', 'read_document', 'convert_file',
  'find_definition', 'find_references', 'list_connectors', 'connector_query',
]

/**
 * NL-cron headless-прогон: запускает агентный цикл БЕЗ UI на read-only-наборе (локальные
 * read-тулзы + ЧИТАЮЩИЙ connector_query). Переиспользует проверенный sub-agent-loop (все
 * security-гейты внутри хендлеров) + полный project-контекст (prepareSystemContext).
 *
 * Безопасность: набор без write/run/delegate; connector_query гейтится op-level политикой
 * (readOnlyConnectors=true) → unattended-агент читает внешние данные, но не пишет/выполняет.
 */
export async function runScheduledHeadless(
  deps: AiDeps,
  opts: { projectPath: string; prompt: string; providerId: ProviderId; model: string | null; signal: AbortSignal }
): Promise<{ ok: boolean; text: string; error?: string }> {
  // Гейт пути как в ai:send: unattended-прогон не должен получить файловый доступ к
  // незарегистрированной/системной папке (напр. осиротевшая задача после удаления проекта).
  if (!isWithinKnownRoots(opts.projectPath, deps.getKnownRoots())) {
    return { ok: false, text: '', error: 'Путь проекта не зарегистрирован — прогон отменён' }
  }
  const descriptor = PROVIDERS[opts.providerId]
  if (!descriptor || descriptor.transport !== 'API' || !descriptor.secretKey) {
    return { ok: false, text: '', error: `Провайдер ${opts.providerId} не годится для unattended (нужен API + ключ)` }
  }
  const apiKey = deps.getSecret(descriptor.secretKey)
  if (!apiKey) return { ok: false, text: '', error: `Нет API-ключа для ${opts.providerId}` }
  const model = opts.model ?? descriptor.defaultModel

  try {
    const provider = createProvider(opts.providerId, { apiKey, model, cwd: opts.projectPath, signal: opts.signal })
    const userMsg: ChatMessage = { role: 'user', content: opts.prompt }
    const composed = await prepareSystemContext({
      projectPath: opts.projectPath,
      messages: [userMsg],
      recentWrites: deps.recentWrites(opts.projectPath, 8),
    })
    const messages: ChatMessage[] = [{ role: 'system', content: systemForProvider(composed.system, opts.providerId) }, userMsg]

    // Headless sender — события дропаем (нет UI); итог берём из result.text.
    const sender: TaggedSender = { send: () => {}, exec: async () => undefined }
    const tools = createToolsForProject(opts.projectPath, opts.signal, {
      allowedWriteRoots: parseAllowedWriteRoots(deps.getSecret(ALLOWED_WRITE_ROOTS_KEY))
    })
    const ctx: ToolContext = {
      sender, sendId: -1, signal: opts.signal, projectPath: opts.projectPath, tools,
      recordWrite: deps.recordWrite, recordPlan: deps.recordPlan, recordJournal: deps.recordJournal,
      readJournal: deps.readJournal, saveMemory: deps.saveMemory, saveDecision: deps.saveDecision,
      searchMemories: deps.searchMemories, searchConversations: deps.searchConversations, connectors: deps.connectors,
      pendingAttachments: [], pendingWrites: new Map(), pendingCommands: new Map(), scopedKey,
      agentMode: 'auto', readOnlyConnectors: true, skillRegistry: deps.skillRegistry, getSecretForDelegate: deps.getSecret,
      permissionRules: loadPermissionRules(opts.projectPath),
      currentProviderId: opts.providerId, mcpClient: deps.mcpClient,
      subCostGuard: createCostGuard(null), parentChatId: null,
      delegationDepth: 0, agentCounter: new SessionAgentCounter(),
    }
    const { runSubAgentLoop } = await import('../ai/sub-agent-loop')
    const result = await runSubAgentLoop({
      provider, messages, allowedToolNames: SCHEDULED_READONLY_TOOLS, ctx,
      signal: opts.signal, role: 'scheduled',
    })
    if (result.exitReason === 'error') return { ok: false, text: result.text, error: result.error }
    return { ok: true, text: result.text }
  } catch (err) {
    return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerAiIpc(deps: AiDeps): void {
  /**
   * Optional overrides for ai:send. Used by Explicit Review feature: the
   * reviewer needs a DIFFERENT provider from the chat's main provider, must
   * skip tool dispatch (review is read-only synthesis), and may use a custom
   * system prompt (REVIEWER_SYSTEM_PROMPT) instead of the project's system
   * layer. Without overrides, ai:send behaves exactly as before.
   */
  interface AiSendOverrides {
    providerId?: ProviderId
    model?: string | null
    /** Force plain (no-tools) mode even if provider supports tools. */
    noTools?: boolean
    /** Replace assembled system prompt entirely. When set, project's user-layer
     *  / context-pack is NOT prepended — caller owns the full system message. */
    systemPrompt?: string
    /** Use built-in REVIEWER_SYSTEM_PROMPT. Renderer can't import from electron/,
     *  so it sends this flag instead of the full string. Takes precedence over
     *  systemPrompt if both are set. */
    useReviewerPrompt?: boolean
    /** Уровень усилий: quick / standard / deep. Влияет на max_tokens и extended thinking. */
    effortLevel?: 'quick' | 'standard' | 'deep'
    /** Аудит M4: tools_allow активного скилла. Если задан — agent-loop отдаёт
     *  модели ТОЛЬКО эти инструменты (read-only скилл физически не сможет
     *  write_file/run_command). Без него безопасность скиллов была фиктивна. */
    toolsAllow?: string[]
    /** Режим агента для этого send; по умолчанию — из settings. */
    agentMode?: AgentMode
    /** Crash-resume Фаза 2: возобновить прерванный прогон по его runId. Если у
     *  прогона есть чекпойнт — loop продолжится с накопленным контекстом (полная
     *  история сообщений), а не с turn 0. Невалидный/отсутствующий чекпойнт —
     *  мягкий фоллбэк на обычный старт по incomingMessages. */
    resumeFromRunId?: string
    /** Этап 4: recipe активного скилла. Когда задан — его workflow-протокол
     *  наслаивается на skill-промпт (renderRecipeProtocol). Renderer форвардит
     *  структуру, рендер живёт в main. Нет recipe → обычный skill как раньше. */
    recipe?: RecipeSpec
  }

  ipcMain.handle('ai:send', async (e, incomingMessages: ChatMessage[], projectPath: string | null, budget?: number, overrides?: AiSendOverrides, chatId?: string) => {
    // Безопасность: projectPath приходит из рендерера. Без проверки агент мог бы
    // получить файловый + shell доступ к произвольной системной папке (C:\Windows,
    // C:\Users\Pavel). Гейтим так же, как files/terminal IPC (isWithinKnownRoots).
    if (projectPath && !isWithinKnownRoots(projectPath, deps.getKnownRoots())) {
      throw new Error('Доступ запрещён: путь проекта не зарегистрирован')
    }
    // #5 worktree-lifecycle: изолированный чат работает ЦЕЛИКОМ на своём worktree —
    // tools + контекст + recordWrite/undo (effRoot ниже). Иначе undo бил бы по main
    // (ревью: critical data-loss — правки в worktree, а undo-стек ключевался main).
    // Security-чек выше — на исходном main-пути; worktree создан нами (tmp). НЕ реассайним
    // projectPath (это сломало бы TS-narrowing из-за захвата в замыканиях) — отдельный const.
    const isolatedRoot = chatId ? (deps.worktreeSessions?.activePath(Number(chatId)) ?? null) : null
    const messages = await expandOfficeAttachments(incomingMessages)
    // Crash-resume Фаза 2: возобновление с накопленным контекстом. Если передан
    // resumeFromRunId и у прогона есть валидный чекпойнт — берём полную историю
    // (она уже содержит system + все turn'ы), минуя пере-сборку system ниже.
    // Невалидный/отсутствующий снапшот → null → обычный старт по incomingMessages.
    const resumedMessages = overrides?.resumeFromRunId
      ? parseResumeCheckpoint(deps.agentRuns?.latestCheckpoint(overrides.resumeFromRunId)?.messagesJson ?? null)
      : null
    // 1.9.8 #4: прогон чекпойнта — для гарда совместимости провайдера (ниже).
    const checkpointRun = overrides?.resumeFromRunId
      ? (deps.agentRuns?.get(overrides.resumeFromRunId) ?? null)
      : null
    // Ось интенсивности (Простой/Турбо). Простой = сегодняшнее поведение (standard
    // effort, без наслоения). Турбо = deep effort + подсказка «вся машинерия на
    // задачу». Явный overrides.effortLevel (из UI) имеет приоритет над пресетом.
    const intCfg = intensityConfig(parseIntensity(deps.getSecret('intensity')))
    const resolvedEffort = overrides?.effortLevel ?? intCfg.effortLevel
    const providerId = overrides?.providerId ?? deps.getProviderId()
    const descriptor = PROVIDERS[providerId]
    const sendId = ++currentSendId
    const agentMode: AgentMode = overrides?.agentMode ?? deps.getAgentMode()
    // runId — стабильный идентификатор этого агентного запуска (один ai:send =
    // один run). Штампуется на audit-записи, чтобы инспектор группировал run'ы
    // явно, а не по эвристике (gap/chatId). Закладка под Debug Packet / Workflow.
    const runId = randomUUID()
    const ctrl = new AbortController()
    activeAborts.set(sendId, ctrl)
    let runTimeout: ReturnType<typeof setTimeout> | null = null
    const clearRunTimeout = () => {
      if (runTimeout) {
        clearTimeout(runTimeout)
        runTimeout = null
      }
    }
    const taggedSender = tagSender(e.sender, projectPath) // route progress and chat events to this project
    const lastUserText = compactProgressText([...messages].reverse().find(m => m.role === 'user')?.content, 260)
    emitAgentProgress(taggedSender, sendId, {
      id: 'run-accepted',
      phase: 'understand',
      title: 'Принял задачу',
      detail: lastUserText ? `Запрос: ${lastUserText}` : 'Получил новое сообщение и готовлю запуск.',
      status: 'done'
    })
    emitAgentProgress(taggedSender, sendId, {
      id: 'context',
      phase: 'context',
      title: 'Собираю контекст',
      detail: 'Проверяю память проекта, настройки чата, скиллы и историю, которые могут повлиять на ответ.',
      status: 'running'
    })
    /**
     * Cleanup MUST handle every dangling state owned by this sendId. Per Gemini
     * audit finding 2.1 + 2.5: previously cleanup only wiped activeAborts,
     * leaving pending confirmations (and their pending Promises) alive
     * forever if the session crashed/aborted before user clicked. That was a
     * silent memory leak AND a source of weird "ghost confirmations" on the
     * next session with similar callId.
     */
    const cleanup = () => {
      clearRunTimeout()
      activeAborts.delete(sendId)
      // Drain pending confirmations for this sendId — resolving with false so
      // any awaiter unwinds cleanly instead of leaking the Promise.
      for (const [k, p] of pendingWrites) {
        if (p.sendId === sendId) { p.resolve(false); pendingWrites.delete(k) }
      }
      for (const [k, p] of pendingCommands) {
        if (p.sendId === sendId) { p.resolve(false); pendingCommands.delete(k) }
      }
      for (const [k, p] of pendingPlans) {
        if (p.sendId === sendId) { p.resolve({ decision: 'reject' }); pendingPlans.delete(k) }
      }
      // #4 suspend: чистим suspendedSends здесь — cleanup идёт для ОБОИХ путей (API+CLI)
      // и любого выхода, иначе CLI-приостановки и race suspend-после-finish копились бы.
      suspendedSends.delete(sendId)
      // ось 3 E: чистим серверный счётчик run_until_green этого прогона (иначе Map течёт).
      clearRunUntilGreenForSend(sendId)
      // APP-04: чистим bounded smart-approve escalation counter этого прогона.
      clearSmartApproveForSend(sendId)
      // sendIdToChatId mapping cleared via separate ai:event done handler in
      // renderer — no need to touch from main.
      // Push-наблюдаемость: на завершении прогона шлём в Telegram done/failed/нужен-
      // ревью (opt-in telegram_notify_chat_id, только main-прогон, только исходящее,
      // не кидает). Финальный статус читаем из agent_runs (finish уже отработал).
      try {
        const run = deps.agentRuns?.get(runId)
        if (run) {
          const durationMs = run.endedAt && run.startedAt ? run.endedAt - run.startedAt : undefined
          void notifyRunEvent({
            status: run.status, owner: run.owner,
            projectName: projectPath ? basename(projectPath) : null,
            costCents: run.costCents, toolCount: run.toolCount, filesCount: run.filesCount,
            durationMs,
            error: run.error,
          }, { getSecret: deps.getSecret })
          if (deps.sendProofReport && !autoProofReportsSent.has(run.runId) && shouldSendAutoProofReport({
            runId: run.runId,
            status: run.status,
            owner: run.owner,
            projectName: projectPath ? basename(projectPath) : null,
            costCents: run.costCents,
            toolCount: run.toolCount,
            filesCount: run.filesCount,
            durationMs,
            error: run.error,
          }, { getSecret: deps.getSecret })) {
            if (autoProofReportsSent.size > 500) autoProofReportsSent.clear()
            autoProofReportsSent.add(run.runId)
            void deps.sendProofReport(run.runId)
          }
        }
      } catch { /* наблюдаемость не должна ломать cleanup */ }
    }

    // Load project's user-layer (AGENTS.md / CLAUDE.md / GEMINI.md / our RULES.md)
    // and prepend the immutable system layer + user layer as a single system message.
    // CLI providers run their own agent inside, so we don't inject for them — the
    // user's AGENTS.md is already picked up by Claude Code / Codex / Grok Build natively.
    //
    // OVERRIDE path (Explicit Review): caller passes its own system prompt
    // (REVIEWER_SYSTEM_PROMPT) and we don't want to also inject the project's
    // user_layer — reviewer prompt is self-contained.
    // Топ-5 воспоминаний проекта — инжектируются в context-pack один раз за
    // app-сессию для данного чата. Вычисляем до ветки API/CLI чтобы CLI-провайдеры
    // тоже получали память через buildCliPrompt → prepareParts.
    const memoryCacheKey = chatId ?? (projectPath ?? '__no_project__')
    const shouldInjectMemory = projectPath && !memorizedChats.has(memoryCacheKey)
    if (shouldInjectMemory) {
      // Safety net: if the Set has grown past 500 entries (process running for
      // many days without restart), clear it entirely. This is a one-time
      // cache miss — memories get re-injected once per affected chat — not data loss.
      if (memorizedChats.size > 500) memorizedChats.clear()
      memorizedChats.add(memoryCacheKey)
    }
    let memories: { type: string; content: string; tags: string[] }[] = []
    let consolidationHint: string | null = null
    let coreMemorySnapshot = { memory: '', user: '' }
    if (projectPath) {
      emitAgentProgress(taggedSender, sendId, {
        id: 'context-memory',
        phase: 'context',
        title: 'Ищу память проекта',
        detail: 'Подбираю сохранённые факты и недавние записи, которые могут быть полезны для ответа.',
        status: 'running'
      })
      try {
        // #1 релевантный recall + ось 4 #1 RRF-fusion: блендим два канала вместо бинарного
        // «релевантные ИЛИ недавние». Канал релевантности (FTS5/BM25 по последнему user-
        // сообщению) ⊕ канал недавности (без session-summary, чтобы не вытесняли факты).
        // Факт и релевантный, и недавний — всплывает выше. Чисто на позициях, без векторов.
        const recallQuery = [...messages].reverse().find(m => m.role === 'user')?.content ?? ''
        const memoryProvider = createLegacyMemoryProvider({
          searchMemories: deps.searchMemories,
          memoryConsolidationHint: deps.memoryConsolidationHint,
        })
        // Ревью HIGH: фильтр session-summary ПОСЛЕ LIMIT обнулял recency-канал — session-summary
        // (свежайший accessed_at, пишутся в конце каждой сессии) занимали топ-5 и все выпадали
        // фильтром, реальные факты не попадали. Берём с запасом (20) ДО фильтра, потом slice(5).
        const memorySnapshot = buildRunMemorySnapshot(memoryProvider, {
          projectPath,
          query: typeof recallQuery === 'string' ? recallQuery : '',
          includeRecall: Boolean(shouldInjectMemory),
        })
        memories = snapshotPromptMemories(memorySnapshot)
        // memory-nudge консолидации (раз на чат, как и recall): если воспоминания
        // накопились/задублировались — мягко предлагаем модели консолидировать.
        consolidationHint = memorySnapshot.consolidationHint
        coreMemorySnapshot = memorySnapshot.coreMemory
        logRuntime('ai.memory.snapshot', {
          sendId,
          runId,
          projectPath,
          entries: memories.length,
          coreMemoryChars: coreMemorySnapshot.memory.length,
          coreUserChars: coreMemorySnapshot.user.length,
          fingerprint: memorySnapshotFingerprint(memorySnapshot),
        })
        emitAgentProgress(taggedSender, sendId, {
          id: 'context-memory',
          phase: 'context',
          title: memories.length > 0 ? 'Память проекта добавлена' : 'Память проверена',
          detail: memories.length > 0
            ? `Нашёл ${memories.length} подходящих записей и добавил их в контекст.`
            : 'Подходящих записей не нашёл, продолжаю по истории чата и настройкам проекта.',
          status: 'done'
        })
      } catch (err) {
        // Память недоступна — продолжаем без неё, не блокируем пользователя
        logRuntimeError('ai.memories.search.fail', err, { sendId, runId, projectPath })
        console.warn('[ai] searchMemories failed:', err instanceof Error ? err.message : err)
        emitAgentProgress(taggedSender, sendId, {
          id: 'context-memory',
          phase: 'context',
          title: 'Память проекта недоступна',
          detail: 'Не блокирую ответ: продолжаю без сохранённой памяти проекта.',
          status: 'done'
        })
      }
    }

    let messagesWithSystem = messages
    // composedSystem — точная system-строка, ушедшая модели в API-пути. Захватываем
    // для Debug Packet (снапшот реального входа run'а). Остаётся null для CLI-пути
    // (CLI строит свой промпт внутри buildCliPrompt — снапшот там пока не делаем) и
    // для reviewer override.
    let composedSystem: string | null = null
    let brain: { content: string; packType: string; tokenEstimate?: number | null } | null = null
    // Этап 4 (Блок C): наслаиваем recipe-протокол на skill-промпт ОДИН раз здесь и
    // используем ниже во всех точках инъекции (API path, CLI fallback, CLI provider).
    // Нет recipe → возвращает overrides.systemPrompt как есть (обычный skill не меняется).
    // Reviewer override не задаёт recipe → изоляция ревьюера не нарушается.
    const skillLayerPrompt = applyRecipeToSkillPrompt(overrides?.systemPrompt, overrides?.recipe)
    emitAgentProgress(taggedSender, sendId, {
      id: 'context-build',
      phase: 'context',
      title: 'Готовлю рабочий запрос',
      detail: descriptor.transport === 'API'
        ? 'Собираю системный слой, память, скиллы, режим чата и последние сообщения в один запрос.'
        : 'Собираю prompt для внешнего CLI-агента с учётом скиллов, памяти и текущего режима.',
      status: 'running'
    })
    // Reviewer override (Explicit Review) — ПОЛНАЯ ЗАМЕНА системного промпта.
    // Ревьюер не является агентом проекта: он читает работу другого AI и даёт
    // независимый разбор. Давать ему system-layer + user-layer = заставить
    // вести себя как сам агент, а не как критик → теряется смысл кросс-ревью.
    // Поэтому reviewer-промпт остаётся единственной системной инструкцией.
    if (resumedMessages && canReplayCheckpoint(checkpointRun, providerId)) {
      // Crash-resume Фаза 2: чекпойнт уже содержит system + полную историю прогона
      // — подаём как есть, минуя пере-сборку контекста. composedSystem остаётся
      // null (Debug-снапшот системы для возобновления не делаем — это продолжение).
      // 1.9.8 #4: только если провайдер совпадает — иначе tool_use-история одного
      // провайдера не ляжет в формат другого (свежий старт по messages безопаснее).
      messagesWithSystem = resumedMessages
    } else if (overrides?.useReviewerPrompt) {
      messagesWithSystem = [{ role: 'system', content: REVIEWER_SYSTEM_PROMPT }, ...messages]
    } else if (descriptor.transport === 'API') {
      // Same assembly path as CLI providers — see ai/compose-system.ts.
      // projectSystemPrompt — пользовательский промпт из Project Settings
      // (UI шестерёнки в Project Rail). Хранится в settings ключом
      // `system_prompt_${path}`. Если пусто — игнорируется.
      const projectSystemPrompt = projectPath ? deps.getSecret(`system_prompt_${projectPath}`) : null
      // Core memory frozen at run start: MEMORY.md + USER.md stay stable for prompt-cache diagnostics.
      const coreMemory = coreMemorySnapshot
      // Project Brain (Итер.4): если проект прогрет и не выключено — инжектим
      // готовый ContextPack под задачу (вместо сборки всего контекста заново).
      const brainOn = deps.getSecret('use_project_brain') !== 'false'
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content ?? ''
      brain = (brainOn && projectPath && deps.getBrainContext)
        ? deps.getBrainContext(projectPath, lastUserMsg) : null
      // Skill override — НАСЛОЕНИЕ, а не замена. Промпт скилла (overrides.systemPrompt)
      // дописывается ПОВЕРХ базового промпта секцией <skill_layer> внутри
      // composeSystemPrompt. Так скилл уточняет роль агента, но базовый протокол
      // выполнения (system-layer 7-шаговый цикл + работа с тулзами) сохраняется —
      // раньше промпт скилла полностью заменял базу и агент терял протокол.
      const composed = await prepareSystemContext({
        projectPath,
        messages,
        recentWrites: projectPath ? deps.recentWrites(projectPath, 8) : [],
        projectSystemPrompt,
        memories,
        consolidationHint: consolidationHint ?? undefined,
        coreMemory,
        agentMode,
        brainContext: brain?.content ?? null,
        skillPrompt: skillLayerPrompt ?? undefined,
        // Output style (формат/персона ответа) — глобальная настройка, инжектится
        // в user_layer секцией. 'default'/пусто → ничего не добавляется. ЛИМИТ: только
        // API-путь; CLI-провайдеры (claude-cli/codex-cli/grok-cli/gemini-cli) строят свой
        // промпт в buildCliPrompt без outputStyle — стиль на них не применяется (известный
        // CLI-parity лимит, как бинарные вложения; см. CLAUDE.md §5.2).
        outputStyle: deps.getSecret('output_style')
      })
      // Наслоение интенсивности (<intensity>) поверх собранного промпта — стерёт
      // поведение под Простой/Турбо. Простой-подсказка нейтральна к сегодняшнему
      // поведению (один прямой путь), Турбо — поощряет всю машинерию.
      composedSystem = composed.system + '\n\n' + intCfg.systemHint
      // Prompt caching: 'claude' получает маркер (сам режет и кэширует стабильный
      // префикс), остальные провайдеры — снятый маркер (авто-кэш по стабильному
      // префиксу OpenAI/DeepSeek/Gemini implicit). Порядок stable→volatile уже задан
      // в composeSystemPrompt — этого достаточно для implicit-кэша прочих.
      messagesWithSystem = [{ role: 'system', content: systemForProvider(composedSystem, providerId) }, ...messages]
    } else if (overrides?.systemPrompt) {
      // Не-API (CLI) транспорт со скилл-override. CLI-провайдеры строят свой
      // системный промпт внутри buildCliPrompt и игнорируют system-сообщение в
      // messages (cli-prompt.ts фильтрует role==='system'). Сам скилл наслаивается
      // для CLI через skillPromptForProvider → createProvider → buildCliPrompt
      // секцией <skill_layer> (см. ниже). Это system-сообщение — безвредный
      // fallback для гипотетических не-CLI не-API провайдеров (CLI его отфильтрует).
      messagesWithSystem = [{ role: 'system', content: skillLayerPrompt ?? overrides.systemPrompt }, ...messages]
    }

    // Project Brain (Итер.4 + Phase 3): бейдж «использован прогретый контекст» +
    // метрика экономии — сколько токенов контекста мозг дал готовыми (агент не
    // пере-сканировал проект). Честный показатель ценности прогрева.
    emitAgentProgress(taggedSender, sendId, {
      id: 'context-build',
      phase: 'context',
      title: 'Рабочий контекст готов',
      detail: descriptor.transport === 'API'
        ? 'Передаю модели собранный контекст и историю чата.'
        : 'Передаю внешнему агенту подготовленный prompt.',
      status: 'done'
    })

    if (brain) {
      const te = brain.tokenEstimate
      const saved = te && te > 0
        ? ` · ~${te >= 1000 ? (te / 1000).toFixed(1) + 'k' : String(te)} токенов контекста готовы`
        : ''
      taggedSender.send('ai:event', { id: sendId, event: { type: 'info', text: `🧠 Мозг проекта · ${brain.packType}${saved}` } })
    }

    // Resolve API key (or null for CLI)
    const apiKey = descriptor.secretKey ? deps.getSecret(descriptor.secretKey) : null
    if (descriptor.secretKey && !apiKey) {
      taggedSender.send('ai:event', {
        id: 0,
        event: {
          type: 'error',
          message: `API ключ для ${descriptor.name} не задан. Открой настройки и добавь ключ или переключи провайдера.`
        }
      })
      cleanup()
      return 0
    }

    let model = (overrides?.model ?? deps.getProviderModel(providerId)) ?? descriptor.defaultModel
    logRuntime('ai.send.start', {
      sendId,
      runId,
      projectPath,
      chatId: chatId ?? null,
      providerId,
      model,
      transport: descriptor.transport,
      agentMode,
      messageCount: messages.length,
      inputChars: messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
      overrideKeys: overrides ? Object.keys(overrides) : []
    })

    // Smart routing: если пользователь не задал модель явно и effort=standard,
    // выбираем дешёвую/мощную модель по сложности запроса.
    const smartRoutingEnabled = deps.getSecret('smart_routing') !== 'false'
    if (
      smartRoutingEnabled &&
      !overrides?.model &&
      !overrides?.providerId &&          // не в Explicit Review
      resolvedEffort === 'standard' &&
      descriptor.transport === 'API'
    ) {
      const complexity = estimateComplexity(messages, [])
      const suggested = recommendModel(providerId, complexity)
      if (suggested && suggested !== model) {
        const previousModel = model
        model = suggested
        logRuntime('ai.smart_routing.pick', {
          sendId,
          runId,
          providerId,
          previousModel,
          model,
          complexity: complexityLabel(complexity)
        })
        taggedSender.send('ai:event', {
          id: sendId,
          event: {
            type: 'info',
            text: `📊 ${complexityLabel(complexity)} → using ${suggested} (smart routing)`
          }
        })
      }
    }

    // Гибридный роутинг API↔CLI (Сценарий Б). Если активен API-провайдер, а
    // задача «терминальная» (сборка/тесты/итеративная отладка) — подсказываем,
    // что автономнее её сделает CLI-агент. Поведение НЕ меняем: молчаливого
    // свитча нет (контроль/прозрачность — ядро Verstak), только info-подсказка.
    if (smartRoutingEnabled && descriptor.transport === 'API') {
      const cliHint = detectCliWorthiness(messages)
      if (cliHint) {
        taggedSender.send('ai:event', {
          id: sendId,
          event: {
            type: 'info',
            text: `🔧 Похоже на терминальную задачу: ${cliHint.reason}. Автономнее справится CLI-агент (Claude Code/Codex) — переключи провайдер в селекторе или попроси делегировать шаг на CLI.`
          }
        })
      }
    }

    // Debug Packet: снапшот реального входа run'а. Только API-путь, где собран
    // композитный system prompt (composedSystem != null). model уже финализирован
    // smart-routing'ом выше. Берём контент последнего user-сообщения как user_message.
    if (composedSystem != null && deps.saveRunInput) {
      const lastUser = [...messages].reverse().find(m => m.role === 'user')
      try {
        deps.saveRunInput({
          runId,
          projectPath,
          chatId: chatId ? Number(chatId) : null,
          timestamp: Date.now(),
          providerId,
          model: model ?? null,
          systemPrompt: stripCacheBreakpoint(composedSystem),
          userMessage: lastUser?.content ?? ''
        })
      } catch { /* snapshot not critical */ }
    }

    // Project Settings system prompt — нужен и для API (через
    // prepareSystemContext выше), и для CLI (через createCliProvider →
    // buildCliPrompt). Читаем один раз. Не пробрасываем при reviewer override —
    // ревьюер работает в изоляции, не должен подхватывать project-prompt.
    const projectSystemPromptForProvider = (overrides?.useReviewerPrompt || overrides?.systemPrompt)
      ? null
      : (projectPath ? deps.getSecret(`system_prompt_${projectPath}`) : null)
    // Skill-промпт для CLI-провайдеров: наслаивается секцией <skill_layer> внутри
    // buildCliPrompt (как в API-пути). Не пробрасываем при reviewer override —
    // ревьюер работает в изоляции. Уже содержит anti-stall nudge (Chat.tsx).
    const skillPromptForProvider = overrides?.useReviewerPrompt ? null : (skillLayerPrompt ?? null)

    // Debug Packet для CLI-провайдеров. API-путь снапшотит composedSystem выше;
    // CLI строит свой stdin-payload внутри buildCliPrompt и раньше ничего не
    // сохранял — Debug Packet был «слепым» для claude-cli/codex-cli/grok-cli/
    // gemini-cli. Здесь вызываем buildCliPrompt ВТОРОЙ раз ровно с теми же опциями,
    // что использует сам CLI-провайдер (см. *-cli.ts: projectPath=cwd, без
    // recentWrites, projectSystemPrompt/skillPrompt/memories пробрасываются),
    // чтобы сохранённый промпт совпадал с реально отправленным. Лишний вызов —
    // приемлемая цена ради отладочной фичи; никогда не блокирует run (try/catch).
    if (descriptor.transport === 'CLI' && deps.saveRunInput) {
      const lastUser = [...messages].reverse().find(m => m.role === 'user')
      try {
        const cliPayload = await buildCliPrompt({
          providerId: providerId as CliProviderId,
          projectPath: projectPath ?? process.cwd(),
          messages,
          projectSystemPrompt: projectSystemPromptForProvider,
          skillPrompt: skillPromptForProvider,
          memories,
          consolidationHint: consolidationHint ?? undefined
        })
        deps.saveRunInput({
          runId,
          projectPath,
          chatId: chatId ? Number(chatId) : null,
          timestamp: Date.now(),
          providerId,
          model: model ?? null,
          systemPrompt: cliPayload,
          userMessage: lastUser?.content ?? ''
        })
      } catch { /* snapshot not critical — CLI run continues unaffected */ }
    }

    emitAgentProgress(taggedSender, sendId, {
      id: 'provider-create',
      phase: 'model',
      title: 'Подключаю модель',
      detail: modelProgressLabel(providerId, model),
      status: 'running'
    })
    let provider: ChatProvider
    try {
      // Claude Code OAuth token (из `claude setup-token`) — для headless+Max.
      // 1.9.3 мультиаккаунт: если заведён активный claude-cli аккаунт — берём его токен
      // (пул Claude Max, ротация лимита); иначе падаем на legacy-одиночный токен settings.
      const claudeAccount = providerId === 'claude-cli'
        ? (deps.resolveSubscriptionAccount?.('claude-cli') ?? null)
        : null
      const claudeOauthToken = providerId === 'claude-cli'
        ? (claudeAccount?.secret ?? deps.getSecret('claude_code_oauth_token'))
        : null
      // Codex мультиаккаунт: активный codex-cli аккаунт → изолированный CODEX_HOME (config-dir).
      const codexHome = providerId === 'codex-cli'
        ? (deps.resolveSubscriptionAccount?.('codex-cli')?.configDir ?? null)
        : null
      // custom-openai: baseUrl + список моделей задаются юзером в Settings.
      // models приходят как comma-separated string; парсим в массив.
      let customBaseUrl: string | undefined
      let customModels: string[] | undefined
      if (providerId === 'custom-openai') {
        customBaseUrl = deps.getSecret('custom_openai_baseurl') ?? undefined
        const modelsRaw = deps.getSecret('custom_openai_models')
        if (modelsRaw) {
          customModels = modelsRaw.split(',').map(s => s.trim()).filter(Boolean)
        }
      } else if (providerId === 'verstak-gateway') {
        // Override РФ-релея без релиза (kill-switch): задан verstak_gateway_baseurl —
        // используем его вместо дефолтного релея. Пусто → дефолт из spec.
        customBaseUrl = deps.getSecret('verstak_gateway_baseurl') ?? undefined
      }
      // YandexGPT и GigaChat имеют по второму секрету: yandex_folder_id и
      // gigachat_client_secret. Они хранятся отдельно в SafeStorage и
      // пробрасываются в registry.createProvider() через extension options.
      const yandexFolderId = providerId === 'yandex-gpt'
        ? (deps.getSecret('yandex_folder_id') ?? undefined)
        : undefined
      const gigachatClientSecret = providerId === 'gigachat'
        ? (deps.getSecret('gigachat_client_secret') ?? undefined)
        : undefined
      // Аудит M3: TLS-верификация GigaChat по настройке (по умолчанию выкл).
      const gigachatTlsVerify = providerId === 'gigachat'
        ? (deps.getSecret('gigachat_tls_verify') === 'true')
        : undefined
      provider = createProvider(providerId, {
        apiKey,
        model,
        cwd: projectPath ?? process.cwd(),
        signal: ctrl.signal,
        projectSystemPrompt: projectSystemPromptForProvider,
        skillPrompt: skillPromptForProvider,
        claudeOauthToken,
        codexHome,
        customBaseUrl,
        customModels,
        yandexFolderId,
        gigachatClientSecret,
        gigachatTlsVerify,
        memories: descriptor.transport === 'CLI' ? memories : undefined,
        effortLevel: resolvedEffort,
        agentMode
      })
      logRuntime('ai.provider.created', { sendId, runId, providerId, model, transport: descriptor.transport })
      emitAgentProgress(taggedSender, sendId, {
        id: 'provider-create',
        phase: 'model',
        title: 'Модель подключена',
        detail: `${modelProgressLabel(providerId, model)} · ${descriptor.transport}`,
        status: 'done'
      })
    } catch (err) {
      logRuntimeError('ai.provider.create.fail', err, { sendId, runId, providerId, model })
      emitAgentProgress(taggedSender, sendId, {
        id: 'provider-create',
        phase: 'model',
        title: 'Не удалось подключить модель',
        detail: err instanceof Error ? err.message : String(err),
        status: 'error'
      })
      taggedSender.send('ai:event', {
        id: 0,
        event: { type: 'error', message: err instanceof Error ? err.message : String(err) }
      })
      cleanup()
      return 0
    }

    // Cost guard для всей сессии (turns of API loop). Если settings задан
    // cost_cap_usd_per_session — guard.recordAndCheck остановит цикл при
    // превышении. CLI = подписка = $0 (guard эффективно отключен).
    const capRaw = deps.getSecret('cost_cap_usd_per_session')
    const capUsd = capRaw ? parseFloat(capRaw) : null
    const costGuard = createCostGuard(capUsd && capUsd > 0 ? capUsd : null)

    // Multi-agent Manager (Фаза 2): один ai:send = одна строка agent_runs.
    // Owner определяется по реально доступному в main сигналу: Explicit Review
    // форсит reviewer-промпт (useReviewerPrompt) → owner='review'; всё остальное
    // через этот путь — обычный чат → 'main'. autonomous loop НЕ проходит через
    // runApiConversation/runPlainConversation (зовёт provider.send напрямую),
    // поэтому 'background' здесь недостижим — он будет проставлен из autonomous,
    // если/когда тот начнёт писать прогоны. finish вызывают сами runner'ы в
    // finally по exitReason. Best-effort: agentRuns опционален + try/catch.
    const runOwner: AgentRunOwner = overrides?.useReviewerPrompt ? 'review' : 'main'
    const runTitle = ([...messages].reverse().find(m => m.role === 'user')?.content ?? '').slice(0, 120)
    let runGeneration = 0
    try {
      const createdGeneration = deps.agentRuns?.create({
        runId,
        projectPath: projectPath ?? '',
        chatId: chatId ? Number(chatId) : null,
        owner: runOwner,
        title: runTitle,
        providerId,
        model: model ?? null,
        sendId,
        // Crash-resume: режим прогона — гард деструктива в баннере возобновления
        // (auto/bypass → авто-resume запрещён).
        agentMode
      })
      // Timeline: исходный запрос пользователя первым событием — чтобы лента
      // читалась как нарратив (запрос → действия → итог), а не только механика.
      if (typeof createdGeneration === 'number') runGeneration = createdGeneration
      logRuntime('agent_runs.create', {
        runId,
        sendId,
        projectPath,
        chatId: chatId ? Number(chatId) : null,
        owner: runOwner,
        providerId,
        model,
        generation: runGeneration
      })
      if (runTitle) deps.agentRuns?.appendEvent(runId, 'user_msg', { detail: runTitle })
    } catch (err) {
      logRuntimeError('agent_runs.create.fail', err, { runId, sendId, projectPath, chatId: chatId ?? null })
      console.warn('[agent-runs] create failed:', err instanceof Error ? err.message : err)
    }

    // Dev Task Flow (Фаза 2): если у активного чата есть открытая dev_task —
    // привязываем этот прогон к ней (один dev_task ↔ N run_id). Не для review-
    // прогонов (их активность к задаче не относится). Best-effort.
    if (projectPath && runOwner === 'main') {
      try {
        deps.linkDevTaskRun?.(projectPath, chatId ? Number(chatId) : null, runId)
      } catch (err) {
        logRuntimeError('dev_task.link_run.fail', err, { runId, sendId, projectPath, chatId: chatId ?? null })
        console.warn('[dev-task] linkDevTaskRun failed:', err instanceof Error ? err.message : err)
      }
    }

    const timeoutPolicy = resolveAgentRunTimeoutPolicy(deps.getSecret(AGENT_RUN_TIMEOUT_SETTING_KEY))
    const timeoutMinutes = Math.max(1, Math.round(timeoutPolicy.timeoutMs / 60_000))
    const timeoutMessage = `Прогон остановлен по таймауту ${timeoutMinutes} мин. Можно переотправить задачу или увеличить agent_run_timeout_ms.`
    runTimeout = setTimeout(() => {
      // M2: не слать таймаут, если прогон уже оборван ИЛИ уже успешно завершён
      // (endedAt проставлен finish() до clearRunTimeout в cleanup) — иначе ложный
      // timeout-тост на успешном прогоне в окне гонки finish→clearTimeout.
      if (!shouldFireRunTimeout(ctrl.signal.aborted, deps.agentRuns?.get(runId)?.endedAt)) return
      logRuntime('ai.run.timeout', {
        sendId,
        runId,
        projectPath,
        chatId: chatId ?? null,
        providerId,
        model,
        timeoutMs: timeoutPolicy.timeoutMs,
        source: timeoutPolicy.source,
        clamped: timeoutPolicy.clamped
      }, 'warn')
      try {
        deps.agentRuns?.appendEvent(runId, 'status', {
          label: 'timeout',
          detail: timeoutMessage,
          status: 'timed_out'
        })
        deps.agentRuns?.finish(runId, 'timed_out', { error: timeoutMessage })
      } catch (err) {
        logRuntimeError('agent_runs.timeout.finish.fail', err, { runId, sendId, projectPath })
      }
      taggedSender.send('ai:event', { id: sendId, event: { type: 'error', message: timeoutMessage } })
      abortAgentRunForTimeout(ctrl, timeoutPolicy.timeoutMs)
    }, timeoutPolicy.timeoutMs)
    runTimeout.unref?.()

    // Force-plain path: review uses no tools regardless of provider capability.
    const useToolsPath = !overrides?.noTools && descriptor.supportsTools && projectPath

    // Smart fallback: при ошибке (429/5xx/сеть) пробуем следующего провайдера.
    // Только если smart_fallback не отключён явно, только для API-провайдеров,
    // только без reviewer override (ревьюер работает в изоляции).
    const smartFallbackEnabled = deps.getSecret('smart_fallback') !== 'false'
      && descriptor.transport === 'API'
      && !overrides?.providerId  // не задействуем fallback в Explicit Review

    /** Создаёт провайдера для fallback-кандидата с теми же опциями. */
    function makeFallbackProvider(fallbackId: ProviderId): ChatProvider | null {
      const fallbackDesc = PROVIDERS[fallbackId]
      if (!fallbackDesc) return null
      const fallbackKey = fallbackDesc.secretKey ? deps.getSecret(fallbackDesc.secretKey) : null
      if (fallbackDesc.secretKey && !fallbackKey) return null
      const fallbackModel = deps.getProviderModel(fallbackId) ?? fallbackDesc.defaultModel
      // 1.9.3/1.9.4: при пересоздании CLI-провайдера резолвим активный аккаунт ЗАНОВО —
      // для account-switch на лимите берётся новый токен/CODEX_HOME переключённого аккаунта.
      const fbClaudeToken = fallbackId === 'claude-cli'
        ? (deps.resolveSubscriptionAccount?.('claude-cli')?.secret ?? deps.getSecret('claude_code_oauth_token'))
        : null
      const fbCodexHome = fallbackId === 'codex-cli'
        ? (deps.resolveSubscriptionAccount?.('codex-cli')?.configDir ?? null)
        : null
      try {
        return createProvider(fallbackId, {
          apiKey: fallbackKey,
          model: fallbackModel,
          cwd: projectPath ?? process.cwd(),
          signal: ctrl.signal,
          projectSystemPrompt: projectSystemPromptForProvider,
          skillPrompt: skillPromptForProvider,
          effortLevel: overrides?.effortLevel,
          agentMode,
          claudeOauthToken: fbClaudeToken,
          codexHome: fbCodexHome
        })
      } catch {
        return null
      }
    }

    if (useToolsPath) {
      // projectPath здесь уже = worktree для изолированного чата (реассайн выше),
      // так что и tools, и весь контекст/undo работают на изолированном дереве.
      // #5: изолированный чат → весь прогон на его worktree (tools + ctx.projectPath →
      // recordWrite/undo/context). projectPath здесь narrowed string, isolatedRoot — наш.
      const runRoot = isolatedRoot ?? projectPath
      const tools = createToolsForProject(runRoot, ctrl.signal, {
        allowedWriteRoots: parseAllowedWriteRoots(deps.getSecret(ALLOWED_WRITE_ROOTS_KEY))
      })
      const turnsBudget = Math.min(MAX_BUDGET_TURNS, Math.max(DEFAULT_AGENT_TURNS, budget ?? DEFAULT_AGENT_TURNS))
      const auditFn = deps.appendAudit
        ? (action: string, detail: string) => {
            try {
              deps.appendAudit!(projectPath, chatId ? Number(chatId) : null, action, detail, providerId, model ?? null, runId)
            } catch { /* audit not critical */ }
          }
        : undefined
      // Run-start маркер: одна audit-запись на старте run'а с самим runId.
      // Инспектор группирует по runId; этот маркер также даёт точку отсчёта run'а
      // (и сохраняет совместимость с эвристикой session_start для легаси-строк).
      if (auditFn) auditFn('session_start', JSON.stringify({ runId, sendId }))
      logRuntime('ai.runner.start', {
        sendId,
        runId,
        path: 'api-tools',
        providerId,
        model,
        turnsBudget,
        toolCount: TOOL_DEFS.length
      })
      emitAgentProgress(taggedSender, sendId, {
        id: 'agent-loop',
        phase: 'model',
        title: 'Запускаю агентный цикл',
        detail: `Модель может отвечать текстом или вызывать инструменты. Лимит шагов: ${turnsBudget}.`,
        status: 'running'
      })
      void runApiConversation({
        sender: taggedSender, sendId, provider, tools, projectPath: runRoot,
        initialMessages: messagesWithSystem, signal: ctrl.signal,
        recordWrite: deps.recordWrite, recordPlan: deps.recordPlan,
        recordJournal: deps.recordJournal, readJournal: deps.readJournal,
        saveMemory: deps.saveMemory, saveDecision: deps.saveDecision, invalidateMemory: deps.invalidateMemory,
        searchMemories: deps.searchMemories, searchConversations: deps.searchConversations,
        connectors: deps.connectors, agentMode, turnsBudget,
        skillRegistry: deps.skillRegistry, getSecretForDelegate: deps.getSecret, costGuard,
        providerId, model,
        fallbackOpts: smartFallbackEnabled ? { getNextProvider: makeFallbackProvider, getProviderModel: (id) => deps.getProviderModel(id) ?? PROVIDERS[id]?.defaultModel ?? null, configuredProviders: new Set(getConfiguredApiProviders(deps.getSecret)), triedProviders: new Set([providerId]), switchAccountOnLimit: deps.switchSubscriptionAccountOnLimit } : undefined,
        mcpClientRef: deps.mcpClient, appendAuditFn: auditFn, trackToolPatternFn: deps.trackToolPattern,
        parentChatId: chatId ? Number(chatId) : null,
        subSessions: deps.subSessions, sessionTodos: deps.sessionTodos,
        agentRuns: deps.agentRuns, runId, verifications: deps.verifications,
        toolsAllow: overrides?.toolsAllow ?? null,
        recipe: overrides?.recipe,
      }).finally(cleanup)
    } else {
      logRuntime('ai.runner.start', {
        sendId,
        runId,
        path: 'plain',
        providerId,
        model,
        transport: descriptor.transport
      })
      emitAgentProgress(taggedSender, sendId, {
        id: 'plain-loop',
        phase: 'model',
        title: 'Передаю задачу модели',
        detail: `${modelProgressLabel(providerId, model)} получил запрос. Жду первые признаки работы.`,
        status: 'running'
      })
      void runPlainConversation(taggedSender, sendId, provider, projectPath, messagesWithSystem, ctrl.signal, deps.recordJournal, costGuard, providerId, model,
        smartFallbackEnabled ? { getNextProvider: makeFallbackProvider, getProviderModel: (id) => deps.getProviderModel(id) ?? PROVIDERS[id]?.defaultModel ?? null, configuredProviders: new Set(getConfiguredApiProviders(deps.getSecret)), triedProviders: new Set([providerId]), switchAccountOnLimit: deps.switchSubscriptionAccountOnLimit } : undefined,
        deps.agentRuns,
        runId
      ).finally(cleanup)
    }
    return sendId
  })

  ipcMain.handle('ai:stop', (_e, sendId: number) => abortSend(sendId))

  // #4 suspend: приостановить прогон = abort, НО прогон помечается 'suspended'
  // (не 'stopped') и чекпойнт сохраняется (он и так держится на abort) → ↻ Продолжить.
  ipcMain.handle('ai:suspend', (_e, sendId: number) => {
    suspendedSends.add(sendId)
    return abortSend(sendId)
  })

  ipcMain.handle('ai:append-context', (_e, sendId: number, text: string) => {
    const trimmed = String(text ?? '').trim()
    if (!trimmed || sendId <= 0) return { ok: false as const, fallback: 'invalid' as const }
    const mode = pushConversationSupplement(sendId, trimmed)
    if (!mode) return { ok: false as const, fallback: 'unavailable' as const }
    return { ok: true as const, mode }
  })

  ipcMain.handle('ai:resolve-write', (_e, callId: string, accept: boolean, sendId?: number) => {
    // If renderer knows sendId (it should — Chat.tsx stores it after ai:send),
    // use strict key lookup. Fallback to suffix scan for backward compat with
    // older renderer code paths.
    if (typeof sendId === 'number' && sendId > 0) {
      const key = scopedKey(sendId, callId)
      const exact = pendingWrites.get(key)
      if (exact) { exact.resolve(accept); pendingWrites.delete(key); return }
    }
    for (const [k, p] of pendingWrites) {
      if (k.endsWith('::' + callId)) {
        p.resolve(accept)
        pendingWrites.delete(k)
        return
      }
    }
  })

  /**
   * Count tokens for an outgoing prompt before send. Lets the renderer show a
   * "≈ N tokens, ~$X" preview in the composer. Only implemented for providers
   * that expose a real countTokens API — others get a rough estimate.
   */
  ipcMain.handle('ai:count-tokens', async (_e, text: string, projectPath: string | null, historyMessages?: ChatMessage[]) => {
    const providerId = deps.getProviderId()
    const descriptor = PROVIDERS[providerId]
    const apiKey = descriptor.secretKey ? deps.getSecret(descriptor.secretKey) : null
    // No API key or CLI provider — fall back to a rough heuristic (~4 chars/token)
    if (!apiKey || descriptor.transport !== 'API') {
      const rough = Math.ceil((text?.length ?? 0) / 4)
      return { tokens: rough, exact: false, providerId }
    }
    try {
      // Currently we have a true countTokens path only for Gemini API. Others
      // use the heuristic — extend as we add adapters.
      if (providerId === 'gemini-api') {
        const { GoogleGenAI } = await import('@google/genai')
        const client = new GoogleGenAI({ apiKey })
        const model = deps.getProviderModel(providerId) ?? descriptor.defaultModel
        // Same compose path as ai:send — keeps countTokens estimate aligned
        // with what actually gets sent on the next ai:send.
        // Build the FULL context the next ai:send would see: system + history
        // + draft text. Without history the estimate could be off by orders of
        // magnitude on long conversations (50+ msgs → ~20k tokens of history).
        const history = Array.isArray(historyMessages) ? historyMessages : []
        // Include memories so the token count matches what ai:send actually sends.
        let countTokensMemories: { type: string; content: string; tags: string[] }[] = []
        if (projectPath) {
          try {
            countTokensMemories = deps.searchMemories(projectPath, '', 5)
          } catch { /* ignore — token count stays a bit low rather than throwing */ }
        }
        const composed = await prepareSystemContext({
          projectPath,
          messages: history,
          recentWrites: projectPath ? deps.recentWrites(projectPath, 8) : [],
          memories: countTokensMemories
        })
        // Full context size: system + every prior turn + the draft text.
        const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [
          { role: 'user', parts: [{ text: stripCacheBreakpoint(composed.system) }] }
        ]
        for (const m of history) {
          if (m.role === 'system') continue  // already in composed.system
          contents.push({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content ?? '' }]
          })
        }
        if (text) contents.push({ role: 'user', parts: [{ text }] })
        const res = await (client.models as unknown as {
          countTokens: (opts: { model: string; contents: typeof contents }) => Promise<{ totalTokens?: number }>
        }).countTokens({ model, contents })
        return { tokens: res.totalTokens ?? 0, exact: true, providerId }
      }
    } catch (err) {
      console.error('[count-tokens]', err instanceof Error ? err.message : err)
    }
    return { tokens: Math.ceil((text?.length ?? 0) / 4), exact: false, providerId }
  })

  ipcMain.handle('ai:resolve-command', (_e, callId: string, accept: boolean, sendId?: number) => {
    if (typeof sendId === 'number' && sendId > 0) {
      const key = scopedKey(sendId, callId)
      const exact = pendingCommands.get(key)
      if (exact) { exact.resolve(accept); pendingCommands.delete(key); return }
    }
    for (const [k, p] of pendingCommands) {
      if (k.endsWith('::' + callId)) {
        p.resolve(accept)
        pendingCommands.delete(k)
        return
      }
    }
  })

  // #3 plan-gate: решение пользователя по предложенному плану (Approve/Revise/Reject).
  ipcMain.handle('ai:resolve-plan', (_e, callId: string, decision: 'approve' | 'revise' | 'reject', feedback?: string, sendId?: number) => {
    const payload = { decision, feedback }
    if (typeof sendId === 'number' && sendId > 0) {
      const key = scopedKey(sendId, callId)
      const exact = pendingPlans.get(key)
      if (exact) { exact.resolve(payload); pendingPlans.delete(key); return }
    }
    for (const [k, p] of pendingPlans) {
      if (k.endsWith('::' + callId)) {
        p.resolve(payload)
        pendingPlans.delete(k)
        return
      }
    }
  })
}

// Type re-exports for renderer (api.d.ts)
export type { UsageDelta } from '../ai/types'

/**
 * Full agentic loop with file tools + diff confirmation + command sandbox.
 * Only providers that support function calling go through here.
 */
const DEFAULT_AGENT_TURNS = 8
const MAX_BUDGET_TURNS = 40  // hard ceiling even with continues — prevents infinite-budget abuse
const FOCUS_REINJECT_EVERY = 8  // ось 3 C: каждые N ходов реинъект незакрытого todo-листа (анти-дрейф)


/**
 * Контекст одного агентного прогона. Заменил 34 позиционных параметра
 * runApiConversation — один сдвиг аргумента давал silent type-compatible bug
 * (многие поля — опциональные функции схожих сигнатур), а fallback-рекурсия
 * повторяла все 34 вручную. Теперь сборка одна (в ai:send), fallback = {...ctx}.
 */
export interface AgentRunContext {
  sender: TaggedSender
  sendId: number
  provider: ChatProvider
  tools: ReturnType<typeof createFileTools>
  projectPath: string
  initialMessages: ChatMessage[]
  signal: AbortSignal
  recordWrite: (projectPath: string, filePath: string, before: string | null, after: string) => void
  recordPlan: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) => { id: number }
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void
  readJournal: (projectPath: string, limit: number) => Array<{ kind: string; title: string; detail: string | null; createdAt: number }>
  saveMemory: AiDeps['saveMemory']
  invalidateMemory: AiDeps['invalidateMemory']
  saveDecision: AiDeps['saveDecision']
  searchMemories: AiDeps['searchMemories']
  searchConversations: AiDeps['searchConversations']
  connectors: {
    list: () => Array<{ id: string; label: string; kind: string; status: string; detail?: string }>
    query: (id: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  }
  agentMode: AgentMode
  turnsBudget?: number
  skillRegistry?: AiDeps['skillRegistry']
  getSecretForDelegate?: AiDeps['getSecret']
  costGuard?: ReturnType<typeof createCostGuard>
  providerId?: ProviderId
  model?: string
  fallbackOpts?: FallbackOpts
  mcpClientRef?: McpClient
  appendAuditFn?: (action: string, detail: string) => void
  trackToolPatternFn?: (projectPath: string, event: ToolEvent) => void
  parentChatId?: number | null
  subSessions?: AiDeps['subSessions']
  sessionTodos?: AiDeps['sessionTodos']
  agentRuns?: AgentRuns
  runId?: string
  verifications?: AiDeps['verifications']
  toolsAllow?: string[] | null
  processRegistry?: ProcessRegistry
  /** F1-фикс: помечает рекурсивный smart-fallback-фрейм. SessionStart/UserPromptSubmit-
   *  хуки НЕ перефаерятся в нём (симметрично Stop-хуку под !handedOff) — иначе на одну
   *  отправку при N фолбэках старт-хуки исполнились бы N+1 раз. */
  isFallbackFrame?: boolean
  /** Этап 2: принудительный tool-mode для этого фрейма. Ставится в 'json', когда
   *  native tool-calling доказанно не сработал (модель проигнорировала tools) —
   *  тот же провайдер/модель перезапускается с JSON-инструкцией вызова. */
  forceToolMode?: 'native' | 'json'
  /** Этап 6: active recipe этого прогона (тот же, что наслаивается на skill-промпт).
   *  Включает enforcement: авто-снапшот baseline при recipe.verify (P1) и
   *  обязательный review gate при recipe.reviewer.required (P2). Нет recipe →
   *  обычный agent run без enforcement. */
  recipe?: RecipeSpec
}

export async function runApiConversation(ctx: AgentRunContext): Promise<void> {
  const {
    sender, sendId, provider, tools, projectPath, initialMessages, signal,
    recordWrite, recordPlan, recordJournal, readJournal, saveMemory, saveDecision, invalidateMemory,
    searchMemories, searchConversations, connectors, agentMode,
    turnsBudget = DEFAULT_AGENT_TURNS, skillRegistry, getSecretForDelegate, costGuard,
    providerId, model, fallbackOpts, mcpClientRef, appendAuditFn, trackToolPatternFn,
    parentChatId, subSessions, sessionTodos, agentRuns, runId, verifications, toolsAllow,
    processRegistry = globalProcessRegistry,
    isFallbackFrame,
  } = ctx
  const startedAt = Date.now()
  logRuntime('ai.runner.loop_start', {
    sendId,
    runId: runId ?? null,
    path: 'api-tools',
    projectPath,
    providerId: providerId ?? null,
    model: model ?? null,
    turnsBudget,
    toolCount: TOOL_DEFS.length,
    messageCount: initialMessages.length
  })
  emitAgentProgress(sender, sendId, {
    id: 'agent-loop',
    phase: 'model',
    title: 'Агентный цикл запущен',
    detail: `Готовлю пошаговую работу: до ${turnsBudget} шагов, доступно инструментов: ${TOOL_DEFS.length}.`,
    status: 'running'
  })
  // #3 plan-gate: режим прогона — МУТАБЕЛЬНЫЙ holder (не per-turn const). approve
  // плана переключает его на accept-edits через ctx.setAgentMode, и СЛЕДУЮЩИЙ turn
  // (где ctx пересоздаётся) видит новый режим — иначе одобренный план не выполнить.
  let runAgentMode = agentMode
  // F2: декларативные permission-правила allow/deny/ask по паттернам (~/.verstak +
  // project). Грузим один раз на прогон (deny бьёт даже bypass; правила не ослабляют
  // plan). Пусто, если файлов нет — no-op, обратная совместимость.
  const permissionRules = loadPermissionRules(projectPath)
  // H (ось 3): new_task — агент пакует дистиллят, контекст очищается до него на след. turn
  // (как компакция, но по запросу агента и с его резюме). Холдер уровня прогона.
  let pendingNewTask: string | null = null
  const currentMessages = [...initialMessages]
  // H-фиксы (ревью): при new_task сохраняем БАЗОВЫЙ system-промпт (протокол/память/правила
  // живут ТОЛЬКО как currentMessages[0]) и ИСХОДНУЮ задачу юзера — иначе агент теряет
  // протокол и цель на весь остаток прогона. Захватываем до любого wipe.
  const baseSystemMsg = currentMessages.find(m => m.role === 'system') ?? null
  const originalUserMsg = currentMessages.find(m => m.role === 'user') ?? null
  // Hardening (китайские/reasoning-модели): для 'json'-режима (deepseek-reasoner,
  // Ollama и т.п. — native function calling не работает) один раз инжектим
  // инструкцию отдавать вызов инструмента текстом <tool_call>{…}</tool_call> —
  // его уже ловит parseTextToolCalls. Только при наличии тулзов и не в fallback-
  // фрейме (иначе дубль). Для 'native' — no-op, поведение не меняется.
  if (projectPath && resolveToolMode(providerId, model, ctx.forceToolMode) === 'json'
      && (!isFallbackFrame || ctx.forceToolMode === 'json')) {
    const sysIdx = currentMessages.findIndex(m => m.role === 'system')
    currentMessages.splice(sysIdx >= 0 ? sysIdx + 1 : 0, 0, { role: 'system', content: JSON_TOOL_INSTRUCTION })
  }
  const pendingSupplements: string[] = []
  registerConversationSupplements(sendId, (text: string) => {
    pendingSupplements.push(text)
  })
  const drainSupplements = (): boolean => {
    let added = false
    while (pendingSupplements.length > 0) {
      const text = pendingSupplements.shift()!
      currentMessages.push({
        role: 'user',
        content: formatConversationSupplement(text)
      })
      emitAgentProgress(sender, sendId, {
        id: `supplement-${Date.now()}`,
        phase: 'context',
        title: 'Добавил новый контекст в текущую задачу',
        detail: compactProgressText(text, 180),
        status: 'done'
      })
      added = true
      if (agentRuns && runId) {
        try { agentRuns.appendEvent(runId, 'user_msg', { detail: text.slice(0, 500) }) } catch { /* best-effort */ }
      }
    }
    return added
  }
  // Hardening: bounded corrective-nudge для «слабых» провайдеров, когда модель
  // ответила прозой и не вызвала ни одного инструмента (см. continueAfterPlainReply).
  let plainReplyNudges = 0
  const MAX_PLAIN_NUDGES = 1
  const coaxableProvider = isCoaxableProvider(providerId)
  // Этап 2 (agentic fallback routing), все bounded:
  let forcedJsonThisRun = false            // эскалация native→JSON-режим на той же модели (1 раз)
  let malformedRetries = 0                 // corrective retry на битый JSON аргументов
  const MAX_MALFORMED_RETRIES = 1
  let contextRetries = 0                   // форс-компакция + retry при context_overflow
  const MAX_CONTEXT_RETRIES = 1
  const continueAfterPlainReply = (text: string): boolean => {
    if (text.trim()) {
      currentMessages.push({ role: 'assistant', content: text })
      lastAssistantText = text
    }
    if (drainSupplements()) return true
    // Corrective retry (китайские/слабые OpenAI-compat): модель ответила прозой и
    // НИ РАЗУ не вызвала инструмент при агентной задаче → один раз просим её либо
    // явно завершить, либо вызвать тул. Гейт: coaxable-провайдер + тулзы доступны +
    // за прогон не было ни одного вызова + бюджет nudge не исчерпан. Frontier/RU не
    // трогаем — они надёжны, nudge дал бы ложные срабатывания на обычном Q&A.
    if (coaxableProvider && projectPath && toolCallCount === 0 && plainReplyNudges < MAX_PLAIN_NUDGES && text.trim()) {
      plainReplyNudges++
      currentMessages.push({ role: 'user', content: IGNORED_TOOLS_NUDGE })
      sender.send('ai:event', {
        id: sendId,
        event: { type: 'tool-blocked', callId: `plain-nudge-${plainReplyNudges}`, name: 'no-tool-call',
          reason: 'Модель ответила текстом без вызова инструмента — прошу выбрать инструмент или явно завершить.' }
      })
      return true
    }
    return false
  }
  // Loop detection: per-signature occurrence counter across the whole agent
  // loop. We block when a single tool+args combination has been called 3 times
  // (the threshold the UI tells the user). Tracking via Map avoids the
  // sliding-window eviction problem of the previous flat-array approach.
  const signatureCounts = new Map<string, number>()
  const LOOP_THRESHOLD = 3
  // Сколько раз скармливаем supervisor-ноту «смени подход» прежде чем жёстко
  // остановиться. 1 = один шанс на восстановление, потом hard-stop (bounded).
  const MAX_LOOP_NUDGES = 1
  let loopNudges = 0
  // Анти-трэш авто-компакшна (ревью 23.06 #4): не сжимаем повторно в течение
  // COMPACT_COOLDOWN_TURNS turn'ов после последнего сжатия — иначе сжал → резюме
  // снова пересекло порог → опять сжал → зацикливание на малых окнах.
  const COMPACT_COOLDOWN_TURNS = 3
  let lastCompactTurn = -COMPACT_COOLDOWN_TURNS
  let lastSummary = '' // T1.6: предыдущее резюме для итеративной компакции
  // Accumulate token usage across all turns of this session for the final journal entry.
  const sessionUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } = {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0
  }
  // Tally tool activity over the whole session so we can write one journal summary at the end.
  const filesTouched = new Set<string>()
  const commandsRun: string[] = []
  // DoD-принуждение (аудит P1 #8): был ли вызван attest_verification за прогон.
  // Если прогон менял файлы и завершился успешно без аттестации — итог не доказан.
  let attestedThisRun = false
  // Manager (Фаза 2): сколько tool-вызовов выполнено за прогон — для счётчика
  // tool_count в agent_runs. Считаем все диспетчеризованные вызовы (включая
  // read-only), как и инспектор audit.
  let toolCallCount = 0
  // Cross-verify: накапливаем изменённые файлы с контентом для ревью другим провайдером.
  const sessionChanges: TurnChange[] = []
  let lastAssistantText = ''
  const drainProcessCompletionsForRun = (assistantTextBeforeNote = ''): boolean => {
    const completions = processRegistry.drainCompletions({ ownerSendId: sendId })
    if (completions.length === 0) return false
    if (assistantTextBeforeNote.trim()) {
      currentMessages.push({ role: 'assistant', content: assistantTextBeforeNote })
      lastAssistantText = assistantTextBeforeNote
    }
    for (const completion of completions) {
      const note = formatProcessCompletionNote(completion)
      currentMessages.push({ role: 'user', content: note })
      sender.send('ai:event', {
        id: sendId,
        event: { type: 'info', text: `⚙ process ${completion.id} exited (${completion.exitCode ?? '?'})` }
      })
      if (agentRuns && runId) {
        try {
          agentRuns.appendEvent(runId, 'process', {
            label: `process ${completion.id} exited`,
            detail: `${completion.id}: ${completion.status}, exit ${completion.exitCode ?? 'unknown'}`,
            status: completion.status === 'completed' ? 'ok' : 'error',
          })
        } catch { /* best-effort */ }
      }
    }
    return true
  }
  // Attachments collected from browser_screenshot etc. — flushed into the
  // next user message so vision-capable providers see them.
  const pendingAttachments: Attachment[] = []
  // Exit reason for the finally-block journal write. Mutated as the loop hits
  // various terminal conditions. 'crashed' is the default — if the function
  // returns abnormally (uncaught exception during streaming) the journal
  // still captures it. Per Gemini audit 2.2 + Idea B.
  let exitReason: ExitReason = 'crashed'
  const signalExitReason = (): ExitReason => isAgentRunTimeoutAbort(signal) ? 'timeout' : 'aborted'
  // #15: при smart-fallback финализацию (journal + agentRuns.finish) делает
  // рекурсивный fallback-фрейм — внешний finally её пропускает, иначе успешный
  // fallback писался бы статусом 'crashed' упавшей попытки.
  let handedOff = false
  // Дерево делегирования (Фаза 4, Идея 3): один счётчик агентов на весь прогон
  // (ai:send). Прокидывается во ВСЕ вложенные субы через ctx.agentCounter →
  // общий потолок MAX_TOTAL_AGENTS_PER_SESSION на всё дерево, а не на ветку.
  const agentCounter = new SessionAgentCounter()
  // F1: пользовательский lifecycle-hooks движок (opt-in, default OFF — security:
  // хуки исполняют произвольный shell из конфига проекта). Грузим один раз на прогон.
  const hooks: CompiledHooks | null = hooksEnabled(getSecretForDelegate)
    ? loadHooks(projectPath, { projectEnabled: hooksProjectEnabled(getSecretForDelegate) })
    : null
  // SessionStart + UserPromptSubmit — фаер до петли; additionalContext инжектится в
  // первый turn через pendingSupplements (drainSupplements() в начале turn 0). НЕ в
  // fallback-фрейме: иначе на одну отправку при N фолбэках старт-хуки сработали бы N+1 раз.
  if (hooks && !isFallbackFrame) {
    try {
      const ss = await runHooks('SessionStart', hooks, { event: 'SessionStart', cwd: projectPath })
      if (ss.additionalContext) pendingSupplements.push(ss.additionalContext)
      const up = typeof originalUserMsg?.content === 'string' ? originalUserMsg.content : ''
      const ups = await runHooks('UserPromptSubmit', hooks, { event: 'UserPromptSubmit', cwd: projectPath, prompt: up })
      if (ups.additionalContext) pendingSupplements.push(ups.additionalContext)
    } catch { /* хуки best-effort — ошибка не ломает прогон */ }
  }

  // Ревью HIGH: провайдеры yield'ят {type:'error'} вместо throw → catch со smart-fallback
  // ниже недостижим для ошибок стрима. Выносим fallback в замыкание, чтобы вызвать его И
  // из catch (throw), И из ветки event.type==='error' (yield). Возвращает Promise fallback-
  // фрейма или null (нет следующего провайдера / ошибка не транзиентная).
  // `force` (Этап 2): пропустить shouldFallback-гейт, когда причина смены — доказанный
  // поведенческий сбой tool-calling (модель игнорит tools / повторно битый JSON), а не
  // сетевой транзиент. Такие ошибки не матчат сетевые паттерны, но смена модели оправдана.
  const attemptProviderFallback = (err: unknown, force = false): Promise<void> | null => {
    if (!(fallbackOpts && providerId && (fallbackOpts.triedProviders.size - 1) < MAX_FALLBACK_ATTEMPTS)) return null
    fallbackOpts.triedProviders.add(providerId)
    if (!force && !shouldFallback(err)) return null
    const nextId = getNextFallback(providerId, fallbackOpts.triedProviders, fallbackOpts.configuredProviders)
    const nextProvider = nextId ? fallbackOpts.getNextProvider(nextId) : null
    if (!nextProvider || !nextId) return null
    console.log(`[fallback] ${providerId} failed: ${err instanceof Error ? err.message : String(err)}. Trying ${nextId}...`)
    sender.send('ai:event', { id: sendId, event: { type: 'info', text: `⚡ ${providerId} недоступен, переключаюсь на ${nextId}` } })
    fallbackOpts.triedProviders.add(nextId)
    const fallbackTools = createToolsForProject(projectPath, signal, {
      allowedWriteRoots: parseAllowedWriteRoots(getSecretForDelegate?.(ALLOWED_WRITE_ROOTS_KEY))
    })
    const nextModel = fallbackOpts.getProviderModel(nextId) ?? model
    handedOff = true
    return runApiConversation({ ...ctx, isFallbackFrame: true, provider: nextProvider, tools: fallbackTools, initialMessages: currentMessages, providerId: nextId, model: nextModel })
  }

  // 1.9.4: подписочный лимит активного аккаунта → переключаемся на ДРУГОЙ аккаунт пула
  // того же провайдера (пересоздаём тот же провайдер — он резолвит новый активный аккаунт),
  // не теряя накопленную историю. Пул исчерпан → null (дальше обычный provider-fallback).
  const attemptAccountSwitch = (err: unknown): Promise<void> | null => {
    if (!fallbackOpts || !providerId) return null
    // Ревью-фикс: bounded — иначе resetEta=null + пул ≥2 зацикливается навсегда.
    if ((fallbackOpts.accountSwitchCount ?? 0) >= MAX_ACCOUNT_SWITCHES) return null
    const hit = detectSubscriptionLimit(err)
    if (!hit.limited) return null
    const sw = fallbackOpts.switchAccountOnLimit?.(providerId, hit.resetEta)
    if (!sw?.switched) return null
    fallbackOpts.accountSwitchCount = (fallbackOpts.accountSwitchCount ?? 0) + 1
    const freshProvider = fallbackOpts.getNextProvider(providerId) // тот же id → новый активный аккаунт
    if (!freshProvider) return null
    sender.send('ai:event', { id: sendId, event: { type: 'info', text: `⚡ Лимит аккаунта — переключился на другой аккаунт (${providerId})` } })
    handedOff = true
    const acctTools = createToolsForProject(projectPath, signal, {
      allowedWriteRoots: parseAllowedWriteRoots(getSecretForDelegate?.(ALLOWED_WRITE_ROOTS_KEY))
    })
    return runApiConversation({ ...ctx, isFallbackFrame: true, provider: freshProvider, tools: acctTools, initialMessages: currentMessages, providerId, model })
  }

  // Этап 2: эскалация native→JSON tool mode на ТОЙ ЖЕ модели (bounded, 1 раз за прогон).
  // Тот же провайдер/модель перезапускается с forceToolMode='json' → инъекция JSON-
  // инструкции вызова + parseTextToolCalls ловит текстовые вызовы. Не трогает triedProviders
  // (провайдер не меняется). Историю (currentMessages) передаём накопленную — работа не теряется.
  const escalateToJsonMode = (): Promise<void> | null => {
    if (forcedJsonThisRun || !projectPath) return null
    forcedJsonThisRun = true
    handedOff = true
    sender.send('ai:event', { id: sendId, event: { type: 'info', text: '↻ Модель игнорирует инструменты — включаю JSON-режим вызовов' } })
    const jsonTools = createToolsForProject(projectPath, signal, {
      allowedWriteRoots: parseAllowedWriteRoots(getSecretForDelegate?.(ALLOWED_WRITE_ROOTS_KEY))
    })
    return runApiConversation({ ...ctx, isFallbackFrame: true, forceToolMode: 'json', tools: jsonTools, initialMessages: currentMessages })
  }

  // Этап 2, приоритет 1+2: модель так и не вызвала инструмент (после corrective nudge).
  // Лестница: native → (nudge уже был) → JSON tool mode → fallback model. Гейт: coaxable-
  // провайдер, ни одного вызова за прогон, nudge уже потрачен. Для native-моделей и frontier
  // не срабатывает (не coaxable) — стабильный путь не деградирует.
  const maybeEscalateNoTools = (): Promise<void> | null => {
    if (!coaxableProvider || !projectPath || toolCallCount !== 0) return null
    if (plainReplyNudges < MAX_PLAIN_NUDGES) return null
    const mode = resolveToolMode(providerId, model, ctx.forceToolMode)
    if (mode !== 'json') {
      const esc = escalateToJsonMode()
      if (esc) return esc
    }
    // Уже в JSON-режиме (или эскалация исчерпана) и всё равно без вызовов →
    // tool_calling_unsupported → сменить модель (force: минуя сетевой shouldFallback-гейт).
    return attemptProviderFallback(new Error('model ignored tools (tool_calling_unsupported)'), true)
  }

  // ── Этап 6 P1: авто-снапшот baseline verify для active recipe с `verify` ──
  // Модель не обязана передавать baseline руками в review_before_commit — runtime
  // снимает его ДО первой правки. In-memory, per-run.
  const recipeVerifyCommands = (ctx.recipe?.verify?.commands ?? [])
    .map(c => String(c ?? '').trim()).filter(Boolean)
  const recipeRequiresReview = ctx.recipe?.reviewer?.required === true
  let recipeBaseline: VerifyRun[] | null = null
  let recipeBaselineTaken = false
  // ── Этап 6 P2: обязательный review gate при recipe.reviewer.required ──
  let reviewGatePassed = false
  let reviewGateNudges = 0

  // Лениво снять baseline перед первым мутирующим вызовом. Одноразово на прогон,
  // даже если снимок частичный/пустой (fail-closed — не ретраим на каждый write).
  const snapshotRecipeBaselineIfNeeded = async (): Promise<void> => {
    if (recipeBaselineTaken || !projectPath || recipeVerifyCommands.length === 0) return
    recipeBaselineTaken = true
    recipeBaseline = await snapshotVerifyBaseline(recipeVerifyCommands, {
      classifyCommand: tools.classifyCommand,
      runCommand: tools.runCommand,
    })
    if (agentRuns && runId) {
      try {
        agentRuns.appendEvent(runId, 'verify', {
          label: 'recipe baseline',
          detail: recipeBaseline.length ? recipeBaseline.map(r => `${r.command}: exit ${r.exitCode}`).join('; ') : 'не снят (нет allowlisted verify)',
        })
      } catch { /* best-effort */ }
    }
  }

  // P2: enforcement перед финальным ответом (только recipe.reviewer.required).
  // 'retry' — corrective nudge и ещё turn; 'stop' — fail-closed остановка;
  // 'allow' — финал разрешён (нет требования / гейт пройден).
  const enforceReviewGateBeforeFinal = (): 'allow' | 'retry' | 'stop' => {
    const decision = decideReviewGate({
      required: recipeRequiresReview, passed: reviewGatePassed,
      nudges: reviewGateNudges, maxNudges: MAX_REVIEW_GATE_NUDGES,
    })
    if (decision === 'retry') {
      reviewGateNudges++
      currentMessages.push({ role: 'user', content: buildReviewGateRequiredNudge(recipeVerifyCommands) })
      sender.send('ai:event', {
        id: sendId,
        event: { type: 'tool-blocked', callId: `review-gate-${reviewGateNudges}`, name: 'review_before_commit',
          reason: 'Рецепт требует review_before_commit перед завершением — вызови гейт.' },
      })
    }
    return decision
  }

  try {

  turnLoop: for (let turn = 0; turn < turnsBudget; turn++) {
    drainSupplements()
    drainProcessCompletionsForRun()
    if (signal.aborted) {
      exitReason = signalExitReason()
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }
    // H (ось 3): new_task — агент запросил чистый контекст. Очищаем историю до дистиллята
    // (как компакция). Безопасно: dangling toolCalls предыдущего turn'а уходят ВМЕСТЕ с их
    // toolResults. Focus Chain (todo) сохраняем — анти-дрейф переживает и new_task.
    if (pendingNewTask) {
      const focus = (sessionTodos && projectPath) ? formatFocusChain(sessionTodos.list(projectPath, parentChatId ?? null)) : null
      const rebuilt = buildNewTaskContext(baseSystemMsg, originalUserMsg, pendingNewTask, focus)
      currentMessages.length = 0
      currentMessages.push(...rebuilt)
      // Стейл итеративное резюме относится к ВЫБРОШЕННОМУ контексту — иначе следующая
      // авто-компакция втянет его обратно через previousSummary (ревью кросс-фич). Сброс.
      lastSummary = ''
      sender.send('ai:event', { id: sendId, event: { type: 'info', message: '🧹 Контекст очищен по new_task — продолжаю с дистиллята' } })
      pendingNewTask = null
    }
    // Focus Chain (ось 3 C): по cadence реинъектим незакрытый todo-лист как system-
    // напоминание — длинная сессия дрейфует, чеклист уезжает из внимания (§5.4). Лёгко:
    // только если есть НЕзавершённые пункты; компакция и так несёт якорь отдельно.
    if (turn > 0 && turn % FOCUS_REINJECT_EVERY === 0 && sessionTodos && projectPath) {
      const focus = formatFocusChain(sessionTodos.list(projectPath, parentChatId ?? null))
      if (focus) {
        // Дедуп: убираем прошлый Focus-Chain блок, чтобы не копить дубли в истории (ревью).
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const c = currentMessages[i]
          if (c.role === 'system' && typeof c.content === 'string' && c.content.startsWith('[Focus Chain')) {
            currentMessages.splice(i, 1)
          }
        }
        currentMessages.push({ role: 'system', content: focus })
      }
    }
    const toolCalls: ToolCall[] = []
    let assistantText = ''
    // Context sliding window: старые tool results заменяем краткими маркерами,
    // чтобы input_tokens не росли квадратично с длиной сессии. См.
    // ai/compact-history.ts. Сам currentMessages не модифицируется — компактим
    // копию для отправки.
    const messagesForProvider = compactToolHistory(currentMessages, turn)
    // withInitialRetry: если provider.send() падает на этапе connection
    // (429/503/timeout), повторяем с экспоненциальной задержкой. Если ошибка
    // случилась ПОСЛЕ первого chunk'а — пробрасываем как было (retry бы
    // продублировал текст).
    const turnNum = turn + 1
    // MCP tools: добавляем к стандартным TOOL_DEFS если есть подключённые серверы
    const mcpToolDefs = mcpClientRef ? mcpClientRef.getAllTools().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    })) : []
    // Аудит M4: tools_allow скилла применяется ЗДЕСЬ — модель видит только
    // разрешённые инструменты (read-only скилл физически не получит write_file/
    // run_command). Фильтруем и стандартные, и MCP (см. selectAllowedToolDefs).
    // v3 Шаг D: max-steps hard-stop (вдохновлено OpenCode). На ПОСЛЕДНЕМ turn'е
    // (сюда доходят только зацикленные прогоны — нормальные финишируют раньше)
    // убираем тулзы и инжектим инструкцию отчёта: модель обязана отчитаться
    // структурой «сделано/не доделано/дальше», а не молча упереться в лимит.
    const isLastTurn = turnsBudget > 1 && turn === turnsBudget - 1
    let allToolDefs = isLastTurn ? [] : selectAllowedToolDefs(TOOL_DEFS, mcpToolDefs, toolsAllow)
    // PTC (T1.4) пока opt-in: execute_code предлагается модели только при
    // ptc_enabled='true' (по умолчанию выкл — фича ждёт live-проверки петли).
    if (getSecretForDelegate?.('ptc_enabled') !== 'true') {
      allToolDefs = allToolDefs.filter(t => t.name !== 'execute_code')
    }
    // Веб-доступ агента (web_fetch) — opt-in по web_access='true' (по умолчанию
    // выкл: контроль-first + SSRF-периметр открывается только по явному согласию).
    if (getSecretForDelegate?.('web_access') !== 'true') {
      allToolDefs = allToolDefs.filter(t => t.name !== 'web_fetch' && t.name !== 'web_search')
    }
    const messagesToSend = isLastTurn
      ? [...messagesForProvider, { role: 'user' as const, content: MAX_STEPS_REPORT }]
      : messagesForProvider

    emitAgentProgress(sender, sendId, {
      id: `turn-${turnNum}`,
      phase: 'model',
      title: `Шаг ${turnNum}: отправляю запрос модели`,
      detail: isLastTurn
        ? 'Это последний разрешённый шаг: прошу модель подвести итог и не начинать новый цикл.'
        : 'Жду текст, служебный сигнал хода работы или выбор инструмента.',
      status: 'running'
    })
    let turnSawText = false
    let turnSawThought = false
    let turnSawTool = false
    const turnHeartbeat = createModelWaitHeartbeat(sender, sendId, {
      id: `turn-${turnNum}-${Date.now()}`,
      label: modelProgressLabel(providerId, model),
      detail: `Идёт шаг ${turnNum}; модель ещё не вернула текст или инструмент.`
    })

    try {
    for await (const event of withInitialRetry(
      () => provider.send(messagesToSend, allToolDefs, undefined, signal),
      {
        label: `turn-${turnNum}`,
        signal,
        retriableValue: retriableErrorEvent,
        onRetry: ({ attempt, delayMs, error }) => {
          const msg = error instanceof Error ? error.message : String(error)
          console.warn(`[agent] turn ${turnNum} retry ${attempt + 1} in ${delayMs}ms: ${msg.slice(0, 200)}`)
          sender.send('ai:event', {
            id: sendId,
            event: {
              type: 'tool-blocked',
              callId: `retry-${turnNum}-${attempt}`,
              name: 'api-retry',
              reason: `Транзиентная ошибка провайдера, повтор через ${Math.round(delayMs / 100) / 10}s (попытка ${attempt + 2})`
            }
          })
        }
      }
    )) {
      if (signal.aborted) {
        exitReason = signalExitReason()
        turnHeartbeat.stop('done', 'Запрос остановлен.')
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
      if (event.type === 'text') {
        if (!turnSawText) {
          turnSawText = true
          turnHeartbeat.stop('done', 'Модель начала отдавать видимый текст.')
          emitAgentProgress(sender, sendId, {
            id: `turn-${turnNum}-text`,
            phase: 'final',
            title: `Шаг ${turnNum}: пишу ответ`,
            detail: compactProgressText(event.text, 140) ?? 'Получен первый видимый текст.',
            status: 'running'
          })
        }
        assistantText += event.text
        lastAssistantText = assistantText
        sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'thought') {
        if (!turnSawThought) {
          turnSawThought = true
          turnHeartbeat.stop('done', 'Модель начала разбор задачи.')
          emitAgentProgress(sender, sendId, {
            id: `turn-${turnNum}-thought`,
            phase: 'reasoning',
            title: `Шаг ${turnNum}: модель разбирает задачу`,
            detail: 'Получил служебный сигнал хода работы от провайдера; жду текст или инструмент.',
            status: 'running'
          })
        }
        // Forward chain-of-thought verbatim — renderer accumulates into the
        // assistant message's `thinking` field for collapsed display.
        sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'tool-call') {
        if (!turnSawTool) {
          turnSawTool = true
          turnHeartbeat.stop('done', 'Модель выбрала инструмент для следующего действия.')
        }
        emitAgentProgress(sender, sendId, {
          id: `turn-${turnNum}-tool-${event.call.id}`,
          phase: 'tool',
          title: `Шаг ${turnNum}: выбран инструмент`,
          detail: event.call.name,
          status: 'running'
        })
        toolCalls.push(event.call)
      } else if (event.type === 'usage') {
        sessionUsage.inputTokens += event.usage.inputTokens ?? 0
        sessionUsage.outputTokens += event.usage.outputTokens ?? 0
        sessionUsage.cachedInputTokens += event.usage.cachedInputTokens ?? 0
        sender.send('ai:event', { id: sendId, event })
        // Cost guard в API path — на каждый usage event считаем total,
        // если превышен лимит → abort всего turn-loop'a.
        if (costGuard && providerId) {
          const check = costGuard.recordAndCheck(
            providerId, model ?? '', event.usage.inputTokens ?? 0,
            event.usage.outputTokens ?? 0, event.usage.cachedInputTokens ?? 0
          )
          if (check.exceeded) {
            exitReason = 'error'
            turnHeartbeat.stop('error', check.message ?? 'Превышен лимит стоимости.')
            logRuntime('ai.cost_cap.exceeded', {
              sendId,
              runId: runId ?? null,
              path: 'api-tools',
              providerId,
              model: model ?? null,
              message: check.message ?? 'cost cap exceeded',
              usage: sessionUsage
            }, 'warn')
            sender.send('ai:event', { id: sendId, event: { type: 'error', message: check.message ?? 'cost cap exceeded' } })
            sender.send('ai:event', { id: sendId, event: { type: 'done' } })
            return
          }
        }
      } else if (event.type === 'done') {
        if (toolCalls.length === 0) {
          if (continueAfterPlainReply(assistantText)) {
            // #14: continue должен перезапустить TURN (обработать догруженные
            // supplements в currentMessages), а не for-await стрим-цикл — иначе
            // стрим тут же завершался и догруженный контекст терялся.
            assistantText = ''
            continue turnLoop
          }
          if (drainProcessCompletionsForRun()) { assistantText = ''; continue turnLoop }
          // Этап 2: nudge исчерпан, модель так и не вызвала инструмент → JSON-режим / fallback.
          const esc = maybeEscalateNoTools()
          if (esc) return esc
          // P2 (Этап 6): обязательный review gate перед финалом (recipe.reviewer.required).
          const gate = enforceReviewGateBeforeFinal()
          if (gate === 'retry') { assistantText = ''; continue turnLoop }
          if (gate === 'stop') {
            exitReason = 'error'
            sender.send('ai:event', { id: sendId, event: { type: 'error', message: REVIEW_GATE_STOP_MESSAGE } })
            sender.send('ai:event', { id: sendId, event: { type: 'done' } })
            return
          }
          exitReason = 'completed'
          sender.send('ai:event', { id: sendId, event })
          // Cross-verify: запускаем асинхронно ПОСЛЕ отправки done,
          // чтобы не блокировать UI. Результат придёт отдельным событием.
          if (getSecretForDelegate) fireCrossVerify(sender, sendId, sessionChanges, providerId, getSecretForDelegate)
          return
        }
      } else if (event.type === 'error') {
        turnHeartbeat.stop('error', 'Провайдер вернул ошибку.')
        const provErr = new Error(String((event as { message?: unknown }).message ?? 'provider error'))
        const reason = classifyFallbackReason(provErr)
        // 1.9.4: подписочный лимит активного аккаунта → сначала пробуем переключить АККАУНТ
        // того же провайдера (пул), не теряя историю; только если пул исчерпан → дальше по лестнице.
        const acctSwitch = attemptAccountSwitch(provErr)
        if (acctSwitch) return acctSwitch
        // Этап 2, приоритет 4: context_overflow → форс-компакция существующим summary-
        // компактором + один retry той же моделью. Не помогло → понятная ошибка, НЕ
        // бесконечный retry (bounded MAX_CONTEXT_RETRIES).
        if (reason === 'context_overflow' && contextRetries < MAX_CONTEXT_RETRIES && model) {
          contextRetries++
          try {
            const summaryMessages = buildCompactSummaryPrompt(currentMessages, { previousSummary: lastSummary })
            let summaryText = ''
            let summaryDone = false
            for await (const ev of provider.send(summaryMessages, [], undefined, signal)) {
              if (ev.type === 'text') summaryText += ev.text
              else if (ev.type === 'done') { summaryDone = true; break }
              else if (ev.type === 'error') break
            }
            if (summaryDone && summaryText.trim()) {
              lastSummary = summaryText
              const focusAtCompact = (sessionTodos && projectPath)
                ? formatFocusChain(sessionTodos.list(projectPath, parentChatId ?? null)) : null
              const compacted = createCompactedHistory(summaryText, currentMessages, focusAtCompact, baseSystemMsg?.content ?? null)
              currentMessages.length = 0
              currentMessages.push(...compacted)
              sender.send('ai:event', { id: sendId, event: { type: 'info', text: '🔄 Контекст переполнен — сжат, повторяю' } })
              assistantText = ''
              continue turnLoop
            }
          } catch { /* компакция не удалась → понятная ошибка ниже */ }
          exitReason = 'error'
          sender.send('ai:event', { id: sendId, event: { type: 'error', message: classifyProviderError(provErr).userMessage } })
          return
        }
        // Этап 2, приоритет 5: auth-ошибка (ключ/провайдер мёртв — как бан Claude) →
        // сразу другой провайдер, В ЛЮБОЙ ход (fallback продолжает с накопленной историей).
        if (reason === 'provider_auth_error') {
          const fb = attemptProviderFallback(provErr)
          if (fb) return fb
        } else if (turn === 0 && !assistantText && toolCalls.length === 0) {
          // Транзиент на старте прогона (rate/network/5xx) → следующий провайдер (как было).
          // Если сделали прогресс — не фолбэчим (не переделываем работу).
          const fb = attemptProviderFallback(provErr)
          if (fb) return fb
        }
        exitReason = 'error'
        sender.send('ai:event', { id: sendId, event })
        return
      }
    }
    } finally {
      turnHeartbeat.stop()
    }
    if (toolCalls.length === 0) {
      if (continueAfterPlainReply(assistantText)) {
        assistantText = ''
        continue
      }
      if (drainProcessCompletionsForRun()) {
        assistantText = ''
        continue
      }
      // Этап 2: nudge исчерпан, модель так и не вызвала инструмент → JSON-режим / fallback.
      const esc = maybeEscalateNoTools()
      if (esc) return esc
      // P2 (Этап 6): обязательный review gate перед финалом (recipe.reviewer.required).
      const gate = enforceReviewGateBeforeFinal()
      if (gate === 'retry') { assistantText = ''; continue }
      if (gate === 'stop') {
        exitReason = 'error'
        sender.send('ai:event', { id: sendId, event: { type: 'error', message: REVIEW_GATE_STOP_MESSAGE } })
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
      exitReason = 'completed'
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      // Cross-verify: запускаем асинхронно ПОСЛЕ отправки done.
      if (getSecretForDelegate) fireCrossVerify(sender, sendId, sessionChanges, providerId, getSecretForDelegate)
      return
    }

    // Этап 2, приоритет 3: native tool-call пришёл с битым JSON в arguments (typed
    // argsError из openai-compat) → один corrective retry «повтори валидным JSON»,
    // НЕ диспатчим с пустыми args. Повторно битый → fallback model (force). Нет
    // фолбэка → падаем в обычную диспетчеризацию (тулза вернёт ошибку → self-correction).
    {
      const malformed = toolCalls.filter(c => c.argsError)
      if (malformed.length > 0) {
        if (malformedRetries < MAX_MALFORMED_RETRIES) {
          malformedRetries++
          const names = [...new Set(malformed.map(c => c.name))].join(', ')
          if (assistantText.trim()) currentMessages.push({ role: 'assistant', content: assistantText })
          currentMessages.push({ role: 'user', content: `Вызов инструмента (${names}) содержал невалидный JSON в поле arguments. Повтори вызов одним валидным JSON-объектом arguments, без пояснений и текста вокруг.` })
          sender.send('ai:event', { id: sendId, event: { type: 'tool-blocked', callId: `malformed-${turn}`, name: names, reason: 'Битый JSON в аргументах вызова — прошу повторить валидным JSON' } })
          assistantText = ''
          continue turnLoop
        }
        const fb = attemptProviderFallback(new Error('malformed tool call arguments'), true)
        if (fb) return fb
      }
    }

    // Defence-in-depth dedupe: даже если провайдер эмитит один и тот же
    // tool-call дважды в одном turn (был баг в gemini.ts с двойной
    // экстракцией), сворачиваем дубли. Ключ — name + JSON args.
    {
      const seen = new Set<string>()
      const deduped: ToolCall[] = []
      for (const c of toolCalls) {
        const sig = callSignature(c)
        if (seen.has(sig)) continue
        seen.add(sig)
        deduped.push(c)
      }
      if (deduped.length !== toolCalls.length) {
        console.warn(`[agent] dropped ${toolCalls.length - deduped.length} duplicate tool calls in turn ${turn}`)
        toolCalls.length = 0
        toolCalls.push(...deduped)
      }
    }

    // Loop detection — increment counter per signature; block when any tool
    // call has been issued LOOP_THRESHOLD (3) times across the whole loop.
    const loopHits: ToolCall[] = []
    for (const c of toolCalls) {
      const sig = callSignature(c)
      const next = (signatureCounts.get(sig) ?? 0) + 1
      signatureCounts.set(sig, next)
      if (next >= LOOP_THRESHOLD) loopHits.push(c)
    }

    currentMessages.push({ role: 'assistant', content: assistantText, toolCalls })

    if (loopHits.length > 0) {
      // Feed back a supervisor note instead of executing again. Раньше нота тут же
      // терялась (push + немедленный return → модель её НЕ видела, мёртвый код).
      // Теперь скармливаем её модели и даём ОДИН шанс сменить подход (continue),
      // и только при повторном зацикливании — hard-stop. Bounded MAX_LOOP_NUDGES.
      // (Ревью 23.06)
      // Ревью MEDIUM: результат синтезируем для ВСЕХ toolCalls turn'а, не только loopHits —
      // иначе при смешанном turn'е (часть вызовов зациклилась, часть нет) не-loop tool_use
      // остаётся без парного tool_result → на следующем provider.send Claude/OpenAI вернут 400
      // (каждый tool_use требует tool_result). Loop-вызовам — supervisor-нота, остальным — skip.
      const loopIds = new Set(loopHits.map(c => c.id))
      currentMessages.push({
        role: 'user',
        content: '',
        toolResults: toolCalls.map(c => loopIds.has(c.id)
          ? { id: c.id, name: c.name, result: '', error: 'Supervisor: вы зациклились — этот же вызов повторён несколько раз. Смените подход или сообщите пользователю что нужна помощь.' }
          : { id: c.id, name: c.name, result: 'Пропущено: turn прерван детектором зацикливания (повторялся другой вызов). Повтори при необходимости.' }
        )
      })
      if (loopNudges < MAX_LOOP_NUDGES) {
        loopNudges++
        sender.send('ai:event', {
          id: sendId,
          event: {
            type: 'tool-blocked',
            callId: loopHits[0].id,
            name: loopHits[0].name,
            reason: `Зацикливание: один и тот же вызов повторён 3+ раза. Прошу сменить подход.`
          }
        })
        continue turnLoop
      }
      sender.send('ai:event', {
        id: sendId,
        event: {
          type: 'tool-blocked',
          callId: loopHits[0].id,
          name: loopHits[0].name,
          reason: `Зацикливание продолжается после подсказки — цикл остановлен.`
        }
      })
      exitReason = 'loop-detected'
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }

    const toolResults: ToolResult[] = new Array(toolCalls.length)
    toolCallCount += toolCalls.length  // Manager (Фаза 2): tool_count прогона

    // P1 (Этап 6): снять baseline verify ДО первого мутирующего вызова active recipe.
    if (!recipeBaselineTaken && recipeVerifyCommands.length > 0 && toolCalls.some(c => isMutatingToolName(c.name))) {
      await snapshotRecipeBaselineIfNeeded()
    }

    // Dispatch via tool-handlers registry. Each handler knows its own scheduling
    // mode (parallel-read / sequential / confirm-write); the loop honours it.
    const ctx: ToolContext = {
      sender, sendId, signal, projectPath, tools,
      recordWrite, recordPlan, recordJournal, readJournal, saveMemory, saveDecision, searchMemories, searchConversations, connectors,
      invalidateMemory,
      pendingAttachments, pendingWrites, pendingCommands, pendingPlans, scopedKey,
      agentMode: runAgentMode, setAgentMode: (m) => { runAgentMode = m }, skillRegistry, getSecretForDelegate,
      // H (ось 3): new_task — агент запрашивает очистку контекста до дистиллята.
      requestNewTask: (summary: string) => { pendingNewTask = summary },
      // ось 3 I: per-tool auto-approve — читаем тумблеры живо (как agentMode).
      autoApprove: {
        edits: getSecretForDelegate?.('auto_approve_edits') === 'true',
        commands: getSecretForDelegate?.('auto_approve_commands') === 'true',
      },
      // F2: декларативные permission-правила (загружены 1 раз на прогон выше).
      permissionRules,
      processRegistry,
      currentProviderId: providerId,
      mcpClient: mcpClientRef,
      appendAudit: appendAuditFn,
      // Cost guard сессии — субагенты (delegate_task/delegate_parallel) учитывают
      // свои токены в этот же cap, чтобы не обойти лимит сессии (Фаза 1).
      subCostGuard: costGuard,
      // Персистентные суб-сессии (Фаза 2): родитель + фасад БД.
      parentChatId,
      subSessions,
      // TodoGate (Фаза 3): оркестрационный todo-лист сессии.
      sessionTodos,
      // Дерево делегирования (Фаза 4): главный агент — depth 0, без родителя.
      // Счётчик агентов один на весь прогон → общий потолок на всё дерево.
      delegationDepth: 0,
      parentCallId: null,
      agentCounter,
      // Multi-agent Manager (Фаза 4): живой Timeline задачи. runId + best-effort
      // appendEvent. Хендлеры дёргают ctx.recordRunEvent рядом с существующими
      // ai:event-эмиттерами; ошибка storage не ломает agent loop (try/catch).
      runId,
      recordRunEvent: (kind, p) => {
        if (!agentRuns || !runId) return
        try { agentRuns.appendEvent(runId, kind, p) } catch { /* best-effort */ }
      },
      // Этап 6 P1: авто-baseline recipe для review_before_commit (если модель
      // не передала baseline аргументом). undefined → снимка нет → строгий гейт.
      getRecipeBaseline: () => recipeBaseline ?? undefined,
      // attest_verification (Verification Фаза 2): снимок реально записанных за
      // прогон файлов — для сверки claimed vs actual в DoD-артефакте.
      runFilesTouched: () => Array.from(filesTouched),
      // Verification Фаза 3: фасад истории — attest_verification пишет строку
      // после writeVerificationArtifact (best-effort, для latest в Review DoD).
      verifications
    }
    // F1: PreToolUse-хуки — детерминированный гейт ПЕРЕД исполнением тула (вне LLM).
    // exit 2 / {block:true} → вызов блокируется, модель видит причину как tool error.
    // Пре-пасс (последовательно, чтобы ранний блок виделся до запуска), потом dispatch.
    const preBlocked = new Map<number, string>()
    if (hooks) {
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i]
        try {
          const pre = await runHooks('PreToolUse', hooks, { event: 'PreToolUse', cwd: projectPath, tool_name: call.name, tool_input: call.args })
          if (pre.additionalContext) pendingSupplements.push(pre.additionalContext)
          if (pre.block) preBlocked.set(i, pre.reason ?? `Вызов "${call.name}" заблокирован PreToolUse-хуком.`)
        } catch { /* хук best-effort */ }
      }
    }
    const writePromises: Array<{ idx: number; promise: Promise<ToolResult> }> = []
    const readPromises: Array<{ idx: number; promise: Promise<ToolResult> }> = []
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      // F1: заблокированный PreToolUse-хуком вызов не исполняем — отдаём error модели.
      if (preBlocked.has(i)) {
        const reason = preBlocked.get(i)!
        toolResults[i] = { id: call.id, name: call.name, result: '', error: reason }
        sender.send('ai:event', { id: sendId, event: { type: 'tool-blocked', callId: call.id, name: call.name, command: '', reason } })
        continue
      }
      const handler = lookupHandler(call.name, ctx)
      if (handler.mode === 'parallel-read') {
        readPromises.push({ idx: i, promise: handler.handle(call, ctx) })
      } else if (handler.mode === 'confirm-write') {
        // confirm-write tools all hit the same multi-file diff modal; they run
        // concurrently from this side and the user accepts/rejects together.
        writePromises.push({ idx: i, promise: handler.handle(call, ctx) })
      } else {
        // sequential — must finish before next tool (run_command, browser_*,
        // connectors, create_plan all have ordered UI side effects)
        toolResults[i] = await handler.handle(call, ctx)
      }
    }
    // Parallel reads finish without user input
    for (const { idx, promise } of readPromises) {
      toolResults[idx] = await promise
    }
    // Then wait for user to resolve every pending write
    for (const { idx, promise } of writePromises) {
      toolResults[idx] = await promise
    }
    // F1: PostToolUse-хуки — после исполнения тулзов. Не блокируют (поздно); их
    // additionalContext уходит в следующий ход через pendingSupplements. Пропускаем
    // pre-заблокированные (тул не исполнялся).
    if (hooks) {
      for (let i = 0; i < toolCalls.length; i++) {
        if (preBlocked.has(i)) continue
        const call = toolCalls[i]
        const result = toolResults[i]
        try {
          const post = await runHooks('PostToolUse', hooks, { event: 'PostToolUse', cwd: projectPath, tool_name: call.name, tool_input: call.args, tool_output: result?.result })
          if (post.additionalContext) pendingSupplements.push(post.additionalContext)
        } catch { /* хук best-effort */ }
      }
    }
    // P2 (Этап 6): зафиксировать успешный проход обязательного review gate по
    // результату его tool-вызова (маркер REVIEW_GATE_PASS_MARKER). Только при
    // recipe.reviewer.required — иначе no-op для обычных прогонов/скиллов.
    if (recipeRequiresReview && !reviewGatePassed) {
      for (let i = 0; i < toolCalls.length; i++) {
        if (toolCalls[i].name === 'review_before_commit'
            && isReviewGatePassResult(toolResults[i]?.result, !!toolResults[i]?.error)) {
          reviewGatePassed = true
          break
        }
      }
    }
    // Tally tool usage for the end-of-session journal summary
    // auto_capture_memory: по умолчанию включено; выключается настройкой 'false'
    const autoCaptureEnabled = getSecretForDelegate?.('auto_capture_memory') !== 'false'
    let acceptedWritesThisTurn = 0
    let tsWritesThisTurn = 0  // Diagnostic Loop v2: правки .ts/.tsx → авто-tsc
    const lspWrites = new Map<string, string>()  // T1.1: не-TS файлы за ход (path→content) → LSP-диагностика всех
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      const result = toolResults[i]
      if (!result) continue
      // #12: propose_edits (и любой тул с filesWritten) — принятые файлы в
      // filesTouched, иначе attest-сверка claimed-vs-actual их не видела.
      if (result.filesWritten?.length) {
        for (const p of result.filesWritten) { filesTouched.add(p); acceptedWritesThisTurn++; if (isTypeScriptFile(p)) tsWritesThisTurn++ }
      }
      if ((call.name === 'write_file' || call.name === 'apply_patch') && !result.error) {
        const p = String(call.args.path ?? '')
        if (p) {
          filesTouched.add(p)
          if (isTypeScriptFile(p)) tsWritesThisTurn++
          // Track content for cross-verify (write_file has 'content', apply_patch has 'patch')
          const content = String(call.args.content ?? call.args.patch ?? '')
          if (content && sessionChanges.length < 5) {
            sessionChanges.push({ file: p, type: call.name === 'write_file' ? 'write' : 'patch', content })
          }
          // T1.1: write_file не-TS файла (Python/Go/Rust) → диагностика языковым
          // сервером. write_file несёт полное содержимое (для didOpen); apply_patch
          // даёт лишь diff — для него LSP-диагностику пока пропускаем.
          if (call.name === 'write_file' && content && isLspDiagnosableFile(p)) {
            lspWrites.set(p, content)  // дедуп по пути: последняя запись файла побеждает
          }
        }
        acceptedWritesThisTurn++
      } else if (call.name === 'run_command' && !result.error) {
        const cmd = String(call.args.command ?? '')
        if (cmd) commandsRun.push(cmd)
      } else if (call.name === 'attest_verification' && !result.error) {
        attestedThisRun = true  // DoD-принуждение (аудит P1 #8)
      }
      // Auto-capture memory observation — fire-and-forget, не блокирует цикл
      captureToolObservation(
        saveMemory,
        {
          tool: call.name,
          args: call.args,
          result: typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? ''),
          projectPath
        },
        autoCaptureEnabled
      )
      // Процедурная память — детектирует паттерны решения задач (fix-pattern и т.п.)
      if (trackToolPatternFn) {
        try {
          trackToolPatternFn(projectPath, {
            tool: call.name,
            args: call.args,
            success: !result.error,
            timestamp: Date.now()
          })
        } catch { /* procedural memory not critical */ }
      }
    }
    // If user just accepted writes, gently nudge the model on the next turn
    // to verify (run tests / typecheck / lint). The context-pack already
    // showed verify_scripts; we re-surface as an inline reminder so the model
    // pays attention this turn specifically.
    let verifyHint = ''
    if (acceptedWritesThisTurn > 0) {
      // Diagnostic Loop v2: после правок .ts/.tsx авто-прогоняем check_diagnostics
      // (tsc) и подсовываем РЕАЛЬНЫЕ ошибки в следующий ход — не надеемся, что
      // модель сама вспомнит проверить. Выключается diagnostic_loop='false'.
      const diagnosticEnabled = getSecretForDelegate?.('diagnostic_loop') !== 'false'
      const modelCheckedThisTurn = toolCalls.some(c => c.name === 'check_diagnostics')
      if (shouldAutoDiagnose({ enabled: diagnosticEnabled, tsWritesThisTurn, modelCheckedThisTurn })) {
        try {
          const diagHandler = lookupHandler('check_diagnostics', ctx)
          if (diagHandler) {
            const diag = await diagHandler.handle({ id: 'auto-diag', name: 'check_diagnostics', args: {} }, ctx)
            const hint = formatDiagnosticHint(typeof diag.result === 'string' ? diag.result : '')
            if (hint) verifyHint = hint
          }
        } catch { /* Diagnostic Loop — best-effort, не ломает цикл */ }
      }
      // T1.1: не-TS файлы (Python/Go/Rust) — диагностика языковым сервером (LSP).
      // ВСЕ не-TS файлы хода (не только последний), параллельно (wall-time = max, не
      // сумма), с капом на число спавнов. Graceful: бинаря нет/таймаут → null → откат.
      if (!verifyHint && lspWrites.size > 0 && diagnosticEnabled && !modelCheckedThisTurn) {
        try {
          const entries = [...lspWrites.entries()].slice(0, 5)
          const hints = await Promise.all(entries.map(async ([rel, content]) => {
            const diags = await runLspDiagnostics({ path: joinPath(projectPath, rel), content, root: projectPath })
            return diags ? formatLspDiagnosticHint(rel, diags) : null
          }))
          const joined = hints.filter(Boolean).join('\n\n')
          if (joined) verifyHint = joined
        } catch { /* LSP — best-effort, не ломает цикл */ }
      }
      // Фолбэк: если авто-диагностика не дала нудж (выключена / чисто / не TS) —
      // мягкое напоминание запустить проверку, как было.
      if (!verifyHint) {
        const hints = await detectVerifyScriptsForHint(projectPath)
        if (hints.length > 0) {
          verifyHint = `[system: пользователь принял ${acceptedWritesThisTurn} write(s). Перед "готово" запусти проверку через run_command — варианты: ${hints.slice(0, 2).join(' / ')}. Если уверен что проверка избыточна — объясни почему.]`
        }
      }
    }
    const nextUserMsg: ChatMessage = { role: 'user', content: verifyHint, toolResults }
    if (pendingAttachments.length > 0) {
      nextUserMsg.attachments = [...pendingAttachments]
      pendingAttachments.length = 0
    }
    currentMessages.push(nextUserMsg)

    // Crash-resume (P1): живой прогресс прогона на КАЖДОМ завершённом turn.
    // turn_index = номер этого хода (1-based), last_tool_name = имя последнего
    // инструмента этого turn'а (для гарда деструктива в баннере). last_checkpoint
    // не пишем здесь (undo-head не прокинут в этот runner — не плодим dep ради
    // best-effort поля; останется NULL). Best-effort: ошибка storage не ломает loop.
    if (agentRuns && runId) {
      try {
        // Гард резюма: «самый опасный» tool turn'а, а не просто последний —
        // иначе write→run→read дал бы last=read → ложный autoResumable (аудит P1 #11).
        const lastTool = pickResumeGuardTool(toolCalls.map(c => c.name))
        agentRuns.tick(runId, {
          turnIndex: turn + 1,
          lastToolName: lastTool,
          // Live-счётчики: карточка running-задачи показывает прогресс на каждом
          // turn, а не нули до finish (аудит P0).
          toolCount: toolCallCount,
          filesCount: filesTouched.size,
          agentsCount: agentCounter.count
        })
      } catch { /* best-effort — tick живого прогресса не критичен */ }
      // Crash-resume Фаза 2: снапшот полной истории loop'а (currentMessages уже
      // содержит результаты этого turn'а + следующий user-msg). На возобновлении
      // прерванной сессии грузим его и продолжаем с накопленным контекстом, а не
      // с turn 0. UPSERT — одна строка на прогон. Best-effort.
      // 1.9.7 #7: троттлинг против write-amplification — не пишем идентичный
      // снапшот, на длинных прогонах не чаще every-N, size-cap как backstop.
      try {
        const messagesJson = JSON.stringify(currentMessages)
        const dec = decideCheckpointSave(turn + 1, messagesJson, checkpointThrottle.get(runId))
        if (dec.save) {
          agentRuns.saveCheckpoint(runId, turn + 1, messagesJson)
          checkpointThrottle.set(runId, { lastHash: dec.hash, lastSavedTurn: turn + 1 })
        }
      } catch { /* снапшот не критичен — resume просто не предложит контекст */ }
    }

    // Авто-компакшн: после каждого turn'а проверяем не исчерпали ли 95%
    // контекстного окна. Если да — суммаризируем одним синхронным API-вызовом
    // и заменяем currentMessages на сжатую версию. Механизм полностью независим
    // от sliding window (compactToolHistory выше) который работает на уровне
    // отдельных tool results.
    // auto_compact = 'false' отключает фичу; по умолчанию включена.
    const autoCompactEnabled = getSecretForDelegate?.('auto_compact') !== 'false'
    // Microcompact (Tier-2 #2): дешёвый обратимый прунинг по размеру при ~70% окна —
    // ДО дорогого full-compact (LLM-суммаризация). Без вызова модели. Маркеры обратимы.
    if (autoCompactEnabled && model) {
      // Оценка по slid-копии (что реально уходит провайдеру), прунинг — в currentMessages.
      const mc = microcompactIfNeeded(currentMessages, model, compactToolHistory(currentMessages, turn))
      if (mc.pruned > 0) {
        currentMessages.length = 0
        currentMessages.push(...mc.messages)
        recordJournal(projectPath, 'note', `[microcompact] ${mc.pruned} крупных результатов → маркеры (${mc.reclaimedChars} симв.)`, null)
        sender.send('ai:event', { id: sendId, event: { type: 'info', text: '🧹 Контекст подчищен (microcompact)' } })
      }
    }
    const compactCooldownOk = turn - lastCompactTurn >= COMPACT_COOLDOWN_TURNS
    if (autoCompactEnabled && model && compactCooldownOk && shouldAutoCompact(currentMessages, model)) {
      try {
        sender.send('ai:event', {
          id: sendId,
          event: { type: 'context-compact', phase: 'start', reason: 'context-window' }
        })
        logRuntime('ai.context_compact.start', {
          sendId,
          runId: runId ?? null,
          projectPath,
          providerId: providerId ?? null,
          model: model ?? null,
          messageCount: currentMessages.length,
          chars: currentMessages.reduce((sum, m) => sum + (m.content ?? '').length, 0)
        })
        // Получаем резюме от той же модели — один non-streamed вызов
        const summaryMessages = buildCompactSummaryPrompt(currentMessages, { previousSummary: lastSummary })
        let summaryText = ''
        let summaryDone = false
        for await (const ev of provider.send(summaryMessages, [], undefined, signal)) {
          if (ev.type === 'text') summaryText += ev.text
          else if (ev.type === 'usage') {
            // Учёт стоимости summary-вызова в cost-guard (раньше usage этого вызова
            // терялся → утечка 5-7к токенов/компакшн мимо лимита). Ревью 23.06 #4.
            sessionUsage.inputTokens += ev.usage.inputTokens ?? 0
            sessionUsage.outputTokens += ev.usage.outputTokens ?? 0
            sessionUsage.cachedInputTokens += ev.usage.cachedInputTokens ?? 0
            if (costGuard && providerId) {
              costGuard.recordAndCheck(providerId, model ?? '', ev.usage.inputTokens ?? 0, ev.usage.outputTokens ?? 0, ev.usage.cachedInputTokens ?? 0)
            }
          }
          else if (ev.type === 'done') { summaryDone = true; break }
          else if (ev.type === 'error') break // summaryDone остаётся false
        }
        // Применяем резюме ТОЛЬКО при чистом done: при error mid-stream summaryText
        // частичный-но-truthy и раньше затирал историю усечённым резюме. Ревью #4.
        if (summaryDone && summaryText.trim()) {
          lastCompactTurn = turn
          lastSummary = summaryText // T1.6: следующая компакция обновит это резюме
          const beforeLen = currentMessages.length
          // Focus Chain (ось 3 C): незакрытый todo-лист переживает сжатие — якорем в
          // первое сообщение, чтобы агент не потерял исходные пункты задачи.
          const focusAtCompact = (sessionTodos && projectPath)
            ? formatFocusChain(sessionTodos.list(projectPath, parentChatId ?? null)) : null
          const beforeChars = currentMessages.reduce((sum, m) => sum + (m.content ?? '').length, 0)
          const compacted = createCompactedHistory(summaryText, currentMessages, focusAtCompact, baseSystemMsg?.content ?? null)
          const afterChars = compacted.reduce((sum, m) => sum + (m.content ?? '').length, 0)
          currentMessages.length = 0
          currentMessages.push(...compacted)
          sender.send('ai:event', {
            id: sendId,
            event: {
              type: 'context-compact',
              phase: 'done',
              beforeChars,
              afterChars,
              droppedTurns: Math.max(0, beforeLen - compacted.length),
              keptTurns: compacted.length,
              reason: 'context-window'
            }
          })
          logRuntime('ai.context_compact.done', {
            sendId,
            runId: runId ?? null,
            projectPath,
            providerId: providerId ?? null,
            model: model ?? null,
            beforeChars,
            afterChars,
            beforeTurns: beforeLen,
            keptTurns: compacted.length,
            summaryChars: summaryText.length
          })
          // Записываем в журнал
          const summaryTokens = estimateTokens(summaryText)
          recordJournal(
            projectPath,
            'note',
            `[auto-compact] ${beforeLen} сообщений → резюме (${summaryTokens} токенов)`,
            null
          )
          console.log(`[agent] auto-compact: ${beforeLen} msgs → ${compacted.length} msgs (summary ${summaryTokens} tokens)`)
        } else {
          sender.send('ai:event', {
            id: sendId,
            event: { type: 'context-compact', phase: 'cancel', reason: 'context-window' }
          })
          logRuntime('ai.context_compact.empty', {
            sendId,
            runId: runId ?? null,
            projectPath,
            providerId: providerId ?? null,
            model: model ?? null
          }, 'warn')
          console.warn('[agent] auto-compact: summary was empty, continuing without compaction')
        }
      } catch (err) {
        // Грейсфул деградация: компакшн упал — продолжаем без него
        sender.send('ai:event', {
          id: sendId,
          event: { type: 'context-compact', phase: 'cancel', reason: 'context-window' }
        })
        logRuntimeError('ai.context_compact.fail', err, {
          sendId,
          runId: runId ?? null,
          projectPath,
          providerId: providerId ?? null,
          model: model ?? null
        })
        console.warn('[agent] auto-compact failed, continuing without compaction:', err instanceof Error ? err.message : err)
      }
    }
  }
  // Budget exhausted — emit a dedicated event so the UI can offer "+N turns".
  // The renderer re-sends the current conversation with a larger budget if the
  // user clicks Continue.
  exitReason = 'max-turns'
  // P2 fail-closed на исчерпании бюджета: если рецепт требует ревью, а обязательный
  // review gate так и не пройден к моменту max-turns — это НЕ штатное завершение.
  // Помечаем прогон как невыполненный (exitReason='error' → status 'failed'), иначе
  // модель могла бы «проскочить» гейт, просто израсходовав ходы. «+ходы» для
  // продолжения сохраняем (turns-exhausted ниже) — пользователь может дать бюджет и
  // модель довызовет гейт.
  if (recipeRequiresReview && !reviewGatePassed) {
    exitReason = 'error'
    sender.send('ai:event', { id: sendId, event: { type: 'error', message: REVIEW_GATE_STOP_MESSAGE } })
  }
  const canContinue = turnsBudget < MAX_BUDGET_TURNS
  sender.send('ai:event', {
    id: sendId,
    event: {
      type: 'turns-exhausted',
      used: turnsBudget,
      maxBudget: MAX_BUDGET_TURNS,
      canContinue,
      suggestedAdd: Math.min(10, MAX_BUDGET_TURNS - turnsBudget)
    }
  })
  sender.send('ai:event', { id: sendId, event: { type: 'done' } })
  } catch (err) {
    // Стоп пользователя ВО ВРЕМЯ backoff-retry: sleep() в withInitialRetry бросает
    // Error('aborted'), которая вылетает мимо per-event abort-проверок прямо сюда.
    // Без этого guard'а штатный стоп падал в ветку 'crashed' ниже → пользователь
    // видел страшный error-тост, а run писался 'failed'. signal.aborted = он сам
    // нажал Стоп → чистое завершение, без error-события и без фолбэка. (Ревью 23.06)
    if (signal.aborted) {
      exitReason = signalExitReason()
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }
    logRuntimeError('ai.runner.error', err, {
      sendId,
      runId: runId ?? null,
      path: 'api-tools',
      projectPath,
      providerId: providerId ?? null,
      model: model ?? null,
      turnCount: turnsBudget
    })
    // Smart fallback для API-агентного пути: если withInitialRetry исчерпал попытки
    // (throw наружу) и ошибка всё ещё retriable — переключаемся на следующего провайдера.
    // Та же логика доступна из ветки event.type==='error' (см. attemptProviderFallback).
    const fb = attemptProviderFallback(err)
    if (fb) return fb
    exitReason = 'crashed'
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'error', message: classifyProviderError(err).userMessage }
    })
    sender.send('ai:event', { id: sendId, event: { type: 'done' } })
  } finally {
    unregisterConversationSupplements(sendId)
    // F1: Stop-хук — завершение прогона (для side-effects: коммит/нотификация/синк).
    // Best-effort, не ждём additionalContext (прогон закончен). Не на handed-off
    // фолбэке (его завершит рекурсивный фрейм), чтобы Stop не сработал дважды.
    if (hooks && !handedOff) {
      try { await runHooks('Stop', hooks, { event: 'Stop', cwd: projectPath }) } catch { /* best-effort */ }
    }
    // #15: при handed-off fallback journal/finish делает рекурсивный фрейм (ему
    // переданы recordJournal + agentRuns/runId) — внешний пропускает, иначе
    // дублировал бы журнал и финализировал run статусом упавшей попытки.
    logRuntime('ai.runner.finish', {
      sendId,
      runId: runId ?? null,
      path: 'api-tools',
      projectPath,
      providerId: providerId ?? null,
      model: model ?? null,
      exitReason,
      handedOff,
      durationMs: Date.now() - startedAt,
      assistantChars: lastAssistantText.length,
      usage: sessionUsage,
      costCents: costGuard?.current() ?? 0,
      toolCallCount,
      filesCount: filesTouched.size,
      commandsCount: commandsRun.length
    }, exitReason === 'completed' || exitReason === 'aborted' || handedOff ? 'info' : 'warn')
    if (!handedOff) {
    // GUARANTEED journal write on every exit path — completion, abort, error,
    // max-turns, loop-detected, crashed (uncaught). Per Gemini audit Idea B:
    // 'любое завершение runApiConversation обязано вызвать writeSessionJournal'.
    try {
      writeSessionJournal(recordJournal, projectPath, lastAssistantText, filesTouched, commandsRun, sessionUsage, exitReason)
    } catch (err) {
      console.error('[ai.ts] writeSessionJournal failed in finally:', err)
    }
    // #3 персист авто-резюме сессии: если прогон компактился (lastSummary непуст),
    // сохраняем сжатый итог в память с тегом session-summary. Всплывёт в релевантном
    // recall следующего чата (#1) — кросс-сессионный recall БЕЗ embeddings. Раньше
    // lastSummary жил только in-run и терялся после закрытия чата.
    if (lastSummary.trim() && projectPath) {
      try {
        // scanText ОБЯЗАТЕЛЕН: lastSummary включает сырые user-сообщения (compact-history),
        // юзер мог вставить токен/ключ → иначе он осел бы в памяти и всплыл в recall →
        // в system prompt внешнего провайдера (ревью: HIGH утечка секрета).
        const safe = scanText(lastSummary.trim()).redacted.slice(0, 2000)
        saveMemory(projectPath, 'fact', `Итог прошлой сессии: ${safe}`, ['session-summary'])
      } catch (err) {
        console.warn('[ai.ts] session-summary persist failed:', err instanceof Error ? err.message : err)
      }
    }
    // Multi-agent Manager (Фаза 2): завершаем прогон — статус из exitReason,
    // счётчики из того что уже накоплено в прогоне (tool/files/agents),
    // стоимость из costGuard. Best-effort: ошибка storage не ломает loop.
    // agentRuns/runId не прокидываются в рекурсивный fallback-вызов (undefined) →
    // finish пишется ровно раз (этот внешний finally), даже если был фолбэк.
    // (toolsAllow/verifications в fallback прокидываются — они не про финализацию.)
    if (agentRuns && runId) {
      try {
        // DoD-принуждение (аудит P1 #8): прогон завершён успешно и менял файлы,
        // но attest_verification не вызван → итог НЕ доказан. Помечаем в Timeline
        // событием verify=not_run (видно в карточке «Задачи»), без навязчивого
        // вмешательства в чат — мягкое принуждение через видимость.
        if (exitReason === 'completed' && filesTouched.size > 0 && !attestedThisRun) {
          agentRuns.appendEvent(runId, 'verify', {
            status: 'not_run',
            label: 'DoD не запущен',
            detail: `Изменено файлов: ${filesTouched.size}, но attest_verification не вызван — итог не доказан проверками.`
          })
        }
        // Timeline: финальный ответ агента последним событием — чтобы в карточке
        // был виден ИТОГ, а не только список действий (аудит P0 «где результат?»).
        if (lastAssistantText.trim()) {
          agentRuns.appendEvent(runId, 'assistant_msg', { detail: lastAssistantText.slice(0, 500), status: exitReason })
        }
        // #4 suspend: приостановленный прогон помечаем 'suspended' (не 'stopped').
        // delete — в общем cleanup (для обоих путей); здесь только читаем.
        const finishStatus = suspendedSends.has(sendId) ? 'suspended' as const : exitReasonToAgentRunStatus(exitReason)
        agentRuns.finish(runId, finishStatus, {
          costCents: costGuard?.current() ?? 0,
          toolCount: toolCallCount,
          filesCount: filesTouched.size,
          agentsCount: agentCounter.count,
          error: exitReason === 'error' || exitReason === 'crashed' ? lastAssistantText.slice(0, 500) || exitReason : null
        })
        // Crash-resume Фаза 2: на чистом завершении снапшот не нужен — чистим,
        // чтобы resume не предлагал возобновить доведённую сессию. Прерванные
        // (crashed/error/aborted/max-turns/loop) сохраняют чекпойнт для resume.
        if (exitReason === 'completed') {
          agentRuns.clearCheckpoint(runId)
        }
        // 1.9.7 #7: прогон терминален (не handedOff) — чистим in-memory throttle-
        // стейт, чтобы Map не рос по завершённым прогонам.
        checkpointThrottle.delete(runId)
      } catch (err) {
        console.warn('[agent-runs] finish (api) failed:', err instanceof Error ? err.message : err)
      }
    }
    } // /if (!handedOff) — #15
  }
}

