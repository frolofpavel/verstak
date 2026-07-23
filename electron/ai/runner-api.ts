// API-путь агентного прогона (распил ai.ts, 1.9.8 #1, срез 4c).
//
// Вынесен ГЛАВНЫЙ agent-loop (runApiConversation ~1300 строк, ЯДРО каждого
// API-send) из монолита ipc/ai.ts. Логика не тронута — только вынос + импорты.
// AgentRunContext/checkpointThrottle/константы турнов ездят вместе (только их
// пользователь). AiDeps — type-only импорт из ipc/ai (стирается, без рантайм-цикла).
// Верификация — харнес tests/ipc/agent-loop.test.ts (18 кейсов).
import type { AiDeps } from '../ipc/ai'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { notifyRunEvent, shouldSendAutoProofReport } from './run-notify'
import { scanText } from './secret-scanner'
import { globalProcessRegistry, type ProcessCompletion, type ProcessRegistry } from './process-registry'
import { createFileTools, createToolsForProject, TOOL_DEFS } from './tools'
import { isWithinKnownRoots } from './path-policy'
import { createProvider, PROVIDERS, type ProviderId } from './registry'
import type { InputAccounting } from '../../shared/contracts/usage'
import type { McpClient } from '../mcp/client'
import { prepareSystemContext } from './compose-system'
import { applyRecipeToSkillPrompt } from './skills/recipe'
import type { RecipeSpec } from './skills/types'
import {
  isMutatingToolName, snapshotVerifyBaseline, isReviewGatePassResult,
  decideReviewGate, buildReviewGateRequiredNudge, REVIEW_GATE_STOP_MESSAGE,
  MAX_REVIEW_GATE_NUDGES, type VerifyRun,
} from './review-gate'
import { systemForProvider, stripCacheBreakpoint } from './compose-prompt'
import { MAX_STEPS_REPORT } from './model-presets'
import { buildCliPrompt, type CliProviderId } from './cli-prompt'
import { createLegacyMemoryProvider } from './memory/provider'
import { buildRunMemorySnapshot, memorySnapshotFingerprint, snapshotPromptMemories } from './memory/run-snapshot'
import { REVIEWER_SYSTEM_PROMPT } from './review-prompt'
import { compactToolHistory, shouldAutoCompact, buildCompactSummaryPrompt, createCompactedHistory, microcompactIfNeeded, formatFocusChain, buildNewTaskContext } from './compact-history'
import { estimateTokens } from './context-limits'
import { withInitialRetry } from './with-retry'
import { classifyProviderError } from './provider-error'
import { createCostGuard } from './cost-guard'
import { SessionAgentCounter } from './delegation-limits'
import type { AgentMode } from './mode-policy'
import { loadPermissionRules } from './permission-rules'
import { hooksEnabled, hooksProjectEnabled, loadHooks, runHooks, type CompiledHooks } from './hooks'
import type { ChatMessage, ToolCall, ToolResult, ChatProvider, Attachment } from './types'
import { lookupHandler, type ToolContext, type TaggedSender as HandlerTaggedSender } from '../ipc/tool-handlers'
// Распил ai.ts (1.9.8 #1): эмиссия прогресса (срез 1) + supplements (срез 2).
import { tagSender, compactProgressText, modelProgressLabel, emitAgentProgress, createModelWaitHeartbeat } from './runner-progress'
import { registerConversationSupplements, unregisterConversationSupplements, pushConversationSupplement, formatConversationSupplement } from './runner-supplements'
import { selectAllowedToolDefs, retriableErrorEvent } from './runner-util'
import { type FallbackOpts, type FallbackAttempt, MAX_FALLBACK_ATTEMPTS, MAX_ACCOUNT_SWITCHES, DEFAULT_AGENT_TURNS, MAX_BUDGET_TURNS, pendingWrites, pendingCommands, pendingPlans, suspendedSends, scopedKey } from './runner-shared'
import { captureToolObservation } from './memory-hooks'
import type { NewDecisionRecord, DecisionRecord } from '../storage/project-brain'
import { trackToolForPatterns, type ToolEvent } from './procedural-memory'
import { pickReviewProvider, buildCrossVerifyPrompt, runCrossVerify, getConfiguredApiProviders, type TurnChange } from './cross-verify'
import { shouldFallback, getNextFallback, classifyFallbackReason } from './smart-fallback'
import { classifyRouteReason, cooldownReasonForLimitKind } from './route-policy'
import { detectSubscriptionLimit } from './subscription-limits'
import { resolveToolMode, isCoaxableProvider, JSON_TOOL_INSTRUCTION, IGNORED_TOOLS_NUDGE, claimsCompletedAction } from './tool-mode'
import { estimateComplexity, recommendModel, complexityLabel, detectCliWorthiness } from './smart-router'
import { type ExitReason, callSignature, detectVerifyScriptsForHint, writeSessionJournal } from './session-journal'
import {
  AGENT_RUN_TIMEOUT_SETTING_KEY,
  abortAgentRunForTimeout,
  exitReasonToAgentRunStatus,
  isAgentRunTimeoutAbort,
  resolveAgentRunTimeoutPolicy,
  shouldFireRunTimeout,
} from './run-lifecycle'
import { parseResumeCheckpoint, canReplayCheckpoint } from './resume-checkpoint'
import { decideCheckpointSave, type CheckpointThrottleState } from './checkpoint-throttle'
import { intensityConfig, parseIntensity } from './intensity'
import { isTypeScriptFile, shouldAutoDiagnose, formatDiagnosticHint } from './diagnostic-loop'
import { isLspDiagnosableFile, formatLspDiagnosticHint } from './lang-servers'
import { runLspDiagnostics } from './lsp-diagnose'
import { ALLOWED_WRITE_ROOTS_KEY, parseAllowedWriteRoots } from './allowed-write-roots'
import { join as joinPath } from 'node:path'
import type { AgentRuns, AgentRunOwner } from '../storage/agent-runs'
import { pickResumeGuardTool } from '../storage/agent-runs'
import { usageHash } from '../storage/agent-run-usage'
import { expandOfficeAttachments } from './attachment-text'
import { logRuntime, logRuntimeError } from '../runtime-log'

// Local TaggedSender alias — shape-compatible with tool-handlers.TaggedSender.
type TaggedSender = HandlerTaggedSender
// 1.9.7 #7: троттлинг crash-resume чекпойнтов (только API-путь).
const checkpointThrottle = new Map<string, CheckpointThrottleState>()

/**
 * Full agentic loop with file tools + diff confirmation + command sandbox.
 * Only providers that support function calling go through here.
 */
const FOCUS_REINJECT_EVERY = 8  // ось 3 C: каждые N ходов реинъект незакрытого todo-листа (анти-дрейф)

// Вынесены из ipc/ai.ts вместе с runApiConversation (только его потребители, срез 4c).
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
  /** EF-R1 Б2: единый resolver аккаунта для delegate_task внутри агентного цикла. */
  resolveSubscriptionAccount?: AiDeps['resolveSubscriptionAccount']
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
  /** Дефект 2a: сколько corrective-nudge уже потрачено за ПРОГОН (не за кадр).
   *  Рекурсивные кадры (JSON-эскалация, provider-fallback, account-switch) несут
   *  накопленный счётчик сюда, иначе frame-local бюджет обнулялся в новом кадре и
   *  nudge выдавался повторно (симптом «Задача выполнена.» ×N). */
  nudgeBudgetUsed?: number
}

export async function runApiConversation(ctx: AgentRunContext): Promise<void> {
  const {
    sender, sendId, provider, tools, projectPath, initialMessages, signal,
    recordWrite, recordPlan, recordJournal, readJournal, saveMemory, saveDecision, invalidateMemory,
    searchMemories, searchConversations, connectors, agentMode,
    turnsBudget = DEFAULT_AGENT_TURNS, skillRegistry, getSecretForDelegate, costGuard,
    resolveSubscriptionAccount,
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
  // Дефект 2a: инициализируем из ctx — бюджет run-scoped, а не frame-local (иначе
  // рекурсивный кадр эскалации переоткрывал nudge → «Задача выполнена.» ×N).
  let plainReplyNudges = ctx.nudgeBudgetUsed ?? 0
  const MAX_PLAIN_NUDGES = 1
  const coaxableProvider = isCoaxableProvider(providerId)
  // Дефект 1 (+ follow-up 18.07): гейт corrective-nudge.
  //  · recipe = структурная агентная задача → проза без действия это провал, nudge безусловен.
  //  · Режим-агентность (accept-edits/auto/bypass) — это ОКРУЖЕНИЕ прогона, а НЕ сигнал «это
  //    агентная задача»: per-chat режим часто не задан → фолбэк на глобальный agent_mode
  //    (useAgentMode), а Павел повседневно живёт в 'auto'. Поэтому «расскажи, как ты работаешь»
  //    здесь — разговорный запрос, и безусловный nudge давал ложные срабатывания («цирк»
  //    из повторов). В этих режимах nudge стреляет ТОЛЬКО когда ответ ПРЕТЕНДУЕТ на выполненное
  //    действие без вызова инструмента (claimsCompletedAction — ровно симптом DeepSeek-цикла);
  //    чистая проза (объяснение/шаги/вопрос/оффер) — не трогаем.
  //  · 'ask' (дефолт) и 'plan' (проза-план — законный финал) остаются разговорными всегда.
  //  Дискриминатор по ВЫХЛОПУ модели, не по словам юзера (их подбором обойти нельзя).
  //  runAgentMode мутабельный (approve плана меняет режим) — читаем на момент проверки.
  const shouldPlainNudge = (replyText: string): boolean => {
    if (ctx.recipe != null) return true
    if (runAgentMode === 'accept-edits' || runAgentMode === 'auto' || runAgentMode === 'bypass')
      return claimsCompletedAction(replyText)
    return false
  }
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
    if (coaxableProvider && projectPath && toolCallCount === 0 && plainReplyNudges < MAX_PLAIN_NUDGES && text.trim() && shouldPlainNudge(text)) {
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
  // 2.0.8-F: +cacheWriteTokens/inputAccounting — накапливаем для persistence прогона
  // (persistUsage при finalize). inputAccounting = фактического провайдера (последний usage-event).
  const sessionUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; inputAccounting: InputAccounting | undefined } = {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, inputAccounting: undefined
  }
  // 2.0.8-F: сигнатура набора инструментов прогона (для cache-диагностики), фиксируется на
  // первом туре с инструментами; null = инструментов не было (нечего сравнивать).
  let toolsSignature: string | null = null
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
  // 2.0.8-D: структурное событие смены маршрута (инвариант 8) — пользователь по Timeline
  // объясняет КАЖДУЮ автоматическую смену. reason — код classifyRouteReason (единый со
  // спекой route-policy). Плюс запись в agent_run_events (kind='route') без миграции.
  // 2.0.8-D: структурное событие смены маршрута (инвариант 8) — пользователь по Timeline
  // объясняет КАЖДУЮ автоматическую смену. reason — код classifyRouteReason (единый со
  // спекой route-policy). Плюс запись в agent_run_events (kind='route') без миграции.
  // 2.1.3-CD: extras — labels аккаунтов (безопасные, не id) и resetAt (null = неизвестно);
  // persisted ref — JSON, чтобы Timeline/Proof читали evidence без разбора свободного текста.
  // Текстовая info-пилюля убрана: renderer строит пилюлю из структурного события (без дубля).
  const emitRouteChanged = (
    action: 'rotate-account' | 'model-fallback' | 'refresh-auth',
    err: unknown,
    actual: { providerId: string; model: string },
    attempt: number,
    extras?: { resetAt?: number | null; accounts?: { fromLabel: string | null; toLabel: string | null } | null },
  ): void => {
    const reason = classifyRouteReason(err)
    const requested = { providerId: providerId ?? '', model: model ?? '' }
    const resetAt = extras?.resetAt ?? null
    const accounts = extras?.accounts ?? null
    sender.send('ai:event', { id: sendId, event: { type: 'route-changed', action, reason, attempt, requested, actual, resetAt, accounts } })
    if (agentRuns && runId) {
      try {
        const acctText = accounts ? ` · аккаунт: ${accounts.fromLabel ?? '?'} → ${accounts.toLabel ?? '?'}` : ''
        const resetText = resetAt != null ? ` · до ${new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }` : ''
        agentRuns.appendEvent(runId, 'route', {
          label: action,
          detail: `${requested.providerId}/${requested.model} → ${actual.providerId}/${actual.model} · reason=${reason} · attempt=${attempt}${acctText}${resetText}`,
          ref: JSON.stringify({
            kind: action, reason, attempt, requested, actual,
            fromAccountLabel: accounts?.fromLabel ?? null,
            toAccountLabel: accounts?.toLabel ?? null,
            resetAt,
          }),
          status: 'ok',
        })
      } catch { /* best-effort */ }
    }
  }

  // EF-R2 Б2: единая точка создания attempt — предпочтительно getNextAttempt (несёт
  // accountId попытки); legacy getNextProvider → accountId=undefined («не трогать»).
  const mkAttempt = (id: ProviderId): { provider: ChatProvider; accountId: number | null | undefined } | null => {
    const viaAttempt = fallbackOpts?.getNextAttempt?.(id)
    if (viaAttempt) return viaAttempt
    const p = fallbackOpts?.getNextProvider?.(id)
    return p ? { provider: p, accountId: undefined } : null
  }
  // Lineage аккаунта на handoff: attempt с известным accountId (вкл. null = очистить)
  // фиксируется в durable run — success/cooldown уйдут фактическому аккаунту попытки.
  const applyAttemptAccount = (accountId: number | null | undefined): void => {
    if (accountId === undefined || !agentRuns || !runId) return
    try { agentRuns.updateActualAccount(runId, accountId) } catch { /* best-effort */ }
  }

  const attemptProviderFallback = (err: unknown, force = false): Promise<void> | null => {
    // 2.0.8-D2: pinned-чат — авто-смена провайдера запрещена (увела бы с закреплённого аккаунта).
    if (fallbackOpts?.pinnedAccount) return null
    if (!(fallbackOpts && providerId && (fallbackOpts.triedProviders.size - 1) < MAX_FALLBACK_ATTEMPTS)) return null
    fallbackOpts.triedProviders.add(providerId)
    if (!force && !shouldFallback(err)) return null
    const nextId = getNextFallback(providerId, fallbackOpts.triedProviders, fallbackOpts.configuredProviders)
    const attempt = nextId ? mkAttempt(nextId) : null
    if (!attempt || !nextId) return null
    const nextProvider = attempt.provider
    console.log(`[fallback] ${providerId} failed: ${err instanceof Error ? err.message : String(err)}. Trying ${nextId}...`)
    fallbackOpts.triedProviders.add(nextId)
    // attempt считаем ПОСЛЕ add(nextId) — паритет с runner-plain (ревью #4): size включает
    // новый провайдер → порядковый номер маршрута совпадает по транспортам API↔CLI.
    const nextModelForEvent = fallbackOpts.getProviderModel(nextId) ?? model ?? ''
    emitRouteChanged('model-fallback', err, { providerId: nextId, model: nextModelForEvent }, fallbackOpts.triedProviders.size)
    const fallbackTools = createToolsForProject(projectPath, signal, {
      allowedWriteRoots: parseAllowedWriteRoots(getSecretForDelegate?.(ALLOWED_WRITE_ROOTS_KEY))
    })
    const nextModel = fallbackOpts.getProviderModel(nextId) ?? model
    // 2.0.7-F: actual провайдер/модель прогона теперь = запасной (requested_* остаётся
    // исходным). Иначе agent_run.provider_id показывал бы упавшего провайдера, а «actual
    // vs requested» врал бы именно в сценарии fallback.
    if (agentRuns && runId) {
      try { agentRuns.updateActual(runId, nextId, nextModel ?? '') } catch { /* best-effort */ }
    }
    // EF-R2 Б2: lineage аккаунта — кросс-провайдерный handoff фиксирует аккаунт нового
    // провайдера (или очищает до null, если у него нет managed-аккаунта).
    applyAttemptAccount(attempt.accountId)
    handedOff = true
    return runApiConversation({ ...ctx, isFallbackFrame: true, provider: nextProvider, tools: fallbackTools, initialMessages: currentMessages, providerId: nextId, model: nextModel, nudgeBudgetUsed: plainReplyNudges })
  }

  // 1.9.4: подписочный лимит активного аккаунта → переключаемся на ДРУГОЙ аккаунт пула
  // того же провайдера (пересоздаём тот же провайдер — он резолвит новый активный аккаунт),
  // не теряя накопленную историю. Пул исчерпан → null (дальше обычный provider-fallback).
  const attemptAccountSwitch = (err: unknown): Promise<void> | null => {
    // 2.0.8-D2: pinned-чат — ротация аккаунта на лимите запрещена (инвариант 1).
    if (!fallbackOpts || !providerId || fallbackOpts.pinnedAccount) return null
    // Ревью-фикс: bounded — иначе resetEta=null + пул ≥2 зацикливается навсегда.
    if ((fallbackOpts.accountSwitchCount ?? 0) >= MAX_ACCOUNT_SWITCHES) return null
    const hit = detectSubscriptionLimit(err)
    if (!hit.limited) return null
    const sw = fallbackOpts.switchAccountOnLimit?.(providerId, hit.resetEta, cooldownReasonForLimitKind(hit.kind))
    if (!sw?.switched) return null
    fallbackOpts.accountSwitchCount = (fallbackOpts.accountSwitchCount ?? 0) + 1
    const freshAttempt = mkAttempt(providerId) // тот же id → новый активный аккаунт
    if (!freshAttempt) return null
    const freshProvider = freshAttempt.provider
    // EF-R2 Б2: ротация фиксирует новый аккаунт в run (success уйдёт ему, а не упавшему).
    applyAttemptAccount(freshAttempt.accountId)
    // Ротация аккаунта: провайдер/модель те же, меняется аккаунт. CD: labels аккаунтов
    // и resetAt идут в событие (Timeline «A → B · до HH:MM»); id аккаунтов не отдаём.
    emitRouteChanged('rotate-account', err, { providerId, model: model ?? '' }, fallbackOpts.accountSwitchCount, {
      resetAt: hit.resetEta ?? null,
      accounts: { fromLabel: sw.fromLabel ?? null, toLabel: sw.toLabel ?? null },
    })
    handedOff = true
    const acctTools = createToolsForProject(projectPath, signal, {
      allowedWriteRoots: parseAllowedWriteRoots(getSecretForDelegate?.(ALLOWED_WRITE_ROOTS_KEY))
    })
    return runApiConversation({ ...ctx, isFallbackFrame: true, provider: freshProvider, tools: acctTools, initialMessages: currentMessages, providerId, model, nudgeBudgetUsed: plainReplyNudges })
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
    return runApiConversation({ ...ctx, isFallbackFrame: true, forceToolMode: 'json', tools: jsonTools, initialMessages: currentMessages, nudgeBudgetUsed: plainReplyNudges })
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
    // 2.0.8-F cache-диагностика: набор инструментов входит в кэшируемый префикс, поэтому его
    // дрейф инвалидирует кэш. Фиксируем сигнатуру ОДИН раз — на первом туре с инструментами
    // (последний тур намеренно без них, он не показателен).
    if (toolsSignature == null && allToolDefs.length > 0) {
      toolsSignature = allToolDefs.map(t => t.name).sort().join(',')
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
      } else if (event.type === 'info') {
        // Дефект 3 (vision per-provider): провайдер сам объявляет честную деградацию —
        // напр. openai-compat без vision: «X не принимает изображения — вложение пропущено».
        // Форвардим как обычный info-ивент, иначе уведомление молча терялось (ветки цикла
        // его не обрабатывали) и деградация была невидима юзеру (жалоба Павла на скринах zai).
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
        // 2.0.8-F: cache-write + accounting фактического провайдера для persistence.
        sessionUsage.cacheWriteTokens += event.usage.cacheWriteTokens ?? event.usage.cacheCreationInputTokens ?? 0
        if (event.usage.inputAccounting) sessionUsage.inputAccounting = event.usage.inputAccounting
        sender.send('ai:event', { id: sendId, event })
        // Cost guard в API path — на каждый usage event считаем total,
        // если превышен лимит → abort всего turn-loop'a.
        if (costGuard && providerId) {
          const check = costGuard.recordAndCheck(
            providerId, model ?? '', event.usage.inputTokens ?? null,
            event.usage.outputTokens ?? null, event.usage.cacheReadTokens ?? event.usage.cachedInputTokens ?? null,
            event.usage.inputAccounting, // 2.0.8-E: exclusive (Claude) → billable НЕ вычитает cached (фикс B)
            event.usage.cacheWriteTokens ?? event.usage.cacheCreationInputTokens ?? null,
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
      // EF-R1 Б2: единый resolver аккаунта для delegate_task (sub-agent не обходит pre-flight).
      resolveSubscriptionAccount,
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
              costGuard.recordAndCheck(providerId, model ?? '', ev.usage.inputTokens ?? null, ev.usage.outputTokens ?? null, ev.usage.cacheReadTokens ?? ev.usage.cachedInputTokens ?? null, ev.usage.inputAccounting, ev.usage.cacheWriteTokens ?? ev.usage.cacheCreationInputTokens ?? null)
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
        // 2.0.8-F: persistence usage прогона (одна строка, идемпотентно по run_id).
        // BEST-EFFORT: сбой персистенса НЕ роняет прогон. Пишем только при реальном usage.
        if (providerId && (sessionUsage.inputTokens || sessionUsage.outputTokens || sessionUsage.cachedInputTokens)) {
          try {
            // Cache-диагностика: хешируем ЗДЕСЬ — текст промпта не покидает runner (каветат #3),
            // в storage уходит только 16-символьный отпечаток для сравнения «то же / другое».
            const systemText = initialMessages.find(m => m.role === 'system')?.content
            agentRuns.persistUsage({
              runId, providerId, model: model ?? '', transport: PROVIDERS[providerId]?.transport ?? null,
              inputTokens: sessionUsage.inputTokens, outputTokens: sessionUsage.outputTokens,
              cacheReadTokens: sessionUsage.cachedInputTokens, cacheWriteTokens: sessionUsage.cacheWriteTokens,
              inputAccounting: sessionUsage.inputAccounting,
              systemPromptHash: systemText ? usageHash(systemText) : null,
              toolsHash: toolsSignature ? usageHash(toolsSignature) : null
            })
          } catch { /* best-effort: персистенс не роняет финализацию */ }
        }
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

