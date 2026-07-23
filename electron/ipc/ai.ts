import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { notifyRunEvent, shouldSendAutoProofReport } from '../ai/run-notify'
import { scanText } from '../ai/secret-scanner'
import { clearRunUntilGreenForSend, clearSmartApproveForSend } from './tool-handlers/command'
import { createFileTools, createToolsForProject, TOOL_DEFS } from '../ai/tools'
import { isWithinKnownRoots } from '../ai/path-policy'
import { createProvider, PROVIDERS, isCodexAuthProvider, type ProviderId } from '../ai/registry'
import { loadLiveCatalog, checkModelAvailable } from '../ai/model-catalog-service'
import { isKnownProviderId, type PromptRouteOverride } from '../../shared/contracts/provider'
import type { McpClient } from '../mcp/client'
import { prepareSystemContext } from '../ai/compose-system'
import { prepareHistoryForModel } from '../ai/history-preparation'
import { applyRecipeToSkillPrompt } from '../ai/skills/recipe'
import type { RecipeSpec } from '../ai/skills/types'
import { systemForProvider, stripCacheBreakpoint } from '../ai/compose-prompt'
import { buildCliPrompt, type CliProviderId } from '../ai/cli-prompt'
import { REVIEWER_SYSTEM_PROMPT } from '../ai/review-prompt'
import { createLegacyMemoryProvider } from '../ai/memory/provider'
import { buildRunMemorySnapshot, memorySnapshotFingerprint, snapshotPromptMemories } from '../ai/memory/run-snapshot'
import { estimateComplexity, recommendModel, complexityLabel, detectCliWorthiness } from '../ai/smart-router'
import { getConfiguredApiProviders } from '../ai/cross-verify'
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
import { DEFAULT_AGENT_TURNS, MAX_BUDGET_TURNS, pendingWrites, pendingCommands, pendingPlans, suspendedSends, scopedKey, registerChatRun, unregisterChatRun, type FallbackAttempt } from '../ai/runner-shared'
// Распил ai.ts (1.9.8 #1): CLI-путь (4b) + API-путь/ядро (4c) вынесены в runner-модули.
import { runPlainConversation } from '../ai/runner-plain'
import { runApiConversation } from '../ai/runner-api'
import type { NewDecisionRecord, DecisionRecord } from '../storage/project-brain'
import { type ToolEvent } from '../ai/procedural-memory'
import {
  AGENT_RUN_TIMEOUT_SETTING_KEY,
  abortAgentRunForTimeout,
  exitReasonToAgentRunStatus,
  isAgentRunTimeoutAbort,
  resolveAgentRunTimeoutPolicy,
  shouldFireRunTimeout,
} from '../ai/run-lifecycle'
import { parseResumeCheckpoint, canReplayCheckpoint } from '../ai/resume-checkpoint'
import { intensityConfig, parseIntensity } from '../ai/intensity'
import { ALLOWED_WRITE_ROOTS_KEY, parseAllowedWriteRoots } from '../ai/allowed-write-roots'
import { join as joinPath } from 'node:path'
import type { AgentRuns, AgentRunOwner } from '../storage/agent-runs'
import type { SwitchResult } from '../storage/subscription-accounts'
import type { CooldownReason } from '../../shared/contracts/subscription'
import { expandOfficeAttachments } from '../ai/attachment-text'
import { logRuntime, logRuntimeError } from '../runtime-log'

export type { ProviderId } from '../ai/registry'

const OUTCOME_READ_TOOLS = [
  'read_file',
  'list_directory',
  'search_project',
  'find_files',
  'find_definition',
  'find_references',
  'get_project_map',
  'read_journal',
  'memory_search',
  'conversation_search',
  'check_diagnostics',
] as const

/** Main-process capability ceiling: renderer/prompt cannot widen Outcome phases. */
export function toolsForOutcomePhase(
  phase: 'refine' | 'plan' | 'execute-step' | 'verify' | 'replan',
): string[] | undefined {
  if (phase === 'refine') return [...OUTCOME_READ_TOOLS, 'submit_task_contract']
  if (phase === 'plan' || phase === 'replan') {
    return [...OUTCOME_READ_TOOLS, 'delegate_task', 'delegate_parallel', 'create_plan']
  }
  if (phase === 'verify') return [...OUTCOME_READ_TOOLS, 'run_command', 'attest_verification']
  return undefined
}

/** 2.0.8-D2/2.1.3-CD: результат резолва подписочного аккаунта. Реэкспорт из единого
 *  резолвера (electron/ai/resolve-subscription-account.ts — логика readiness там;
 *  тут остаётся публичный тип для runner'ов и deps). */
export type { ResolvedSubscription } from '../ai/resolve-subscription-account'
import type { ResolvedSubscription } from '../ai/resolve-subscription-account'

// Экспортирован для runner-api.ts (распил #1, срез 4c): AgentRunContext ссылается
// на AiDeps['...']-индексы. Type-only импорт в runner-api → без рантайм-цикла.
export interface AiDeps {
  getSecret: (key: string) => string | null
  /** Персист дневного cost-cap (дата + накопленные центы) между рестартами. Опционально —
   *  в тестах/делегатах не передаётся, тогда guard работает как in-memory. */
  setSecret?: (key: string, value: string) => void
  getProviderId: () => ProviderId
  getProviderModel: (id: ProviderId) => string | null
  /** 1.9.3 мультиаккаунт: аккаунт подписки провайдера. Резолвит секрет из SafeStorage по
   *  cred_ref, метаданные env-биндинга (config_dir/base_url) и touch'ит last_used_at.
   *  null = нет заведённых аккаунтов (падаем на legacy-секрет).
   *  2.0.8-D2: chatId учитывает per-chat pin (2.0.8-B binding). pinned=true — аккаунт закреплён
   *  за чатом (рантайм НЕ ротирует его авто, инвариант 1). `{ unavailable: true }` — чат закреплён
   *  на УДАЛЁННЫЙ аккаунт: НЕ тихая ротация — прогон обязан остановиться с вопросом (карточка B).
   *  2.1.3-CD: opts.accountId — явный one-shot выбор аккаунта. Явный выбор и pin проверяются
   *  на готовность: `{ blocked: true, reason, resetAt, label }` — стоп с понятной причиной
   *  (cooling / login-required) ДО старта прогона, вместо гарантированного фейла в рантайме. */
  resolveSubscriptionAccount?: (providerId: string, chatId?: number, opts?: { accountId?: number | null }) => ResolvedSubscription | null
  /** 1.9.4: активный аккаунт провайдера исчерпал лимит → пометить cooling и переключить на
   *  следующий готовый аккаунт пула. switched:false = пул исчерпан (падаем на provider-fallback).
   *  2.1.3-CD: reason (quota/rate-limit) пишется в cooldown для честного UI; результат несёт
   *  безопасные labels аккаунтов для route-evidence.
   *  EF-R1 Б3: fromAccountId — аккаунт, на котором реально упал запрос (run.account_id);
   *  без него охлаждается текущий global active (прежнее поведение). */
  switchSubscriptionAccountOnLimit?: (providerId: string, resetEta: number | null, reason?: CooldownReason, fromAccountId?: number | null) => SwitchResult
  /** EF-R1 Б3: scheduled-прогон подтверждает успешный ответ аккаунта после result.ok. */
  markSubscriptionAccountSuccess?: (accountId: number) => void
  /** Корни зарегистрированных проектов — для валидации projectPath из рендерера. */
  getKnownRoots: () => string[]
  /** Persist a write so the user can ↶ revert it later. */
  // 2.0.11-E: provenance опционален (обратно совместимо с 4-арг реализациями/типами).
  recordWrite: (projectPath: string, filePath: string, before: string | null, after: string, provenance?: { runId?: string | null; chatId?: number | null; messageId?: number | null }) => void
  /** Fetch the N most recent accepted writes for the Context Pack. */
  recentWrites: (projectPath: string, limit: number) => Array<{ filePath: string; createdAt: number }>
  /** Project Brain (Итер.4): прогретый ContextPack под задачу. null если не прогрет. */
  getBrainContext?: (projectPath: string, lastUserMessage: string) => { content: string; packType: string; tokenEstimate?: number | null } | null
  /** Persist a plan emitted by the AI. */
  recordPlan: ToolContext['recordPlan']
  getPlan?: ToolContext['getPlan']
  /** 2.1.0: durable Task Contract facade shared by IPC and tool handlers. */
  pipelineRuns?: ToolContext['pipelineRuns']
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
  /** 2.0.11-B: активный snapshot компакции чата. Модель получает [summary + хвост после
   *  границы] вместо всей истории. null/не передан → история как есть (прежнее поведение).
   *  Сжатие НЕ трогает видимую переписку — только то, что уходит в запрос. */
  getContextSnapshot?: (chatId: number) => { summary: string; throughMessageId: number } | null
}

let currentSendId = 0
const activeAborts = new Map<number, AbortController>()
const autoProofReportsSent = new Set<string>()

// Cost-cap на СУТКИ (Илья): лимит переносится через рестарт — дата+накопленные центы
// в settings. Новый день → сброс. UI пишет cost_cap_usd_per_day; legacy per_session
// читаем как fallback для старых конфигов.
const COST_CAP_USD_PER_DAY_KEY = 'cost_cap_usd_per_day'
const COST_CAP_LEGACY_SESSION_KEY = 'cost_cap_usd_per_session'
const COST_CAP_DAY_KEY = 'cost_cap_daily_date'
const COST_CAP_DAILY_CENTS_KEY = 'cost_cap_daily_cents'

function localDayKey(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parsePositiveFloat(raw: string | null): number | null {
  if (!raw) return null
  const value = Number.parseFloat(raw.replace(',', '.'))
  return Number.isFinite(value) && value > 0 ? value : null
}

function parseStoredCents(raw: string | null): number {
  if (!raw) return 0
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function createDailyCostGuard(deps: AiDeps): ReturnType<typeof createCostGuard> {
  const capUsd = parsePositiveFloat(deps.getSecret(COST_CAP_USD_PER_DAY_KEY) ?? deps.getSecret(COST_CAP_LEGACY_SESSION_KEY))
  const today = localDayKey()
  const storedDay = deps.getSecret(COST_CAP_DAY_KEY)
  const shouldReset = storedDay !== today
  const initialCents = shouldReset ? 0 : parseStoredCents(deps.getSecret(COST_CAP_DAILY_CENTS_KEY))

  if (shouldReset) {
    deps.setSecret?.(COST_CAP_DAY_KEY, today)
    deps.setSecret?.(COST_CAP_DAILY_CENTS_KEY, '0')
  }

  return createCostGuard(capUsd, {
    initialCents,
    periodLabel: 'сутки',
    onDailyCentsChange: cents => {
      deps.setSecret?.(COST_CAP_DAY_KEY, today)
      deps.setSecret?.(COST_CAP_DAILY_CENTS_KEY, String(Math.max(0, cents)))
    }
  })
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

// pending-registry (pendingWrites/Commands/Plans + suspendedSends + scopedKey) вынесен
// в runner-shared (распил #1, срез 4c) — общий синглтон с runner-api.

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
  // 2.1.3-EF S4: unattended-прогон проходит ТОТ ЖЕ единый resolver, что и ai:send.
  // Auto pre-flight промоутит готовый аккаунт вместо cooling-активного (resolver сам
  // делает setActiveAccount/clearCooling), а явные стопы честно отменяют прогон ДО сети.
  const sub = deps.resolveSubscriptionAccount?.(opts.providerId)
  if (sub && 'unavailable' in sub) {
    return { ok: false, text: '', error: 'Закреплённый аккаунт провайдера удалён — прогон отменён' }
  }
  if (sub && 'blocked' in sub) {
    const resetTxt = sub.resetAt != null
      ? ` до ${new Date(sub.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : ' (срок неизвестен)'
    return { ok: false, text: '', error: sub.reason === 'cooling'
      ? `Аккаунт «${sub.label}» остывает после лимита${resetTxt} — прогон отменён`
      : `Аккаунт «${sub.label}» требует входа — прогон отменён` }
  }
  if (sub && 'allBlocked' in sub) {
    return { ok: false, text: '', error: sub.reason === 'cooling'
      ? `Все аккаунты провайдера (${sub.count}) остывают — прогон отменён`
      : `Все аккаунты провайдера (${sub.count}) требуют входа — прогон отменён` }
  }
  const model = opts.model ?? descriptor.defaultModel

  try {
    // 2.0.8-C: scheduled/NL-cron прогон на openai-codex-oauth тоже обязан идти в изолированный
    // CODEX_HOME активного аккаунта (третий createProvider-сайт; ревью F1). Без этого unattended
    // прогон читал/рефрешил дефолтный ~/.codex/auth.json чужого аккаунта — дыра изоляции.
    const codexHome = resolveCodexHome(opts.providerId, deps.resolveSubscriptionAccount)
    const provider = createProvider(opts.providerId, { apiKey, model, cwd: opts.projectPath, signal: opts.signal, codexHome })
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
      resolveSubscriptionAccount: deps.resolveSubscriptionAccount,
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
    // EF-R1 Б3: успех подтверждён реальным ответом — отмечаем аккаунт, выбранный
    // pre-flight (у scheduled нет agent_run, accountId взят из resolver'а напрямую).
    if (sub && !('blocked' in sub) && !('allBlocked' in sub) && !('unavailable' in sub)) {
      try {
        deps.markSubscriptionAccountSuccess?.(sub.accountId)
      } catch { /* best-effort */ }
    }
    return { ok: true, text: result.text }
  } catch (err) {
    return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 2.0.8-C: изолированный CODEX_HOME для Codex-провайдеров. `codex-cli` и нативный
 * `openai-codex-oauth` аутентифицируются ОДИНАКОВО — `codex login` пишет
 * `<CODEX_HOME>/auth.json` — поэтому ОБА резолвят один активный Codex-аккаунт (реестр
 * `codex-cli`) и получают его config-dir (свой auth.json → свой credential-store-стейт по
 * пути). Раньше codexHome резолвился ТОЛЬКО для `codex-cli` → openai-codex-oauth всегда шёл
 * в дефолтный `~/.codex/auth.json`, и переключение аккаунтов на нём не действовало (2.0.4).
 *
 * Никакой мутации `process.env.CODEX_HOME` (глобал всего Electron, гонка между чатами) —
 * codexHome течёт аргументом в конкретный provider instance. `|| null` (не `??`): пустая
 * строка configDir нормализуется в null, иначе '' утёк бы downstream и authFilePath('')
 * свалился бы на process.env/~/.codex, сломав изоляцию (ревью F2). null → дефолтный путь.
 */
export function resolveCodexHome(
  providerId: string,
  // Структурный тип: берём только configDir. Явный union принимает и ResolvedSubscription
  // (success с configDir | { unavailable } | { blocked }), и упрощённый resolve в тестах
  // ({ configDir }). blocked-вариант configDir не несёт → дефолтный путь; реальный стоп
  // по blocked делает send-хендлер ДО этого вызова (2.1.3-CD).
  resolve: ((p: string, chatId?: number) => { configDir?: string | null } | { unavailable: true } | { blocked: true } | { allBlocked: true } | null) | undefined,
  chatId?: number,
): string | null {
  if (!isCodexAuthProvider(providerId)) return null
  // 2.0.8-D2: chatId → pinned Codex-аккаунт чата. unavailable-вариант configDir не несёт →
  // null (дефолтный путь); реальный стоп по unavailable делает send-хендлер ДО этого вызова.
  const r = resolve?.('codex-cli', chatId)
  return (r && 'configDir' in r ? r.configDir : null) || null
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
    /** 2.0.7-F: маршрут модели на ОДНУ отправку (провайдер/модель + fallbackPolicy).
     *  Когда задан — побеждает дефолт чата, requested пишется в agent_run, а strict
     *  отключает smart-fallback (не переезжать молча на другого провайдера). */
    promptRoute?: PromptRouteOverride
    /** Server validates this against durable pipeline state before exposing it to tools. */
    outcome?: { pipelineId: number; phase: 'refine' | 'plan' | 'execute-step' | 'verify' | 'replan' }
  }

  ipcMain.handle('ai:send', async (e, incomingMessages: ChatMessage[], projectPath: string | null, budget?: number, overrides?: AiSendOverrides, chatId?: string) => {
    // Безопасность: projectPath приходит из рендерера. Без проверки агент мог бы
    // получить файловый + shell доступ к произвольной системной папке (C:\Windows,
    // C:\Users\Pavel). Гейтим так же, как files/terminal IPC (isWithinKnownRoots).
    if (projectPath && !isWithinKnownRoots(projectPath, deps.getKnownRoots())) {
      throw new Error('Доступ запрещён: путь проекта не зарегистрирован')
    }
    const outcome = overrides?.outcome
    if (outcome) {
      const pipeline = deps.pipelineRuns?.get(outcome.pipelineId)
      const phases = new Set(['refine', 'plan', 'execute-step', 'verify', 'replan'])
      if (!Number.isInteger(outcome.pipelineId) || !phases.has(outcome.phase) || !pipeline || !projectPath || pipeline.projectPath !== projectPath) {
        throw new Error('OUTCOME_CONTEXT_INVALID: pipeline/phase не подтверждены main process')
      }
    }
    // #5 worktree-lifecycle: изолированный чат работает ЦЕЛИКОМ на своём worktree —
    // tools + контекст + recordWrite/undo (effRoot ниже). Иначе undo бил бы по main
    // (ревью: critical data-loss — правки в worktree, а undo-стек ключевался main).
    // Security-чек выше — на исходном main-пути; worktree создан нами (tmp). НЕ реассайним
    // projectPath (это сломало бы TS-narrowing из-за захвата в замыканиях) — отдельный const.
    const isolatedRoot = chatId ? (deps.worktreeSessions?.activePath(Number(chatId)) ?? null) : null
    // 2.0.8-D2: числовой chatId для резолва per-chat pin аккаунта (2.0.8-B binding).
    const chatIdNum = chatId ? Number(chatId) : undefined
    // 2.1.3-CD: явный one-shot аккаунт (promptRoute.accountId) — резолвится строго:
    // именно он идёт в провайдер, без тихой ротации на активный. Объявлено здесь (до
    // providerId), а сам resolveAcct — после providerId (он нужен для сверки).
    const oneShotAccountId = overrides?.promptRoute?.accountId ?? null
    // 2.0.11-B: активный снапшот компакции → модель получает [summary + хвост] вместо
    // всей простыни. Видимая переписка при этом не трогается — сжатие живёт только здесь,
    // в сборке запроса. Снапшота нет → история как есть (поведение прежнее).
    // resume-путь не задет: он перезаписывает messagesWithSystem целиком (историей из
    // чекпойнта, которая уже полная).
    const contextSnapshot = chatIdNum ? (deps.getContextSnapshot?.(chatIdNum) ?? null) : null
    const messages = prepareHistoryForModel(await expandOfficeAttachments(incomingMessages), contextSnapshot)
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
    // 2.0.7-F: promptRoute (модель на один prompt) побеждает дефолт чата, но НЕ меняет
    // его (one-shot — renderer шлёт его только с этой отправкой). requestedRoute пишется
    // в agent_run отдельно от actual; fallbackAllowed гейтит smart-fallback ниже.
    const promptRoute = overrides?.promptRoute ?? null
    // 2.0.7-F (карточка шаг 2): retry/resume берёт СОХРАНЁННЫЙ route из agent_run
    // (requested_*), а не из уже очищенного one-shot UI-стейта. Явный promptRoute этой
    // отправки важнее сохранённого. Сохраняется provider+model (политика fallback на
    // resume — обычная; отдельную колонку под неё не заводим).
    // Ревью F1: сохранённый id валидируем — провайдер мог быть удалён между прогоном и
    // resume, тогда PROVIDERS[providerId]=undefined → descriptor.transport упал бы. Гардим.
    const resumedProvider: ProviderId | null =
      isKnownProviderId(checkpointRun?.requestedProviderId) ? checkpointRun!.requestedProviderId : null
    const providerId = promptRoute?.providerId ?? overrides?.providerId ?? resumedProvider ?? deps.getProviderId()
    const descriptor = PROVIDERS[providerId]
    const sendId = ++currentSendId
    const planningOutcome = outcome?.phase === 'refine' || outcome?.phase === 'plan' || outcome?.phase === 'replan'
    const agentMode: AgentMode = planningOutcome ? 'plan' : (overrides?.agentMode ?? deps.getAgentMode())
    const outcomeToolsAllow = outcome ? toolsForOutcomePhase(outcome.phase) : undefined
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
    // 2.0.8-D2 + 2.1.3-CD: ранние стопы маршрута ДО создания run/провайдера — чистый выход.
    //  · unavailable: pin/one-shot на удалённый аккаунт → стоп-с-вопросом (НЕ тихая ротация).
    //  · blocked: явно выбранный (one-shot) или закреплённый аккаунт не готов (cooling /
    //    login-required) → стоп с понятной причиной вместо гарантированного фейла прогона.
    // chatPinned (аккаунт закреплён/явно выбран и жив) → ниже подавляет авто-свитч/fallback.
    const pinResolution = deps.resolveSubscriptionAccount?.(
      providerId, chatIdNum, oneShotAccountId != null ? { accountId: oneShotAccountId } : undefined)
    const chatPinned = !!(pinResolution && !('unavailable' in pinResolution) && !('blocked' in pinResolution) && !('allBlocked' in pinResolution) && pinResolution.pinned)
    // EF-R1 Б3: аккаунт, подтверждённый pre-flight для ЭТОГО прогона — фиксируется в
    // agent_runs.account_id. Success/охлаждение привязываются к нему, а не к global
    // active на момент финиша (параллельные прогоны / ручное переключение).
    const runAccountId = pinResolution && !('unavailable' in pinResolution) && !('blocked' in pinResolution) && !('allBlocked' in pinResolution)
      ? pinResolution.accountId
      : null
    // Ранняя ошибка маршрута: id:0 (owner ещё не зарегистрирован) + chatId в обёртке —
    // рендерер доставляет спец-текст в нужный чат (CD; раньше дропался роутером, и
    // пользователь видел только общий «провайдер недоступен»).
    const earlyRouteStop = (message: string): 0 => {
      taggedSender.send('ai:event', { id: 0, chatId: chatIdNum ?? null, event: { type: 'error', message } })
      activeAborts.delete(sendId)
      clearRunTimeout()
      return 0
    }
    if (pinResolution && 'unavailable' in pinResolution) {
      return earlyRouteStop(oneShotAccountId != null
        ? 'Выбранный на один запрос аккаунт был удалён. Выберите другой аккаунт или режим Auto.'
        : 'Аккаунт, закреплённый за этим чатом, был удалён. Выберите аккаунт заново или снимите закрепление.')
    }
    if (pinResolution && 'blocked' in pinResolution) {
      const { reason, resetAt, label } = pinResolution
      const suffix = oneShotAccountId != null
        ? 'Выберите другой аккаунт или режим Auto.'
        : 'Выберите другой аккаунт или снимите закрепление.'
      const message = reason === 'cooling'
        ? `Аккаунт «${label}» остывает после лимита · ${resetAt != null ? `восстановится в ${new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'время восстановления неизвестно'}. ${suffix}`
        : `Аккаунт «${label}» требует входа. Выполните вход в Настройки → Подписки или выберите другой аккаунт.`
      return earlyRouteStop(message)
    }
    // EF S1: Auto pre-flight исчерпал пул — ВСЕ аккаунты провайдера неготовы. Честный
    // стоп ДО сети (вместо гарантированного 429 активного): ближайший известный resetAt,
    // until=NULL у всех → «сроки неизвестны» (не превращаем в ложный ready).
    if (pinResolution && 'allBlocked' in pinResolution) {
      const { reason, resetAt, count } = pinResolution
      const message = reason === 'cooling'
        ? `Все аккаунты провайдера (${count}) остывают после лимита · ${resetAt != null ? `ближайшее восстановление в ${new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'сроки восстановления неизвестны'}. Дождитесь сброса лимита или проверьте аккаунты в Настройки → Подписки.`
        : `Все аккаунты провайдера (${count}) требуют входа. Выполните вход в Настройки → Подписки.`
      return earlyRouteStop(message)
    }
    // EF-R2 Б1: ЕДИНЫЙ resolved account context попытки. После ранних стопов здесь
    // pinResolution ∈ {success, null, undefined}. Между этой точкой и createProvider —
    // await'ы (attachments/context/CLI-prompt): повторный resolve после них мог прочитать
    // УЖЕ сменившийся active/pin → провайдер пошёл бы через B при run.accountId=A.
    // Credentials/codexHome у createProvider берутся ТОЛЬКО из этого объекта (тот же,
    // что дал runAccountId) — смена active/pin во время подготовки расхождения не создаёт.
    const mainAcct = pinResolution ?? null
    // 2.0.11-B: реестр «чат занят» для гейта ручной компакции. Ставится ЗДЕСЬ — ПОСЛЕ
    // раннего выхода на удалённом pin'е и до любой длительной работы: прогон стартовал
    // по-настоящему. Раньше стояло рядом с activeAborts.set, и ранний выход оставлял чат
    // «занятым» навсегда — кнопка сжатия серела до перезапуска (ревью B #5/#7). Снимается
    // в cleanup, между этой строкой и ним ранних выходов нет — забыть снятие нельзя.
    registerChatRun(sendId, chatIdNum)
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
      unregisterChatRun(sendId)
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

    // 2.0.7-F: сохранённая requested-модель прогона применяется при resume того же
    // провайдера (иначе взяли бы дефолт чата — потеря route). Только если провайдер совпал.
    const resumedModel = (resumedProvider && resumedProvider === providerId && checkpointRun?.requestedModel) || null
    let model = (promptRoute?.model ?? overrides?.model ?? resumedModel ?? deps.getProviderModel(providerId)) ?? descriptor.defaultModel
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
    if (descriptor.transport !== 'API' && deps.saveRunInput) {  // CLI + Tunnel (2.0.4)
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
      // 1.9.3 мультиаккаунт: токен ИМЕННО аккаунта прогона (mainAcct — единый resolve
      // EF-R2 Б1, тот же, что дал run.accountId); парка нет → legacy-одиночный токен settings.
      const claudeOauthToken = providerId === 'claude-cli'
        ? (mainAcct?.secret ?? deps.getSecret('claude_code_oauth_token'))
        : null
      // Codex мультиаккаунт (2.0.8-C): CODEX_HOME аккаунта прогона (тот же mainAcct —
      // никакого повторного resolve после await, EF-R2 Б1). Парка нет (mainAcct=null) →
      // прежний legacy-путь resolveCodexHome (дефолтный ~/.codex вне управляемого парка).
      const codexHome = isCodexAuthProvider(providerId)
        ? (mainAcct
            ? (mainAcct.configDir || null)
            : resolveCodexHome(providerId, deps.resolveSubscriptionAccount, chatIdNum))
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
      // 2.0.7-E: гейт живого каталога для grok-cli. Читает кешированный каталог (settings)
      // и решает, блокировать ли запрошенную модель. Только для grok-cli (первый live-адаптер).
      const checkModel = providerId === 'grok-cli'
        ? (m: string) => checkModelAvailable(loadLiveCatalog({ get: deps.getSecret, set: () => {} }, 'grok-cli'), m, Date.now())
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
        memories: descriptor.transport !== 'API' ? memories : undefined,  // CLI + Tunnel (2.0.4)
        effortLevel: resolvedEffort,
        agentMode,
        checkModel
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

    // Cost guard на СУТКИ (turns of API loop). Лимит cost_cap_usd_per_day + накопленные
    // за день центы переживают рестарт (персист в settings). guard.recordAndCheck
    // остановит цикл при превышении. CLI = подписка = $0 (guard эффективно отключен).
    const costGuard = createDailyCostGuard(deps)

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
        // 2.0.7-F: requested (что выбрал пользователь через promptRoute) отдельно от
        // provider_id/model = actual (что реально отработало после fallback). null =
        // запрошенное совпадает с дефолтом чата. DoD: after-send сверить actual vs requested.
        requestedProviderId: promptRoute?.providerId ?? null,
        requestedModel: promptRoute?.model ?? null,
        sendId,
        // Crash-resume: режим прогона — гард деструктива в баннере возобновления
        // (auto/bypass → авто-resume запрещён).
        agentMode,
        // EF-R1 Б3: фактический аккаунт прогона (pre-flight подтверждённый).
        accountId: runAccountId
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
      // 2.1.3-CD: запрошенный one-shot аккаунт — первая запись route-evidence прогона.
      // Timeline/Proof читают её без разбора логов; label — безопасное имя, не id.
      if (oneShotAccountId != null && pinResolution && !('unavailable' in pinResolution) && !('blocked' in pinResolution) && !('allBlocked' in pinResolution)) {
        try {
          deps.agentRuns?.appendEvent(runId, 'route', {
            label: 'requested-account',
            detail: `Запрошен аккаунт «${pinResolution.label}» на один запрос (строго, без ротации и запасного провайдера)`,
            status: 'info',
          })
        } catch { /* best-effort */ }
      }
      // EF S1+S6: Auto pre-flight выбрал следующий готовый аккаунт ДО сетевого запроса.
      // Фиксируем ротацию в route-evidence (Timeline/Proof читают без разбора логов) и
      // шлём route-changed — пилюля «⇄ Аккаунт A → B» появляется сразу, а не после 429.
      // Только label'ы: никаких id/credRef/configDir наружу.
      if (pinResolution && !('unavailable' in pinResolution) && !('blocked' in pinResolution) && !('allBlocked' in pinResolution) && pinResolution.skipped) {
        const skipped = pinResolution.skipped
        const reasonTxt = skipped.reason === 'cooling' ? 'остывает' : 'требует входа'
        const resetTxt = skipped.resetAt != null
          ? ` до ${new Date(skipped.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : ', срок неизвестен'
        try {
          deps.agentRuns?.appendEvent(runId, 'route', {
            label: 'rotate-account',
            detail: `Auto: аккаунт «${skipped.fromLabel}» пропущен (${reasonTxt}${resetTxt}) → выбран «${pinResolution.label}»`,
            ref: JSON.stringify({
              kind: 'rotate-account',
              preflight: true,
              reason: skipped.reason,
              fromAccountLabel: skipped.fromLabel,
              toAccountLabel: pinResolution.label,
              resetAt: skipped.resetAt,
              requested: { providerId, model: model ?? null },
              actual: { providerId, model: model ?? null },
            }),
            status: 'ok',
          })
        } catch { /* best-effort */ }
        taggedSender.send('ai:event', {
          id: sendId,
          event: {
            type: 'route-changed',
            action: 'rotate-account',
            reason: skipped.reason,
            attempt: 0,
            requested: { providerId, model: model ?? '' },
            actual: { providerId, model: model ?? '' },
            resetAt: skipped.resetAt,
            accounts: { fromLabel: skipped.fromLabel, toLabel: pinResolution.label },
          },
        })
      }
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
    if (outcome && !useToolsPath) {
      const message = 'OUTCOME_TRANSPORT_UNSUPPORTED: выбранный CLI/tunnel transport не гарантирует Task Contract и Proof. Используй API provider.'
      taggedSender.send('ai:event', { id: sendId, event: { type: 'error', message } })
      taggedSender.send('ai:event', { id: sendId, event: { type: 'done' } })
      try { deps.agentRuns?.finish(runId, 'failed', { error: message }) } catch { /* best-effort */ }
      cleanup()
      return sendId
    }

    // Smart fallback: при ошибке (429/5xx/сеть) пробуем следующего провайдера.
    // Только если smart_fallback не отключён явно, только для API-провайдеров,
    // только без reviewer override (ревьюер работает в изоляции).
    // 2.0.7-F: explicit prompt-route по умолчанию strict — при сбое выбранного провайдера
    // НЕ переезжать молча на другого (пользователь выбрал модель осознанно). 'allow'
    // возвращает прежнее поведение smart-fallback. Нет promptRoute → fallback как раньше.
    // 2.1.3-CD: выбран КОНКРЕТНЫЙ аккаунт → строго всегда: ни ротации аккаунта, ни
    // provider-fallback, независимо от fallbackPolicy (иначе запрос молча уехал бы с
    // осознанно выбранного аккаунта — главный сценарий карточки C).
    const routeFallbackAllowed = (!promptRoute || promptRoute.fallbackPolicy === 'allow') && oneShotAccountId == null
    const smartFallbackEnabled = deps.getSecret('smart_fallback') !== 'false'
      && descriptor.transport === 'API'
      && !overrides?.providerId  // не задействуем fallback в Explicit Review
      && routeFallbackAllowed    // strict prompt-route отключает fallback

    /** Создаёт fallback-attempt (провайдер + аккаунт попытки) для кандидата с теми же опциями.
     *  EF-R2 Б2: возвращает FallbackAttempt — lineage аккаунта доезжает до runner'а,
     *  который фиксирует/очищает run.account_id ДО выполнения попытки. */
    function makeFallbackAttempt(fallbackId: ProviderId): FallbackAttempt | null {
      const fallbackDesc = PROVIDERS[fallbackId]
      if (!fallbackDesc) return null
      const fallbackKey = fallbackDesc.secretKey ? deps.getSecret(fallbackDesc.secretKey) : null
      if (fallbackDesc.secretKey && !fallbackKey) return null
      const fallbackModel = deps.getProviderModel(fallbackId) ?? fallbackDesc.defaultModel
      // EF-R1 Б2: pre-flight НЕПОСРЕДСТВЕННО перед созданием fallback-attempt. Парк
      // аккаунтов есть, но выбор unavailable/blocked/allBlocked → НЕ подменяем молча
      // default credential (legacy env-токен / ~/.codex) — fallback-кандидата просто нет.
      // Парка нет (resolver → null) → прежний legacy-путь, accountId=null (очистка).
      const fbRes = deps.resolveSubscriptionAccount?.(fallbackId, chatIdNum) ?? null
      if (fbRes && ('unavailable' in fbRes || 'blocked' in fbRes || 'allBlocked' in fbRes)) return null
      // 1.9.3/1.9.4: при пересоздании CLI-провайдера резолвим активный аккаунт ЗАНОВО —
      // для account-switch на лимите берётся новый токен/CODEX_HOME переключённого аккаунта.
      const fbClaudeToken = fallbackId === 'claude-cli'
        ? (fbRes && 'secret' in fbRes ? fbRes.secret : deps.getSecret('claude_code_oauth_token'))
        : null
      const fbCodexHome = fbRes && 'configDir' in fbRes
        ? (fbRes.configDir || null)
        : resolveCodexHome(fallbackId, deps.resolveSubscriptionAccount, chatIdNum)
      try {
        const provider = createProvider(fallbackId, {
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
        // EF-R2 Б2: аккаунт, закреплённый за ЭТОЙ попыткой. Resolver вернул success →
        // его accountId; парка нет → null (handoff явно очистит run.account_id).
        const accountId = fbRes && 'accountId' in fbRes ? fbRes.accountId : null
        return { provider, accountId }
      } catch {
        return null
      }
    }

    /** EF-R1 Б3: охлаждаем аккаунт, на котором РЕАЛЬНО упал запрос (run.account_id),
     *  а не текущий global active. EF-R2 Б2: accountId нового attempt фиксирует runner
     *  через handoff-envelope (getNextAttempt) — здесь только охлаждение. */
    const switchAccountOnLimitForRun = (pid: string, eta: number | null, reason?: CooldownReason): SwitchResult => {
      let fromAccountId: number | null = null
      try {
        fromAccountId = deps.agentRuns?.get(runId)?.accountId ?? null
      } catch { /* best-effort */ }
      return deps.switchSubscriptionAccountOnLimit?.(pid, eta, reason, fromAccountId) ?? { switched: false }
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
        recordWrite: deps.recordWrite, recordPlan: deps.recordPlan, getPlan: deps.getPlan,
        recordJournal: deps.recordJournal, readJournal: deps.readJournal,
        saveMemory: deps.saveMemory, saveDecision: deps.saveDecision, invalidateMemory: deps.invalidateMemory,
        searchMemories: deps.searchMemories, searchConversations: deps.searchConversations,
        connectors: deps.connectors, agentMode, turnsBudget,
        skillRegistry: deps.skillRegistry, getSecretForDelegate: deps.getSecret, costGuard,
        resolveSubscriptionAccount: deps.resolveSubscriptionAccount,
        providerId, model,
        fallbackOpts: smartFallbackEnabled ? { getNextAttempt: makeFallbackAttempt, getProviderModel: (id) => deps.getProviderModel(id) ?? PROVIDERS[id]?.defaultModel ?? null, configuredProviders: new Set(getConfiguredApiProviders(deps.getSecret)), triedProviders: new Set([providerId]), switchAccountOnLimit: switchAccountOnLimitForRun, pinnedAccount: chatPinned } : undefined,
        mcpClientRef: deps.mcpClient, appendAuditFn: auditFn, trackToolPatternFn: deps.trackToolPattern,
        parentChatId: chatId ? Number(chatId) : null,
        subSessions: deps.subSessions, sessionTodos: deps.sessionTodos,
        agentRuns: deps.agentRuns, runId, verifications: deps.verifications,
        toolsAllow: outcomeToolsAllow ?? overrides?.toolsAllow ?? null,
        recipe: overrides?.recipe,
        outcome,
        pipelineRuns: deps.pipelineRuns,
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
        smartFallbackEnabled ? { getNextAttempt: makeFallbackAttempt, getProviderModel: (id) => deps.getProviderModel(id) ?? PROVIDERS[id]?.defaultModel ?? null, configuredProviders: new Set(getConfiguredApiProviders(deps.getSecret)), triedProviders: new Set([providerId]), switchAccountOnLimit: switchAccountOnLimitForRun, pinnedAccount: chatPinned } : undefined,
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

