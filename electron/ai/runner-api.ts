// API-путь агентного прогона (распил ai.ts, 1.9.8 #1, срез 4c).
//
// Вынесен ГЛАВНЫЙ agent-loop (runApiConversation ~1300 строк, ЯДРО каждого
// API-send) из монолита ipc/ai.ts. Логика не тронута — только вынос + импорты.
// AgentRunContext/checkpointThrottle/константы турнов ездят вместе (только их
// пользователь). AiDeps — type-only импорт из ipc/ai (стирается, без рантайм-цикла).
// Верификация — харнес tests/ipc/agent-loop.test.ts (18 кейсов).
import type { AiDeps } from '../ipc/ai'
import { globalProcessRegistry, type ProcessCompletion, type ProcessRegistry } from './process-registry'
import { createFileTools, createToolsForProject, TOOL_DEFS } from './tools'
import { commonReadDir } from './artifacts'
import type { ProviderId } from './registry'
import type { McpClient } from '../mcp/client'
import type { RecipeSpec } from './skills/types'
import {
  isMutatingToolName, snapshotVerifyBaseline,
  decideReviewGate, buildReviewGateRequiredNudge, REVIEW_GATE_STOP_MESSAGE,
  MAX_REVIEW_GATE_NUDGES, type VerifyRun,
} from './review-gate'
import { MAX_STEPS_REPORT } from './model-presets'
import { compactToolHistory, shouldAutoCompact, buildCompactSummaryPrompt, createCompactedHistory, microcompactIfNeeded, formatFocusChain, firstOpenFocusItem, buildNewTaskContext } from './compact-history'
import { formatStepLine } from './step-log'
import { createTextCoalescer } from './stream-coalescer'
import { shouldReinjectFocus } from './focus-chain-policy'
import {
  MAX_STRATEGY_NUDGES, buildStrategyChangeHint, createProgressState, detectStagnation, recordTurn, stagnationStopNote,
} from './progress'
import {
  decideCompletionGate, isVerificationToolCall, buildCompletionGateNudge, unverifiedWorkNote, verifiedWorkNote,
} from './completion-gate'
import { detectVerifyScriptsForHint } from './session-journal'
import { estimateTokens } from './context-limits'
import { withInitialRetry } from './with-retry'
import { classifyProviderError } from './provider-error'
import { createCostGuard } from './cost-guard'
import { SessionAgentCounter } from './delegation-limits'
import type { AgentMode } from './mode-policy'
import { loadPermissionRules } from './permission-rules'
import { hooksEnabled, hooksProjectEnabled, loadHooks, runHooks, type CompiledHooks } from './hooks'
import type { ChatMessage, ToolCall, ToolResult, ChatProvider, Attachment } from './types'
import { type ToolContext, type TaggedSender as HandlerTaggedSender } from '../ipc/tool-handlers'
// Распил ai.ts (1.9.8 #1): эмиссия прогресса (срез 1) + supplements (срез 2).
import { compactProgressText, modelProgressLabel, emitAgentProgress, createModelWaitHeartbeat } from './runner-progress'
import { registerConversationSupplements, unregisterConversationSupplements, formatConversationSupplement } from './runner-supplements'
import { selectAllowedToolDefs, resolveToolsAllowSet, retriableErrorEvent } from './runner-util'
import { type FallbackOpts, DEFAULT_AGENT_TURNS, MAX_BUDGET_TURNS, decideAutoContinue, buildGoalCheckNote, pendingWrites, pendingCommands, pendingPlans, scopedKey } from './runner-shared'
import { captureToolObservation, isAutoCaptureEnabled } from './memory-hooks'
import type { ToolEvent } from './procedural-memory'
import { pickReviewProvider, buildCrossVerifyPrompt, runCrossVerify, getConfiguredApiProviders, type TurnChange } from './cross-verify'
import { classifyFallbackReason } from './smart-fallback'
import { classifyRouteReason } from './route-policy'
import { resolveToolMode, isCoaxableProvider, JSON_TOOL_INSTRUCTION, IGNORED_TOOLS_NUDGE, claimsCompletedAction } from './tool-mode'
import { type ExitReason, callSignature } from './session-journal'
import {
  createObservationState, hasNoArgs, shouldBlockArgless, recordObservation,
  changesObservation, noteContextChange,
} from './loop-detect'
import { detectRunOutcome } from '../../shared/contracts/run-outcome'
import {
  isAgentRunTimeoutAbort,
} from './run-lifecycle'
import { decideCheckpointSave, type CheckpointThrottleState } from './checkpoint-throttle'
import { ALLOWED_WRITE_ROOTS_KEY, parseAllowedWriteRoots } from './allowed-write-roots'
import type { AgentRuns } from '../storage/agent-runs'
import { pickResumeGuardTool } from '../storage/agent-runs'
import { logRuntime, logRuntimeError } from '../runtime-log'
import { finalizeApiRun, type RunnerSessionUsage } from './runner-finalize'
import { createApiFallbackController } from './runner-attempt'
import { dispatchToolTurn } from './runner-tool-turn'
import { collectToolTurnOutcome, reviewGatePassedInTurn } from './runner-tool-outcome'
import { buildTurnVerificationHint } from './runner-verification'
import { summarizeMaterials, formatMaterialsLine, type ReadOutcome } from './materials-summary'

// Local TaggedSender alias — shape-compatible with tool-handlers.TaggedSender.
type TaggedSender = HandlerTaggedSender

/**
 * VSK-PRODUCT-A1 3b: набор материалов прогона + источник. Строится на старте send'а
 * (ipc/ai.ts), где виден конвейер вложений и открытая папка. Для 'folder' исходы
 * трекаются read-вызовами ЗДЕСЬ; для 'attachments' — предвычислены (attachmentOutcomes),
 * read-вызовы для набора игнорируются (иначе сводка соврала бы «не открывал» на
 * прочитанных моделью материалах — главная ошибка этого куска).
 */
export interface MaterialsRunContext {
  source: 'attachments' | 'folder'
  /** База для разрешения относительных read-путей (корень прогона). */
  base: string
  /** |M| — набор материалов (вложения — имена; папка — абсолютные пути). */
  items: string[]
  /** Только 'attachments': исход конвейера по каждому вложению. */
  attachmentOutcomes?: ReadOutcome[]
}

/** Инструменты чтения, чьи исходы попадают в набор материалов папки. */
const MATERIAL_READ_TOOLS = new Set(['read_file', 'read_document', 'read_spreadsheet', 'read_pdf'])

/**
 * Давать ли модели spawn_task_session. Только КОРНЮ (не дочерней сессии) и только при
 * включённом оркестраторе. Гард глубины (задача C, 08.08): вынесенная задача не заводит
 * внучек — иначе дерево видимых чатов, которых человек не создавал, растёт без предела.
 */
export function offersSpawnTaskSession(orchestratorDefaultOn: boolean, isChildSession: boolean): boolean {
  return orchestratorDefaultOn && !isChildSession
}
// 1.9.7 #7: троттлинг crash-resume чекпойнтов (только API-путь).
const checkpointThrottle = new Map<string, CheckpointThrottleState>()

/**
 * Full agentic loop with file tools + diff confirmation + command sandbox.
 * Only providers that support function calling go through here.
 */
// V2-1: правило реинжекта Focus Chain живёт в ai/focus-chain-policy.ts.
// Прежняя константа здесь равнялась DEFAULT_AGENT_TURNS (8) и сравнивалась по
// модулю с номером хода — при бюджете 8 (turn ∈ 0..7) не срабатывала НИ РАЗУ.

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
  recordPlan: ToolContext['recordPlan']
  getPlan?: ToolContext['getPlan']
  plans?: ToolContext['plans']
  tasks?: ToolContext['tasks']
  planOutcomes?: ToolContext['planOutcomes']
  agentJobs?: ToolContext['agentJobs']
  agentJobScheduler?: ToolContext['agentJobScheduler']
  /** C1 (P5): фасад расписания — только headless-хост. */
  scheduledJobs?: ToolContext['scheduledJobs']
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
  /** V2-2: разрешить прогону растить бюджет самому, пока есть продвижение.
   *  Разрешение ЯВНОЕ (по умолчанию выключено): этот runner зовут не только из
   *  чата, но и из пайплайнов, делегирования и спавн-сессий, где бюджет — часть
   *  условия задачи. Включает тот, кто знает, что бюджет никто не назначал. */
  autoContinueTurns?: boolean
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
  /** Этот прогон идёт в ДОЧЕРНЕЙ (вынесенной спавном) сессии — у её чата задан
   *  parent_chat_id. Гард глубины: такой сессии НЕ даём spawn_task_session (внучек нет).
   *  Считает main из chat_sessions; НЕ путать с parentChatId (= текущий chatId прогона). */
  isChildSession?: boolean
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
  outcome?: ToolContext['outcome']
  pipelineRuns?: ToolContext['pipelineRuns']
  /** §10 хвост: план, который этот прогон дорабатывает (см. ToolContext). */
  revisePlanId?: ToolContext['revisePlanId']
  /** VSK-PRODUCT-A1 3b: набор материалов прогона + источник. null → нечего сводить. */
  materials?: MaterialsRunContext | null
  /** Этап 1а headless: unattended-прогон — коннекторы только на чтение (op-политика
   *  connector-readonly.ts в handler'е). Десктопный ai:send поле не передаёт (undefined). */
  readOnlyConnectors?: boolean
  /** Этап 1а headless: куда класть артефакты с save_to='downloads' — на сервере
   *  homedir сервис-юзера не годится. undefined → прежний defaultDownloadsDir(). */
  artifactsDownloadsDir?: string
}

export async function runApiConversation(ctx: AgentRunContext): Promise<void> {
  const {
    sender: rawSender, sendId, provider, tools, projectPath, initialMessages, signal,
    recordWrite, recordPlan, getPlan, plans, planOutcomes, tasks, agentJobs, agentJobScheduler, scheduledJobs, recordJournal, readJournal, saveMemory, saveDecision, invalidateMemory,
    searchMemories, searchConversations, connectors, agentMode,
    turnsBudget = DEFAULT_AGENT_TURNS, autoContinueTurns, skillRegistry, getSecretForDelegate, costGuard,
    resolveSubscriptionAccount,
    providerId, model, fallbackOpts, mcpClientRef, appendAuditFn, trackToolPatternFn,
    parentChatId, isChildSession, subSessions, sessionTodos, agentRuns, runId, verifications, toolsAllow,
    processRegistry = globalProcessRegistry, outcome, pipelineRuns, revisePlanId,
    isFallbackFrame,
  } = ctx
  // V2 ось B (волна 2.6.0): текстовые дельты склеиваются окном ~30 мс. Обёртка
  // стоит на САМОМ sender, а не расставлена по веткам цикла, и это главное в
  // решении: порядок событий тогда гарантирован КОНСТРУКЦИЕЙ, а не дисциплиной
  // вызовов. Любое не-текстовое событие (tool-call, usage, error, done) сначала
  // сбрасывает накопленный текст и только потом уходит само — иначе ответ модели
  // приезжал бы после инструмента, и лента врала бы о ходе работы.
  //
  // Первый чанк после паузы уходит НЕМЕДЛЕННО (leading edge в createTextCoalescer):
  // «время до первого символа» — главная метрика волны, платить за плавность
  // задержкой первого символа было бы разменом не в ту сторону.
  const textStream = createTextCoalescer(text => {
    rawSender.send('ai:event', { id: sendId, event: { type: 'text', text } })
  })
  const sender: HandlerTaggedSender = {
    send: (channel, payload) => {
      if (channel === 'ai:event' && payload.id === sendId) {
        const ev = payload.event as { type?: string; text?: string } | undefined
        if (ev?.type === 'text' && typeof ev.text === 'string') { textStream.push(ev.text); return }
        textStream.flush()
      }
      rawSender.send(channel, payload)
    },
    exec: (code: string) => rawSender.exec(code),
  }
  // VSK-PRODUCT-A1 3b: захватываем ДО петли — внутри неё `ctx` затеняется ToolContext.
  const materialsCtx = ctx.materials ?? null
  // Этап 1а headless: те же поля, тот же захват до петли (затенение ctx).
  const readOnlyConnectorsCtx = ctx.readOnlyConnectors
  const artifactsDownloadsDirCtx = ctx.artifactsDownloadsDir
  // Исходы read-вызовов набора «папка» за прогон (для 'attachments' не используются —
  // там исход из конвейера). Несопоставленный успех уйдёт в «вне набора», не в тревогу.
  const materialReadOutcomes: ReadOutcome[] = []
  // ЗАДАЧА A вариант (i): пути файлов, реально прочитанных за прогон (ЛЮБОЙ источник, не
  // только папка-материалы). Из них generate_docx alongside выводит каталог назначения
  // «рядом с материалами» — по факту прочитанного, а не по толкованию текста задачи.
  const readPaths: string[] = []
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
  // tools_allow enforcement — СТАБИЛЬНЫЙ allow-набор считаем ОДИН раз на прогон (не
  // per-turn) тем же предикатом, что фильтрует предлагаемый список (resolveToolsAllowSet):
  // список инструментов — меню, а не граница; гейт диспетчера (dispatchToolTurn) блокирует
  // вызов вне набора. Универсум = base TOOL_DEFS + mcp (стабильны в пределах прогона).
  const mcpNamesForAllow = mcpClientRef ? mcpClientRef.getAllTools().map(t => t.name) : []
  const toolsAllowResolution = resolveToolsAllowSet(toolsAllow, TOOL_DEFS.map(d => d.name), mcpNamesForAllow)
  const allowedToolNames = toolsAllowResolution.allowed
  // Fail-open ОСТАВЛЯЕТ СЛЕД (штаб): сломанный tools_allow → ограничение НЕ применяется,
  // но это обязано быть ВИДНО в журнале прогона — иначе опечатка тихо снимает защиту, и
  // «read-only скилл» молча станет полным. Тот же принцип, что «фолбэк без следа».
  if (toolsAllowResolution.unmatchedFailOpen) {
    recordJournal(
      projectPath,
      'note',
      'tools_allow скилла не разобран — ограничение инструментов НЕ применено',
      `ни одно имя из tools_allow=[${(toolsAllow ?? []).join(', ')}] не совпало с инструментом (проверь имена в скилле)`
    )
  }
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
  let outcomeContractSubmitted = false
  let outcomeRefineNudges = 0
  let stepOutcomeReported = false
  let stepOutcomeNudges = 0
  const executedChecks = new Map<string, number>()
  const enforceOutcomeRefine = (): 'pass' | 'retry' | 'stop' => {
    if (outcome?.phase !== 'refine' || outcomeContractSubmitted) return 'pass'
    if (outcomeRefineNudges < 1) {
      outcomeRefineNudges++
      currentMessages.push({
        role: 'user',
        content: 'Outcome refine не завершён: вызови submit_task_contract с конкретной целью, criteria, границами, repoEvidence и честными blockingQuestions. Не отвечай финалом без tool.',
      })
      sender.send('ai:event', {
        id: sendId,
        event: { type: 'tool-blocked', callId: 'outcome-refine-nudge', name: 'submit_task_contract', reason: 'Task Contract обязателен перед завершением refine.' },
      })
      return 'retry'
    }
    return 'stop'
  }
  const enforceStepOutcome = (): 'pass' | 'retry' | 'stop' => {
    if (outcome?.phase !== 'execute-step' || stepOutcomeReported) return 'pass'
    if (stepOutcomeNudges < 1) {
      stepOutcomeNudges++
      currentMessages.push({
        role: 'user',
        content: 'Execute-step не завершён: вызови report_step_outcome. Укажи фактические writes, проверки, evidence и честный status. Финальный текст без outcome запрещён.',
      })
      sender.send('ai:event', {
        id: sendId,
        event: { type: 'tool-blocked', callId: 'step-outcome-nudge', name: 'report_step_outcome', reason: 'Step Outcome обязателен перед завершением execute-step.' },
      })
      return 'retry'
    }
    return 'stop'
  }
  const enforceOutcomeFinal = (): 'pass' | 'retry' | 'stop' => {
    const refine = enforceOutcomeRefine()
    return refine === 'pass' ? enforceStepOutcome() : refine
  }
  // Loop detection: per-signature occurrence counter across the whole agent
  // loop. We block when a single tool+args combination has been called 3 times
  // (the threshold the UI tells the user). Tracking via Map avoids the
  // sliding-window eviction problem of the previous flat-array approach.
  const signatureCounts = new Map<string, number>()
  // Д4: наблюдения безаргументных инструментов — их подпись строится не из
  // аргументов (которых нет), а из того, что вызов увидел. См. loop-detect.ts.
  const observationState = createObservationState()
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
  const sessionUsage: RunnerSessionUsage = {
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

  const fallbackController = createApiFallbackController({
    providerId,
    model,
    fallbackOpts,
    agentRuns,
    runId,
    currentMessages,
    createTools: () =>
      createToolsForProject(projectPath, signal, {
        allowedWriteRoots: parseAllowedWriteRoots(
          getSecretForDelegate?.(ALLOWED_WRITE_ROOTS_KEY)
        ),
      }),
    getNudgeBudgetUsed: () => plainReplyNudges,
    emitRouteChanged,
    onHandedOff: () => {
      handedOff = true
    },
    runFallbackFrame: patch => runApiConversation({ ...ctx, ...patch }),
  })
  const { attemptProviderFallback, attemptAccountSwitch } = fallbackController

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

  // V2-1: состояние реинжекта Focus Chain. Считаем ходы ОТ ПРОШЛОГО реинжекта и
  // помним, была ли между ними компакция (она выбрасывает именно то состояние,
  // ради которого Focus Chain существует).
  let lastFocusReinjectTurn = 0
  let compactedSinceFocusReinject = false

  // V2-3 completion gate: счётчики за ВЕСЬ прогон (не за ход) — «написал и ни разу
  // не проверил» проявляется именно на масштабе прогона. Команды для nudge берём
  // из рецепта, если он есть, иначе из package.json проекта (тот же источник, что
  // у подсказки после записи) — гейт обязан не только требовать, но и подсказывать чем.
  const runVerifyScriptHints: string[] = []
  // V2-4: копилка фактов прогона — из неё выводится и «есть прогресс» (условие
  // автопродолжения бюджета V2-2), и «прогон встал». Один сигнал на обе правки:
  // разные сигналы разъехались бы, и автопродолжение однажды продлило бы застой.
  const progressState = createProgressState()
  let runAcceptedWrites = 0
  let runVerifications = 0
  let completionGateNudges = 0
  // V3: след проверок прогона — ЧТО реально исполнилось и с каким исходом.
  // Собирается из фактических вызовов и их результатов; слова модели («я всё
  // проверил») сюда не попадают и попасть не могут — из них и строится плашка.
  const verificationTrail: Array<{ label: string; ok: boolean }> = []

  /**
   * V2-3: перед финалом требуем доказательство, если были записи и не было проверок.
   * Возвращает 'allow' | 'retry'; исчерпание попыток даёт allow, но помечает прогон
   * как непроверенный — человек это видит, работа за проверенную не выдаётся.
   */
  const enforceCompletionGateBeforeFinal = (): 'allow' | 'retry' => {
    const decision = decideCompletionGate({
      acceptedWrites: runAcceptedWrites,
      verifications: runVerifications,
      nudges: completionGateNudges,
    })
    if (decision === 'retry') {
      completionGateNudges++
      currentMessages.push({ role: 'user', content: buildCompletionGateNudge(runVerifyScriptHints) })
      sender.send('ai:event', {
        id: sendId,
        event: { type: 'tool-blocked', callId: `completion-gate-${completionGateNudges}`, name: 'run_command',
          reason: 'Файлы изменены, но результат не проверен — запусти тесты/тайпчек/сборку.' },
      })
      return 'retry'
    }
    if (decision === 'finish-unverified') {
      // Видимость для человека — само событие: карточка прогона покажет, что
      // работа сдана непроверенной. Отдельного флага не заводим, чтобы в коде не
      // появилось поле, которое пишется и никем не читается.
      sender.send('ai:event', {
        id: sendId,
        event: { type: 'info', message: unverifiedWorkNote(filesTouched.size) },
      })
      return 'allow'
    }
    // V3: положительная половина пары. Тем же каналом, что и нота «не проверено»
    // — человек читает итог одной строкой в ленте, нового UI не заводим (§6).
    // Условие строгое: строка появляется, только если проверки РЕАЛЬНО были;
    // иначе её нет вовсе, и «тихо» по-прежнему значит «нечем хвастаться».
    const note = verifiedWorkNote(verificationTrail, filesTouched.size)
    if (note) sender.send('ai:event', { id: sendId, event: { type: 'info', message: note } })
    return 'allow'
  }

  // V2-2: бюджет прогона — величина ЖИВАЯ. Пока прогон продолжает узнавать новое,
  // он продлевается сам (decideAutoContinue); упирается в стену только тот, кто
  // встал. Потолок MAX_BUDGET_TURNS и явный бюджет человека остаются границами.
  let effectiveTurnsBudget = turnsBudget
  let autoContinues = 0
  // Д7: продление бюджета — единственная точка, где рантайм САМ тратит деньги
  // человека, и до 10.08 оно не знало признака «цель закрыта»: прогон, уже
  // выдавший финальный ответ, молча ехал до потолка. Первый ход каждого
  // продления несёт ноту-гейт (buildGoalCheckNote); решение модели читается
  // структурно — финал без инструментов завершает прогон, вызовы означают
  // осознанное продолжение, о котором сообщается в ленту.
  let pendingGoalCheck = false

  // V2-5: одна строка на шаг в едином формате «шаг · цель · действие · результат ·
  // решение · прогресс». Новой шины нет — строка едет существующим
  // agent_run_events (kind='step'). Именно два последних поля отличают её от
  // прежних событий: без «решения рантайма» и «прогресса» лог остаётся
  // перечислением вызовов и не отвечает на вопрос, где агент буксует.
  let lastTurnProgress: { progressed: boolean; newFacts: number } = { progressed: false, newFacts: 0 }
  const emitStepLine = (turn: number, calls: ToolCall[], decision: string, results?: ToolResult[]): void => {
    if (!agentRuns || !runId) return
    const goal = (sessionTodos && projectPath)
      ? firstOpenFocusItem(sessionTodos.list(projectPath, parentChatId ?? null))
      : null
    const line = formatStepLine({
      step: turn + 1,
      budget: effectiveTurnsBudget,
      goal: goal ?? (typeof originalUserMsg?.content === 'string' ? originalUserMsg.content : null),
      calls: calls.map((call, i) => ({ name: call.name, args: call.args, error: results?.[i]?.error })),
      decision,
      progressed: lastTurnProgress.progressed,
      newFacts: lastTurnProgress.newFacts,
      staleTurns: progressState.staleTurns,
    })
    try { agentRuns.appendEvent(runId, 'step', { detail: line }) } catch { /* журнал шага не критичен */ }
  }

  try {

  turnLoop: for (let turn = 0; turn < effectiveTurnsBudget; turn++) {
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
    // Focus Chain (ось 3 C + V2-1): реинжектим незакрытый todo-лист как system-
    // напоминание — длинная сессия дрейфует, чеклист уезжает из внимания (§5.4).
    // Решение — shouldReinjectFocus: по признаку (незакрытые пункты + ходы С ПРОШЛОГО
    // реинжекта) и сразу после компакции, а не по модулю совпавшей константы.
    if (sessionTodos && projectPath) {
      const focus = formatFocusChain(sessionTodos.list(projectPath, parentChatId ?? null))
      const reinject = shouldReinjectFocus({
        turn,
        lastReinjectTurn: lastFocusReinjectTurn,
        hasOpenItems: Boolean(focus),
        compactedSinceReinject: compactedSinceFocusReinject,
      })
      if (focus && reinject) {
        lastFocusReinjectTurn = turn
        compactedSinceFocusReinject = false
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
    // Аудит M4: tools_allow скилла применяется ЗДЕСЬ — модель видит только
    // разрешённые инструменты (read-only скилл физически не получит write_file/
    // run_command). Фильтруем и стандартные, и MCP (см. selectAllowedToolDefs).
    // v3 Шаг D: max-steps hard-stop (вдохновлено OpenCode). На ПОСЛЕДНЕМ turn'е
    // (сюда доходят только зацикленные прогоны — нормальные финишируют раньше)
    // убираем тулзы и инжектим инструкцию отчёта: модель обязана отчитаться
    // структурой «сделано/не доделано/дальше», а не молча упереться в лимит.
    // V2-2: решение о продлении принимается ДО того, как ход объявлен последним.
    // Иначе порядок был бы вреден: на последнем ходу у модели отбираются
    // инструменты и требуется отчёт «сделано/не доделано», и продление после
    // этого дарило бы прогону ход, потраченный на преждевременное подведение
    // итогов. Продлеваем раньше — последнего хода просто не наступает.
    // Блок стоит ДО снятия компакт-копии messagesForProvider: нота гейта Д7
    // обязана уехать провайдеру ЭТИМ же ходом, а не следующим.
    if (turn === effectiveTurnsBudget - 1) {
      const auto = decideAutoContinue({
        budget: effectiveTurnsBudget,
        allowed: autoContinueTurns === true,
        staleTurns: progressState.staleTurns,
        extensions: autoContinues,
      })
      if (auto.extend) {
        autoContinues++
        effectiveTurnsBudget = auto.nextBudget
        // Д7: продление больше не молчаливое. Первый ход продления несёт гейт
        // «цель закрыта?» — если модель ответит финалом без инструментов, прогон
        // завершится обычным путём toolCalls.length === 0 ниже.
        pendingGoalCheck = true
        currentMessages.push({ role: 'user', content: buildGoalCheckNote() })
        sender.send('ai:event', {
          id: sendId,
          event: { type: 'info', message: `⏸ Бюджет ходов исчерпан — спрашиваю агента, закрыта ли цель. Если ответ уже выдан, прогон остановится; продолжение будет видимым, кнопка Стоп работает (бюджет ${effectiveTurnsBudget}, потолок ${MAX_BUDGET_TURNS}).` },
        })
      }
    }
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
    const isLastTurn = effectiveTurnsBudget > 1 && turn === effectiveTurnsBudget - 1
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
    // Задача 10 (оркестратор): spawn_task_session предлагается модели, пока
    // orchestrator_default не ВЫКЛЮЧЕН явно. Полярность opt-out (!== 'false')
    // совпадает с defaultOn:true в src/lib/runtime-flags.ts — стережёт
    // tests/lib/runtime-flags.test.ts. Дефолт ON — решение Павла; килл-свитч
    // (осознанное 'false') в RuntimeFlagsTab. Триггер — решение МОДЕЛИ по ходу.
    const orchestratorDefaultOn = getSecretForDelegate?.('orchestrator_default') !== 'false'
    // ГАРД ГЛУБИНЫ (задача C, 08.08): spawn_task_session даётся ТОЛЬКО корню. isChildSession —
    // это ПОСТОЯННОЕ свойство чата (у чата в chat_sessions задан parent_chat_id), а НЕ
    // runner-поле parentChatId (оно = текущий chatId у ЛЮБОГО прогона, для скоупа тудушек).
    // Свойство чата, а не флаг отдельной отправки — иначе follow-up в дочернем чате снова
    // получил бы инструмент. Глубина ровно один уровень, внучек вынесенная задача не заводит.
    if (!offersSpawnTaskSession(orchestratorDefaultOn, isChildSession === true)) {
      allToolDefs = allToolDefs.filter(t => t.name !== 'spawn_task_session')
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
          const outcomeGate = enforceOutcomeFinal()
          if (outcomeGate === 'retry') { assistantText = ''; continue turnLoop }
          if (outcomeGate === 'stop') {
            exitReason = 'error'
            sender.send('ai:event', { id: sendId, event: { type: 'error', message: outcome?.phase === 'execute-step' ? 'OUTCOME_STEP_BLOCKED: модель не создала Step Outcome после корректирующей попытки.' : 'OUTCOME_REFINE_BLOCKED: модель не создала Task Contract после корректирующей попытки.' } })
            sender.send('ai:event', { id: sendId, event: { type: 'done' } })
            return
          }
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
          // V3 (11.08), НАЙДЕНО ЗАМЕРОМ, А НЕ ЧТЕНИЕМ: completion gate стоял ТОЛЬКО
          // на втором пути завершения (ниже по циклу), а этот — основной, им
          // заканчивается почти каждый прогон: провайдер шлёт `done` внутри стрима.
          // Значит правило V2-3 «были записи и ни одной проверки → не выпускать
          // финал» на живом пути НЕ РАБОТАЛО, и нота «сделано, не проверено» не
          // появлялась там, где была нужнее всего. Пины стерегли чистую функцию
          // decideCompletionGate, а вызывается ли она — не проверял никто (§3.1:
          // зелёная функция, которую никто не зовёт). Гейт обязан стоять на ОБОИХ
          // выходах, иначе он декоративен.
          if (enforceCompletionGateBeforeFinal() === 'retry') {
            emitStepLine(turn, [], 'требую доказательство: файлы изменены, проверок нет')
            assistantText = ''
            continue turnLoop
          }
          exitReason = 'completed'
          // Д2 + остаток Д1: финал несёт ИСХОД. Это основной путь завершения
          // (провайдер закрыл стрим без вызовов), второй — ниже по циклу; оба
          // считают исход одинаково, потому что правило одно на всех.
          sender.send('ai:event', {
            id: sendId,
            event: { ...event, outcome: detectRunOutcome({ toolCallCount, assistantText: assistantText || lastAssistantText }) },
          })
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
              compactedSinceFocusReinject = true // V2-1: после компакции вернуть Focus Chain
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
      const outcomeGate = enforceOutcomeFinal()
      if (outcomeGate === 'retry') { assistantText = ''; continue }
      if (outcomeGate === 'stop') {
        exitReason = 'error'
        sender.send('ai:event', { id: sendId, event: { type: 'error', message: outcome?.phase === 'execute-step' ? 'OUTCOME_STEP_BLOCKED: модель не создала Step Outcome после корректирующей попытки.' : 'OUTCOME_REFINE_BLOCKED: модель не создала Task Contract после корректирующей попытки.' } })
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
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
      // V2-3 (главная правка): на ОБЫЧНОМ пути финал не выпускается, если были записи
      // и ни одной проверки. Bounded — после лимита попыток прогон закрывается с
      // видимой пометкой «не проверено», а не выдаётся за готовое.
      if (enforceCompletionGateBeforeFinal() === 'retry') {
        emitStepLine(turn, [], 'требую доказательство: файлы изменены, проверок нет')
        assistantText = ''
        continue
      }
      emitStepLine(turn, [], runAcceptedWrites > 0 && runVerifications === 0 ? 'закрываю: сделано, НЕ проверено' : 'готово')
      exitReason = 'completed'
      // Д2 + остаток Д1: ярлык карточки обязан повторять ИСХОД. Считаем его здесь,
      // потому что только тут известны обе части — полный текст ответа (агент сам
      // мог назвать работу неполной) и число сделанных вызовов (нулевая работа не
      // может закрыться как «выполнена», какой бы ни была причина отказа).
      sender.send('ai:event', {
        id: sendId,
        event: { type: 'done', outcome: detectRunOutcome({ toolCallCount, assistantText: lastAssistantText || assistantText }) },
      })
      // Cross-verify: запускаем асинхронно ПОСЛЕ отправки done.
      if (getSecretForDelegate) fireCrossVerify(sender, sendId, sessionChanges, providerId, getSecretForDelegate)
      return
    }

    // Д7: модель ответила на гейт «цель закрыта?» вызовами инструментов —
    // продолжение осознанное, и человек обязан это видеть, а не догадываться
    // по растущим счётчикам.
    if (pendingGoalCheck) {
      pendingGoalCheck = false
      sender.send('ai:event', {
        id: sendId,
        event: { type: 'info', message: `⏩ Агент продолжает: по его решению цель ещё не закрыта (бюджет ${effectiveTurnsBudget}, потолок ${MAX_BUDGET_TURNS}). Если результат вас уже устраивает — нажмите Стоп.` },
      })
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
    //
    // Д4 (приёмка 10.08): у БЕЗАРГУМЕНТНОГО вызова подпись «имя + аргументы»
    // вырождается в константу, поэтому третий browser_snapshot за прогон
    // блокировался всегда — даже после навигации. Такие вызовы различаются тем,
    // что они НАБЛЮДАЮТ (loop-detect.ts): три одинаковых наблюдения подряд
    // ловятся как прежде, изменившаяся страница и любое действие агента счёт
    // обнуляют. Вызовы с аргументами идут прежним путём без изменений.
    const loopHits: ToolCall[] = []
    for (const c of toolCalls) {
      if (hasNoArgs(c.args)) {
        if (shouldBlockArgless(observationState, c.name, LOOP_THRESHOLD)) loopHits.push(c)
        continue
      }
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

    toolCallCount += toolCalls.length  // Manager (Фаза 2): tool_count прогона

    // P1 (Этап 6): снять baseline verify ДО первого мутирующего вызова active recipe.
    if (!recipeBaselineTaken && recipeVerifyCommands.length > 0 && toolCalls.some(c => isMutatingToolName(c.name))) {
      await snapshotRecipeBaselineIfNeeded()
    }

    // Dispatch via tool-handlers registry. Each handler knows its own scheduling
    // mode (parallel-read / sequential / confirm-write); the loop honours it.
    // ЗАДАЧА 2: дефолт места сохранения артефакта — «туда, где человек найдёт».
    // Папка материалов → её корень (alongside); вложения → Загрузки (downloads);
    // без материалов → прежний project. Это ДЕФОЛТ на молчание модели (пропуск
    // save_to), а не классификатор поверх неё: явный save_to модели перекрывает
    // (см. generateDocxHandler). Половину развилки (вложения) добавил штаб —
    // иначе A1-сценарий с приложенными файлами снова падал бы в .verstak.
    const defaultDocxSaveTo =
      materialsCtx?.source === 'folder' ? 'alongside' as const
      : materialsCtx?.source === 'attachments' ? 'downloads' as const
      : undefined
    const ctx: ToolContext = {
      sender, sendId, signal, projectPath, tools,
        recordWrite, recordPlan, getPlan, plans, planOutcomes, tasks, agentJobs, agentJobScheduler, scheduledJobs, recordJournal, readJournal, saveMemory, saveDecision, searchMemories, searchConversations, connectors,
        outcome, pipelineRuns, revisePlanId: revisePlanId ?? null,
      // §10 хвост: отпустить чекпойнт прогона, с которого сняли план (доработка
      // переносит якорь на текущий прогон — прежний иначе осиротел бы).
      clearRunCheckpoint: (id: string) => { try { agentRuns?.clearCheckpoint(id) } catch { /* уборка не критична */ } },
        runChecks: () => Array.from(executedChecks, ([command, exitCode]) => ({ command, exitCode })),
      invalidateMemory,
      pendingAttachments, pendingWrites, pendingCommands, pendingPlans, scopedKey,
      agentMode: runAgentMode, setAgentMode: (m) => { runAgentMode = m }, skillRegistry, getSecretForDelegate,
      // tools_allow: сырой список — для наследования дочерней сессией (spawn_task_session);
      // allowedToolNames — набор для гейта диспетчера (enforcement на исполнении);
      // isChildSession — чтобы отказ гейта объяснил наследование от родителя.
      toolsAllow: toolsAllow ?? null, allowedToolNames, isChildSession: isChildSession === true,
      // Этап 1а headless: read-only политика коннекторов + серверный каталог «downloads».
      readOnlyConnectors: readOnlyConnectorsCtx, artifactsDownloadsDir: artifactsDownloadsDirCtx,
      defaultDocxSaveTo,
      // ЗАДАЧА A: alongside кладёт РЯДОМ С МАТЕРИАЛАМИ. База папки материалов известна
      // только когда источник — папка (композер); для вложений её нет (пусто → корень).
      materialsDir: materialsCtx?.source === 'folder' ? materialsCtx.base : undefined,
      // ЗАДАЧА A вариант (i): когда папка материалов не задана — alongside берёт общий
      // каталог реально прочитанных файлов (зажатый в корень). Функция, а не значение:
      // readPaths копятся ПО ХОДУ прогона, а generate_docx зовётся позже.
      getReadCommonDir: () => commonReadDir(readPaths, projectPath),
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
      // §наблюдение-30.07: модель родителя доезжает до суб-агента (симметрия к
      // currentProviderId). На custom-openai без неё в шлюз шла пустая модель.
      currentModel: model ?? undefined,
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
    const toolResults = await dispatchToolTurn({
      toolCalls,
      context: ctx,
      hooks,
      addContext: context => pendingSupplements.push(context),
    })
    // P2 (Этап 6): зафиксировать успешный проход обязательного review gate по
    // результату его tool-вызова (маркер REVIEW_GATE_PASS_MARKER). Только при
    // recipe.reviewer.required — иначе no-op для обычных прогонов/скиллов.
    if (recipeRequiresReview && !reviewGatePassed && reviewGatePassedInTurn(toolCalls, toolResults)) {
      reviewGatePassed = true
    }
    // Tally tool usage for the end-of-session journal summary
    // auto_capture_memory: 2.1.13 — сырой захват tool-потока стал opt-in (по умолчанию
    // ВЫКЛЮЧЕН). Знание в память кладёт bounded-событие pre-compress, а не поток
    // «Записан файл X (123 символов)». Прежнее поведение возвращается настройкой 'true'.
    const autoCaptureEnabled = isAutoCaptureEnabled(getSecretForDelegate)
    const toolOutcome = collectToolTurnOutcome({
      toolCalls,
      toolResults,
      filesTouched,
      commandsRun,
      sessionChanges,
      executedChecks,
    })
    if (toolOutcome.attested) attestedThisRun = true
    if (toolOutcome.outcomeContractSubmitted) outcomeContractSubmitted = true
    if (toolOutcome.stepOutcomeReported) stepOutcomeReported = true
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      const result = toolResults[i]
      if (!result) continue
      // VSK-PRODUCT-A1 3b: трекинг read-исходов набора «папка». Только для folder —
      // у вложений исход из конвейера, а не из tool-вызовов (иначе ложная тревога).
      if (materialsCtx?.source === 'folder' && MATERIAL_READ_TOOLS.has(call.name)) {
        const p = typeof call.args.path === 'string' ? call.args.path : ''
        if (p) materialReadOutcomes.push({ path: p, ok: !result.error, reason: result.error })
      }
      // ЗАДАЧА A (i): копим пути УСПЕШНО прочитанных файлов (любой источник) — из них
      // alongside выводит каталог «рядом с материалами». Только удачные чтения: неудачное
      // «читал» не считается прочитанным материалом.
      if (MATERIAL_READ_TOOLS.has(call.name) && !result.error) {
        const p = typeof call.args.path === 'string' ? call.args.path : ''
        if (p) readPaths.push(p)
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
    // V2-3: копим за прогон принятые записи и факты проверки. Проверкой считается
    // вызов модели (isVerificationToolCall) — авто-диагностика продукта не годится:
    // гейт спрашивает, проверил ли себя АГЕНТ.
    runAcceptedWrites += toolOutcome.acceptedWrites
    runVerifications += toolCalls.filter(isVerificationToolCall).length
    // V3: тот же признак проверки, что у гейта (общий isVerificationToolCall —
    // второго определения «что считается проверкой» в продукте быть не должно),
    // но здесь запоминается ещё и ИСХОД. Успех читается из кода возврата, если он
    // есть; у инструментов без кода — по отсутствию ошибки.
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      if (!isVerificationToolCall(call)) continue
      const res = toolResults[i]
      const exitCode = (res?.result as { exitCode?: unknown } | null | undefined)?.exitCode
      const ok = !res?.error && (typeof exitCode === 'number' ? exitCode === 0 : true)
      const label = typeof call.args?.command === 'string' && call.args.command.trim()
        ? call.args.command.trim()
        : call.name
      verificationTrail.push({ label, ok })
    }
    if (runVerifyScriptHints.length === 0 && toolOutcome.acceptedWrites > 0) {
      const hints = recipeVerifyCommands.length > 0
        ? recipeVerifyCommands
        : await detectVerifyScriptsForHint(projectPath).catch(() => [])
      runVerifyScriptHints.push(...hints)
    }
    const verifyHint = await buildTurnVerificationHint({
      acceptedWrites: toolOutcome.acceptedWrites,
      tsWrites: toolOutcome.tsWrites,
      lspWrites: toolOutcome.lspWrites,
      toolCalls,
      projectPath,
      context: ctx,
      diagnosticEnabled: getSecretForDelegate?.('diagnostic_loop') !== 'false',
    })
    const nextUserMsg: ChatMessage = { role: 'user', content: verifyHint, toolResults }
    if (pendingAttachments.length > 0) {
      nextUserMsg.attachments = [...pendingAttachments]
      pendingAttachments.length = 0
    }
    currentMessages.push(nextUserMsg)

    // V2-4: встал ли прогон. Лестница восстановления выше лечит отказ ПРОВАЙДЕРА;
    // отказ ЗАДАЧИ (агент крутится и не узнаёт нового) рантайм-механизма не имел
    // вовсе — бюджет доедался молча. Признак один: ход не породил ни одного факта,
    // которого в прогоне ещё не было. Bounded: одна подсказка сменить подход, и
    // если не помогло — честная остановка с описанием блокера, а не тихий max-turns.
    //
    // Граница с детектором зацикливания выше (LOOP_THRESHOLD, signatureCounts):
    // тот ловит ТОЧНЫЙ повтор вызова — три одинаковые подписи — и делает это
    // РАНЬШЕ, поэтому до сюда такой прогон на десктопе не доходит вовсе. V2-4
    // добирает то, чего подпись не видит: чтение по кругу разных файлов и ходы,
    // не приносящие нового знания при формально разных вызовах. Механизмы не
    // дублируются, они смотрят на разное — на ВЫЗОВ и на ЗНАНИЕ. На CLI-пути
    // первого нет вовсе, там V2-4 закрывает оба случая.
    // Д4: наблюдения безаргументных вызовов этого хода. Порядок важен: сперва
    // действия обнуляют счёт (мир изменился по воле агента), потом пишутся сами
    // наблюдения — иначе снимок, снятый в одном ходу с навигацией, был бы стёрт
    // собственной же навигацией и правило не сработало бы никогда.
    if (toolCalls.some(c => changesObservation(c.name))) noteContextChange(observationState)
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      if (!hasNoArgs(call.args)) continue
      recordObservation(observationState, call.name, {
        result: toolResults[i]?.result,
        error: toolResults[i]?.error,
      })
    }
    lastTurnProgress = recordTurn(progressState, toolCalls.map((call, i) => ({
      name: call.name,
      args: call.args,
      result: toolResults[i]?.result,
      error: toolResults[i]?.error,
    })))
    const stagnation = detectStagnation(progressState)
    let turnDecision = 'продолжаю'
    if (stagnation.stagnant) {
      if (progressState.strategyNudges < MAX_STRATEGY_NUDGES) {
        progressState.strategyNudges++
        turnDecision = `прошу сменить подход (${stagnation.reason})`
        currentMessages.push({ role: 'user', content: buildStrategyChangeHint(stagnation.reason, stagnation.staleTurns) })
        sender.send('ai:event', {
          id: sendId,
          event: { type: 'tool-blocked', callId: `stagnation-${progressState.strategyNudges}`, name: toolCalls[0]?.name ?? 'run_command',
            reason: 'Прогресса нет несколько ходов подряд — прошу сменить подход.' },
        })
      } else {
        emitStepLine(turn, toolCalls, `останавливаю: застой (${stagnation.reason})`, toolResults)
        sender.send('ai:event', { id: sendId, event: { type: 'info', message: stagnationStopNote(stagnation.reason, stagnation.staleTurns) } })
        exitReason = 'loop-detected'
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
    }
    // V2-5: одна строка на шаг в едином формате. Едет существующим каналом
    // agent_run_events (kind='step') — новой шины постановка не разрешает, да и
    // не нужно: не хватало не канала, а СОПОСТАВИМОЙ строки с решением рантайма.
    emitStepLine(turn, toolCalls, turnDecision, toolResults)

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
          compactedSinceFocusReinject = true // V2-1: после компакции вернуть Focus Chain
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
  // V2-2: сюда прогон доходит, только если продлевать было НЕЧЕГО — последний ход
  // не дал нового факта, либо бюджет назначил человек, либо уперлись в потолок.
  // Ручное «+N ходов» осталось ровно для этого случая; считаем от РЕАЛЬНОГО
  // бюджета (с учётом автопродлений), иначе кнопка предлагала бы уже потраченное.
  const canContinue = effectiveTurnsBudget < MAX_BUDGET_TURNS
  sender.send('ai:event', {
    id: sendId,
    event: {
      type: 'turns-exhausted',
      used: effectiveTurnsBudget,
      maxBudget: MAX_BUDGET_TURNS,
      canContinue,
      suggestedAdd: Math.min(10, MAX_BUDGET_TURNS - effectiveTurnsBudget)
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
      turnCount: effectiveTurnsBudget
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
    // VSK-PRODUCT-A1 3b: код-сводка чтения материалов — ОДНО место на норму/ошибку/
    // отмену. Не на handed-off кадре: его работу продолжает рекурсивный фрейм (тот и
    // эмитит; иначе на fallback был бы дубль). Сводку в контекст модели НЕ инжектим —
    // она верна независимо от того, что модель захочет сказать. Строка показывается
    // ТОЛЬКО когда есть что сказать (formatMaterialsLine != null).
    // Ограничение: при fallback внутри folder-прогона трекинг read-исходов не
    // переносится в дочерний кадр (folder-источник пока не имеет живого UI-триггера —
    // композер выбора папки идёт следующим пакетом); при его включении — дотянуть.
    if (!handedOff && materialsCtx) {
      try {
        const outcomes = materialsCtx.source === 'attachments'
          ? (materialsCtx.attachmentOutcomes ?? [])
          : materialReadOutcomes
        const summary = summarizeMaterials({
          materials: materialsCtx.items,
          base: materialsCtx.base,
          outcomes,
          source: materialsCtx.source,
        })
        const line = formatMaterialsLine(summary)
        if (line) {
          sender.send('ai:event', {
            id: sendId,
            event: {
              type: 'materials-read',
              source: summary.source === 'none' ? 'attachments' : summary.source,
              total: summary.total,
              read: summary.read.length,
              failed: summary.failed,
              notOpened: summary.notOpened,
              readOutside: summary.readOutside.length,
              line,
            },
          })
        }
      } catch { /* сводка материалов не критична — не ломаем финализацию прогона */ }
    }
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
      finalizeApiRun({
        sendId,
        projectPath,
        exitReason,
        lastAssistantText,
        lastSummary,
        filesTouched,
        commandsRun,
        sessionUsage,
        recordJournal,
        saveMemory,
        // session-end дедуп: сверяем итог с релевантной уже сохранённой памятью,
        // иначе каждая похожая сессия добавляла бы ещё один почти такой же дамп.
        existingMemoryContents: p => {
          try {
            return searchMemories(p, lastSummary, 20).map(m => m.content)
          } catch {
            return []
          }
        },
        agentRuns,
        runId,
        providerId,
        model,
        initialMessages,
        toolsSignature,
        attestedThisRun,
        toolCallCount,
        agentsCount: agentCounter.count,
        costCents: costGuard?.current() ?? 0,
        clearCheckpointThrottle: id => checkpointThrottle.delete(id),
      })
      // ЗАДАЧА 1 (a)+(в): терминальный сигнал СТРОГО ПОСЛЕ finalizeApiRun — то есть
      // после agentRuns.finish(), который уже записал статус в БД. Рендер по нему
      // перечитывает resumableRuns (findResumable). Без этого прогон, умерший в
      // сессии, лежит в БД восстановимым, а список на экране остаётся стейл с
      // открытия проекта → пустая карточка вместо баннера. Шлём на КАЖДУЮ
      // финализацию (не только failed): одно правило, один источник правды —
      // нормально завершённый прогон findResumable не вернёт сам. Порядок
      // «сигнал после статуса» закреплён пином в tests/ipc/agent-loop.test.ts.
      if (runId) {
        sender.send('ai:event', { id: sendId, event: { type: 'run-finalized', runId, projectPath } })
      }
    }
  }
}

