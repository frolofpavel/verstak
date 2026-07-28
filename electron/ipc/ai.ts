import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { notifyRunEvent, shouldSendAutoProofReport } from '../ai/run-notify'
import { clearRunUntilGreenForSend, clearSmartApproveForSend } from './tool-handlers/command'
import { createToolsForProject, TOOL_DEFS } from '../ai/tools'
import { isWithinKnownRoots } from '../ai/path-policy'
import { createProvider, PROVIDERS, type ProviderId } from '../ai/registry'
import type { PromptRouteOverride } from '../../shared/contracts/provider'
import type { McpClient } from '../mcp/client'
import { prepareSystemContext } from '../ai/compose-system'
import { prepareHistoryForModel } from '../ai/history-preparation'
import { applyRecipeToSkillPrompt } from '../ai/skills/recipe'
import type { RecipeSpec } from '../ai/skills/types'
import { systemForProvider, stripCacheBreakpoint } from '../ai/compose-prompt'
import { detectCliWorthiness } from '../ai/smart-router'
import { createCostGuard } from '../ai/cost-guard'
import { createDailyCostGuard } from '../ai/daily-cost-guard'
import { SessionAgentCounter } from '../ai/delegation-limits'
import type { AgentMode } from '../ai/mode-policy'
import { loadPermissionRules } from '../ai/permission-rules'
import type { ChatMessage, ChatProvider } from '../ai/types'
import { type ToolContext, type TaggedSender as HandlerTaggedSender } from './tool-handlers'
// Распил ai.ts (1.9.8 #1): эмиссия прогресса (срез 1) + supplements (срез 2).
import { tagSender, compactProgressText, modelProgressLabel, emitAgentProgress } from '../ai/runner-progress'
import { DEFAULT_AGENT_TURNS, MAX_BUDGET_TURNS, pendingWrites, pendingCommands, pendingPlans, suspendedSends, scopedKey, registerChatRun, unregisterChatRun } from '../ai/runner-shared'
// Распил ai.ts (2.1.10-E): preflight + выбор маршрута + fallback вынесены в ai-send/*.
import { preflightOutcome, toolsForOutcomePhase, type OutcomeRequest } from './ai-send/outcome-preflight'
import { selectSendProvider, selectSendModel, decideSmartRouting, resolveCodexHome } from './ai-send/route-selection'
import { preflightSubscriptionAccount } from './ai-send/account-preflight'
import { isSmartFallbackAllowed, createFallbackAttemptFactory, createLimitAccountSwitcher, buildFallbackOpts } from './ai-send/fallback-route'
import { openAgentRun, linkDevTaskRun, startRunTimeout } from './ai-send/run-bookkeeping'
// Распил ai.ts (2.1.10-G): сборка контекста и промпта вынесена в ai-send/*.
import { buildSendMemoryContext } from './ai-send/memory-context'
import { assembleSendSystem } from './ai-send/system-assembly'
import { buildProviderRuntimeOptions } from './ai-send/provider-options'
import { saveRunInputSnapshot } from './ai-send/run-input'
import { registerAiResolveIpc } from './ai-resolve'
// Распил ai.ts (1.9.8 #1): CLI-путь (4b) + API-путь/ядро (4c) вынесены в runner-модули.
import { runPlainConversation } from '../ai/runner-plain'
import { runApiConversation } from '../ai/runner-api'
import type { NewDecisionRecord, DecisionRecord } from '../storage/project-brain'
import { type ToolEvent } from '../ai/procedural-memory'
import { parseResumeCheckpoint } from '../ai/resume-checkpoint'
import { intensityConfig, parseIntensity } from '../ai/intensity'
import { ALLOWED_WRITE_ROOTS_KEY, parseAllowedWriteRoots } from '../ai/allowed-write-roots'
import type { AgentRuns, AgentRunOwner } from '../storage/agent-runs'
import type { SwitchResult } from '../storage/subscription-accounts'
import type { CooldownReason } from '../../shared/contracts/subscription'
import { expandOfficeAttachments } from '../ai/attachment-text'
import { logRuntime, logRuntimeError } from '../runtime-log'
import { registerAiCountTokensIpc } from './ai-count-tokens'

export type { ProviderId } from '../ai/registry'

// Публичная поверхность ai.ts сохранена: обе функции переехали в ai-send/*, но
// импортёры (main.ts, тесты) продолжают брать их отсюда.
export { toolsForOutcomePhase } from './ai-send/outcome-preflight'
export { resolveCodexHome } from './ai-send/route-selection'

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
  plans?: ToolContext['plans']
  tasks?: ToolContext['tasks']
  planOutcomes?: ToolContext['planOutcomes']
  agentJobs?: ToolContext['agentJobs']
  agentJobScheduler?: ToolContext['agentJobScheduler']
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

// Реестр прогретых памятью чатов переехал в ai-send/memory-context вместе с блоком
// recall'а (2.1.10-G). Публичная поверхность ai.ts сохранена: main.ts и тесты
// продолжают импортировать обе функции отсюда.
export { forgetMemorizedChat, forgetMemorizedProject } from './ai-send/memory-context'

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
  opts: {
    projectPath: string; prompt: string; providerId: ProviderId; model: string | null; signal: AbortSignal
    /** VSK-PLAN-GEN-A2: генерация плана переиспользует ЭТОТ прогон, а не заводит
     *  свой (ТЗ §2 запрещает второй agent loop). Отличий ровно три и все явные:
     *  режим (plan вместо auto — изменения блокирует mode-policy), набор
     *  инструментов (+create_plan) и sendId (ключ реестра планов прогона). */
    agentMode?: ToolContext['agentMode']
    allowedTools?: readonly string[]
    sendId?: number
    role?: 'scheduled' | 'plan-generation'
  }
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
      sender, sendId: opts.sendId ?? -1, signal: opts.signal, projectPath: opts.projectPath, tools,
      recordWrite: deps.recordWrite, recordPlan: deps.recordPlan, recordJournal: deps.recordJournal,
      readJournal: deps.readJournal, saveMemory: deps.saveMemory, saveDecision: deps.saveDecision,
      searchMemories: deps.searchMemories, searchConversations: deps.searchConversations, connectors: deps.connectors,
      pendingAttachments: [], pendingWrites: new Map(), pendingCommands: new Map(), scopedKey,
      agentMode: opts.agentMode ?? 'auto', readOnlyConnectors: true, skillRegistry: deps.skillRegistry, getSecretForDelegate: deps.getSecret,
      // Генерации плана нужен доступ к таблице планов: create_plan пишет через
      // recordPlan, а порог согласования читает уже сохранённое.
      plans: deps.plans, getPlan: deps.getPlan,
      resolveSubscriptionAccount: deps.resolveSubscriptionAccount,
      permissionRules: loadPermissionRules(opts.projectPath),
      currentProviderId: opts.providerId, mcpClient: deps.mcpClient,
      subCostGuard: createCostGuard(null), parentChatId: null,
      delegationDepth: 0, agentCounter: new SessionAgentCounter(),
      agentJobs: deps.agentJobs, agentJobScheduler: deps.agentJobScheduler,
    }
    const { runSubAgentLoop } = await import('../ai/sub-agent-loop')
    const result = await runSubAgentLoop({
      provider, messages, allowedToolNames: [...(opts.allowedTools ?? SCHEDULED_READONLY_TOOLS)], ctx,
      signal: opts.signal, role: opts.role ?? 'scheduled',
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
    /** Снимок выбранного в UI маршрута на момент нажатия Send. Не превращает его
     * в strict one-shot и не меняет семантику fallback. */
    selectedProviderId?: ProviderId
    selectedModel?: string | null
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
    outcome?: OutcomeRequest
  }

  ipcMain.handle('ai:send', async (e, incomingMessages: ChatMessage[], projectPath: string | null, budget?: number, overrides?: AiSendOverrides, chatId?: string) => {
    // Безопасность: projectPath приходит из рендерера. Без проверки агент мог бы
    // получить файловый + shell доступ к произвольной системной папке (C:\Windows,
    // C:\Users\Pavel). Гейтим так же, как files/terminal IPC (isWithinKnownRoots).
    if (projectPath && !isWithinKnownRoots(projectPath, deps.getKnownRoots())) {
      throw new Error('Доступ запрещён: путь проекта не зарегистрирован')
    }
    // Outcome preflight (2.1.10-E, срез 1): pipeline/phase/step сверяются с durable
    // состоянием ДО старта прогона; непроверенный контекст = throw, прогона нет.
    const outcomePreflight = overrides?.outcome
      ? preflightOutcome(overrides.outcome, projectPath, deps)
      : null
    const outcome = outcomePreflight?.outcome
    const outcomeStepInstruction = outcomePreflight?.stepInstruction ?? null
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
    if (outcomeStepInstruction) messages.push({ role: 'user', content: outcomeStepInstruction })
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
    // §10 хвост: продолжение после «Доработать» приходит якорем на чекпойнт того
    // прогона, чей план ещё ждёт решения. По этой же связи replan_plan на
    // чат-пути узнаёт, какой именно план править — номер не спрашивается у
    // модели. Approve переводит план в 'running', поэтому цель доработки
    // пропадает сама, без отдельного снятия.
    const revisePlanId = overrides?.resumeFromRunId
      ? (deps.plans?.findDraftByRunId(overrides.resumeFromRunId)?.id ?? null)
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
    // отправки важнее сохранённого. Лестница приоритетов и гард удалённого провайдера —
    // в selectSendProvider (2.1.10-E, срез 2а).
    const { providerId, descriptor, resumedProviderId: resumedProvider } = selectSendProvider({
      promptRoute,
      overrideProviderId: overrides?.providerId,
      overrideSelectedProviderId: overrides?.selectedProviderId,
      checkpointRun,
      getProviderId: deps.getProviderId,
    })
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
    const acctPreflight = preflightSubscriptionAccount({
      providerId,
      chatId: chatIdNum,
      oneShotAccountId,
      resolve: deps.resolveSubscriptionAccount,
    })
    // Ранняя ошибка маршрута: id:0 (owner ещё не зарегистрирован) + chatId в обёртке —
    // рендерер доставляет спец-текст в нужный чат (CD; раньше дропался роутером, и
    // пользователь видел только общий «провайдер недоступен»).
    const earlyRouteStop = (message: string): 0 => {
      taggedSender.send('ai:event', { id: 0, chatId: chatIdNum ?? null, event: { type: 'error', message } })
      activeAborts.delete(sendId)
      clearRunTimeout()
      return 0
    }
    if (!acctPreflight.ok) return earlyRouteStop(acctPreflight.message)
    // EF-R2 Б1: ЕДИНЫЙ resolved account context попытки. Между этой точкой и
    // createProvider — await'ы (attachments/context/CLI-prompt): повторный resolve после
    // них мог прочитать УЖЕ сменившийся active/pin → провайдер пошёл бы через B при
    // run.accountId=A. Credentials/codexHome у createProvider берутся ТОЛЬКО из mainAcct.
    const { account: mainAcct, chatPinned, runAccountId } = acctPreflight
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
    const { memories, consolidationHint, coreMemory: coreMemorySnapshot } = buildSendMemoryContext({
      projectPath,
      chatId,
      messages,
      deps: { searchMemories: deps.searchMemories, memoryConsolidationHint: deps.memoryConsolidationHint },
      sendId,
      runId,
      emitProgress: payload => emitAgentProgress(taggedSender, sendId, payload),
    })

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
    // Ветвление сборки (resume / reviewer / API / CLI-скилл) вынесено в
    // ai-send/system-assembly (2.1.10-G). Порядок веток и их приоритет сохранены;
    // здесь остались только побочные эффекты — прогресс и бейдж Мозга.
    const assembled = await assembleSendSystem({
      messages,
      projectPath,
      providerId,
      descriptor,
      agentMode,
      resumedMessages,
      checkpointRun,
      skillLayerPrompt,
      skillOverridePrompt: overrides?.systemPrompt,
      useReviewerPrompt: Boolean(overrides?.useReviewerPrompt),
      memories,
      consolidationHint,
      coreMemory: coreMemorySnapshot,
      intensitySystemHint: intCfg.systemHint,
      deps: {
        getSecret: deps.getSecret,
        recentWrites: deps.recentWrites,
        getBrainContext: deps.getBrainContext,
      },
    })
    messagesWithSystem = assembled.messagesWithSystem
    composedSystem = assembled.composedSystem
    brain = assembled.brain

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
    let model = selectSendModel({
      promptRoute,
      overrideModel: overrides?.model,
      overrideSelectedModel: overrides?.selectedModel,
      providerId,
      resumedProviderId: resumedProvider,
      checkpointRun,
      descriptor,
      getProviderModel: deps.getProviderModel,
    })
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
    // выбираем дешёвую/мощную модель по сложности запроса. Решение — в decideSmartRouting;
    // здесь остаются побочные эффекты (лог + info-событие), чтобы порядок событий не поехал.
    const smartRoutingEnabled = deps.getSecret('smart_routing') !== 'false'
    const smartPick = decideSmartRouting({
      enabled: smartRoutingEnabled,
      overrideModel: overrides?.model,
      overrideSelectedModel: overrides?.selectedModel,
      overrideProviderId: overrides?.providerId,
      effortLevel: resolvedEffort,
      descriptor,
      providerId,
      model,
      messages,
    })
    if (smartPick) {
      model = smartPick.model
      logRuntime('ai.smart_routing.pick', {
        sendId,
        runId,
        providerId,
        previousModel: smartPick.previousModel,
        model,
        complexity: smartPick.complexity
      })
      taggedSender.send('ai:event', {
        id: sendId,
        event: {
          type: 'info',
          text: `📊 ${smartPick.complexity} → using ${smartPick.model} (smart routing)`
        }
      })
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
    if (composedSystem != null) {
      saveRunInputSnapshot({
        save: deps.saveRunInput,
        runId,
        projectPath,
        chatId: chatId ? Number(chatId) : null,
        providerId,
        model: model ?? null,
        systemPrompt: stripCacheBreakpoint(composedSystem),
        messages,
      })
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

    // 2.2 speed: Debug Packet получает ФАКТИЧЕСКИЙ payload через callback самого
    // CLI-провайдера. Раньше здесь синхронно строился второй полный context-pack,
    // удваивая локальную подготовку до первого токена.
    const onCliPromptBuilt = descriptor.transport !== 'API' && deps.saveRunInput
      ? (cliPayload: string) => saveRunInputSnapshot({
          save: deps.saveRunInput,
          runId,
          projectPath,
          chatId: chatId ? Number(chatId) : null,
          providerId,
          model: model ?? null,
          systemPrompt: cliPayload,
          messages,
        })
      : undefined

    emitAgentProgress(taggedSender, sendId, {
      id: 'provider-create',
      phase: 'model',
      title: 'Подключаю модель',
      detail: modelProgressLabel(providerId, model),
      status: 'running'
    })
    let provider: ChatProvider
    try {
      // Провайдер-специфичные опции (OAuth-токен Claude Code, изолированный CODEX_HOME,
      // custom endpoint, вторые секреты YandexGPT/GigaChat, гейт каталога grok-cli)
      // собраны в ai-send/provider-options (2.1.10-G). Аккаунт попытки — mainAcct,
      // единый resolve EF-R2 Б1: повторного резолва после await'ов по-прежнему нет.
      const {
        claudeOauthToken, codexHome, customBaseUrl, customModels,
        yandexFolderId, gigachatClientSecret, gigachatTlsVerify, checkModel,
      } = buildProviderRuntimeOptions({
        providerId,
        account: mainAcct,
        chatId: chatIdNum,
        getSecret: deps.getSecret,
        resolveSubscriptionAccount: deps.resolveSubscriptionAccount,
      })
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
        checkModel,
        onPromptBuilt: onCliPromptBuilt
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
    const emitRunEvent = (event: unknown) => taggedSender.send('ai:event', { id: sendId, event })
    openAgentRun({
      agentRuns: deps.agentRuns,
      runId,
      sendId,
      projectPath,
      chatId: chatId ? Number(chatId) : null,
      chatIdRaw: chatId ?? null,
      owner: runOwner,
      title: runTitle,
      providerId,
      model: model ?? null,
      // 2.0.7-F: requested (что выбрал пользователь через promptRoute) отдельно от
      // provider_id/model = actual (что реально отработало после fallback). null =
      // запрошенное совпадает с дефолтом чата. DoD: after-send сверить actual vs requested.
      requestedProviderId: promptRoute?.providerId ?? null,
      requestedModel: promptRoute?.model ?? null,
      agentMode,
      // EF-R1 Б3: фактический аккаунт прогона (pre-flight подтверждённый).
      accountId: runAccountId,
      account: mainAcct,
      oneShotAccountId,
      emit: emitRunEvent,
    })

    linkDevTaskRun({
      link: deps.linkDevTaskRun,
      projectPath,
      chatId: chatId ? Number(chatId) : null,
      chatIdRaw: chatId ?? null,
      runId,
      sendId,
      owner: runOwner,
    })

    runTimeout = startRunTimeout({
      getSecret: deps.getSecret,
      agentRuns: deps.agentRuns,
      controller: ctrl,
      runId,
      sendId,
      projectPath,
      chatIdRaw: chatId ?? null,
      providerId,
      model: model ?? null,
      emit: emitRunEvent,
    })

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

    // Smart fallback (2.1.10-E, срез 3): гейт + фабрика attempt'ов + свитчер аккаунта
    // живут в ai-send/fallback-route.ts. Envelope собирается ЛЕНИВО — только когда
    // fallback реально разрешён (иначе лишний обход настроек провайдеров на каждый send).
    const smartFallbackEnabled = isSmartFallbackAllowed({
      getSecret: deps.getSecret,
      descriptor,
      overrideProviderId: overrides?.providerId,
      promptRoute,
      oneShotAccountId,
    })
    const makeFallbackAttempt = createFallbackAttemptFactory(
      { getSecret: deps.getSecret, getProviderModel: deps.getProviderModel, resolveSubscriptionAccount: deps.resolveSubscriptionAccount },
      {
        chatId: chatIdNum,
        cwd: projectPath ?? process.cwd(),
        signal: ctrl.signal,
        projectSystemPrompt: projectSystemPromptForProvider,
        skillPrompt: skillPromptForProvider,
        effortLevel: overrides?.effortLevel,
        agentMode,
      },
    )
    const fallbackOpts = smartFallbackEnabled
      ? buildFallbackOpts({
        getSecret: deps.getSecret,
        getProviderModel: deps.getProviderModel,
        makeFallbackAttempt,
        switchAccountOnLimit: createLimitAccountSwitcher({
          agentRuns: deps.agentRuns,
          runId,
          switchSubscriptionAccountOnLimit: deps.switchSubscriptionAccountOnLimit,
        }),
        providerId,
        pinnedAccount: chatPinned,
      })
      : undefined

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
        plans: deps.plans, planOutcomes: deps.planOutcomes, tasks: deps.tasks,
        agentJobs: deps.agentJobs, agentJobScheduler: deps.agentJobScheduler,
        recordJournal: deps.recordJournal, readJournal: deps.readJournal,
        saveMemory: deps.saveMemory, saveDecision: deps.saveDecision, invalidateMemory: deps.invalidateMemory,
        searchMemories: deps.searchMemories, searchConversations: deps.searchConversations,
        connectors: deps.connectors, agentMode, turnsBudget,
        skillRegistry: deps.skillRegistry, getSecretForDelegate: deps.getSecret, costGuard,
        resolveSubscriptionAccount: deps.resolveSubscriptionAccount,
        providerId, model,
        fallbackOpts,
        mcpClientRef: deps.mcpClient, appendAuditFn: auditFn, trackToolPatternFn: deps.trackToolPattern,
        parentChatId: chatId ? Number(chatId) : null,
        subSessions: deps.subSessions, sessionTodos: deps.sessionTodos,
        agentRuns: deps.agentRuns, runId, verifications: deps.verifications,
        toolsAllow: outcomeToolsAllow ?? overrides?.toolsAllow ?? null,
        recipe: overrides?.recipe,
        outcome,
        pipelineRuns: deps.pipelineRuns,
        revisePlanId,
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
      void runPlainConversation({
        sender: taggedSender,
        sendId,
        provider,
        projectPath,
        messages: messagesWithSystem,
        signal: ctrl.signal,
        recordJournal: deps.recordJournal,
        costGuard,
        providerId,
        model,
        fallbackOpts,
        agentRuns: deps.agentRuns,
        runId,
      }).finally(cleanup)
    }
    return sendId
  })

  // Управление идущим прогоном (стоп / приостановка / append-context) и резолв
  // pending-подтверждений — самостоятельный модуль (2.1.10-F). abortSend передаётся
  // параметром: его ядро (activeAborts + дренаж pending сессии) остаётся здесь.
  registerAiResolveIpc(ipcMain, abortSend)

  registerAiCountTokensIpc(ipcMain, deps)
}

// Type re-exports for renderer (api.d.ts)
export type { UsageDelta } from '../ai/types'

