import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { createFileTools, createToolsForProject, TOOL_DEFS } from '../ai/tools'
import { isWithinKnownRoots } from '../ai/path-policy'
import { createProvider, PROVIDERS, type ProviderId } from '../ai/registry'
import type { McpClient } from '../mcp/client'
import { prepareSystemContext } from '../ai/compose-system'
import { MAX_STEPS_REPORT } from '../ai/model-presets'
import { buildCliPrompt, type CliProviderId } from '../ai/cli-prompt'
import { loadCoreMemory } from '../ai/core-memory'
import { REVIEWER_SYSTEM_PROMPT } from '../ai/review-prompt'
import { compactToolHistory, shouldAutoCompact, buildCompactSummaryPrompt, createCompactedHistory } from '../ai/compact-history'
import { estimateTokens } from '../ai/context-limits'
import { withInitialRetry } from '../ai/with-retry'
import { createCostGuard } from '../ai/cost-guard'
import { SessionAgentCounter } from '../ai/delegation-limits'
import type { AgentMode } from '../ai/mode-policy'
import type { ChatMessage, ToolCall, ToolResult, ChatProvider, Attachment } from '../ai/types'
import { lookupHandler, type ToolContext, type TaggedSender as HandlerTaggedSender } from './tool-handlers'
import { captureToolObservation } from '../ai/memory-hooks'
import type { NewDecisionRecord, DecisionRecord } from '../storage/project-brain'
import { trackToolForPatterns, type ToolEvent } from '../ai/procedural-memory'
import { pickReviewProvider, buildCrossVerifyPrompt, runCrossVerify, getConfiguredApiProviders, type TurnChange } from '../ai/cross-verify'
import { shouldFallback, getNextFallback } from '../ai/smart-fallback'
import { estimateComplexity, recommendModel, complexityLabel, detectCliWorthiness } from '../ai/smart-router'
import { type ExitReason, callSignature, detectVerifyScriptsForHint, writeSessionJournal } from '../ai/session-journal'
import { parseResumeCheckpoint } from '../ai/resume-checkpoint'
import { intensityConfig, parseIntensity } from '../ai/intensity'
import { isTypeScriptFile, shouldAutoDiagnose, formatDiagnosticHint } from '../ai/diagnostic-loop'
import type { AgentRuns, AgentRunOwner, AgentRunStatus } from '../storage/agent-runs'
import { pickResumeGuardTool } from '../storage/agent-runs'
import { expandOfficeAttachments } from '../ai/attachment-text'

export type { ProviderId } from '../ai/registry'

interface AiDeps {
  getSecret: (key: string) => string | null
  getProviderId: () => ProviderId
  getProviderModel: (id: ProviderId) => string | null
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
  /** Сохранить структурированное Decision Record в Decision Memory (project-brain). */
  saveDecision: (projectPath: string, rec: NewDecisionRecord) => DecisionRecord
  /** Поиск по долговременной памяти проекта. */
  searchMemories: (projectPath: string, query: string, limit: number) => Array<{ id: string; type: string; content: string; tags: string[]; created_at: number }>
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
  /** Фасад персистентных суб-сессий (Фаза 2, Идея 1). Прокидывается в ToolContext,
   *  чтобы delegate_task/delegate_parallel сохраняли историю субагентов в БД. */
  subSessions?: ToolContext['subSessions']
  /** Фасад TodoGate (Фаза 3, Идея 2) — оркестрационный todo-лист сессии. */
  sessionTodos?: ToolContext['sessionTodos']
  /** Фасад Multi-agent Manager (Фаза 1) — agent_runs. Прокинут заранее; запись
   *  прогонов (create/finish/recordRunEvent) подключит Фаза 2 — здесь НЕ используется. */
  agentRuns?: AgentRuns
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

/** Дополнения user-сообщений в активный API agent-loop (sendId → push). */
const conversationSupplements = new Map<number, (text: string) => void>()

function registerConversationSupplements(sendId: number, push: (text: string) => void): void {
  conversationSupplements.set(sendId, push)
}

function unregisterConversationSupplements(sendId: number): void {
  conversationSupplements.delete(sendId)
}

/** Инъекция догруженного контекста (supplement) в активный прогон по sendId.
 *  false — если для sendId нет активного слушателя. Используется ai:append-context. */
export function pushConversationSupplement(sendId: number, text: string): boolean {
  const push = conversationSupplements.get(sendId)
  if (!push) return false
  push(text)
  return true
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

/**
 * Tag every ai:event with the project it belongs to so the renderer can route
 * the update to the correct session (background-agent support).
 */
function tagSender(sender: Electron.WebContents, projectPath: string | null): TaggedSender {
  return {
    send: (channel: string, payload: { id: number; event: unknown }) => {
      sender.send(channel, { ...payload, projectPath })
    },
    exec: (code: string) => sender.executeJavaScript(code, true)
  }
}

// Keyed by `${sendId}::${callId}` so concurrent ai:send invocations cannot
// resolve each other's pending confirmations. The renderer still identifies
// modals by callId (it doesn't know about sendId), so we look up by callId
// suffix when resolving — but isolation is enforced when CLEARING (ai:stop).
interface PendingWrite { sendId: number; resolve: (accept: boolean) => void }
const pendingWrites = new Map<string, PendingWrite>()

interface PendingCommand { sendId: number; resolve: (accept: boolean) => void }
const pendingCommands = new Map<string, PendingCommand>()

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
  if (sendId <= 0) {
    for (const [k, c] of activeAborts) { c.abort(); activeAborts.delete(k) }
    for (const [k, p] of pendingWrites) { p.resolve(false); pendingWrites.delete(k) }
    for (const [k, p] of pendingCommands) { p.resolve(false); pendingCommands.delete(k) }
    return true
  }
  const ctrl = activeAborts.get(sendId)
  if (!ctrl) return false
  ctrl.abort()
  activeAborts.delete(sendId)
  // Reject ONLY this session's pending confirmations — other concurrent
  // ai:send streams (background sessions) keep theirs intact.
  for (const [k, p] of pendingWrites) {
    if (p.sendId === sendId) { p.resolve(false); pendingWrites.delete(k) }
  }
  for (const [k, p] of pendingCommands) {
    if (p.sendId === sendId) { p.resolve(false); pendingCommands.delete(k) }
  }
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
  }

  ipcMain.handle('ai:send', async (e, incomingMessages: ChatMessage[], projectPath: string | null, budget?: number, overrides?: AiSendOverrides, chatId?: string) => {
    // Безопасность: projectPath приходит из рендерера. Без проверки агент мог бы
    // получить файловый + shell доступ к произвольной системной папке (C:\Windows,
    // C:\Users\Pavel). Гейтим так же, как files/terminal IPC (isWithinKnownRoots).
    if (projectPath && !isWithinKnownRoots(projectPath, deps.getKnownRoots())) {
      throw new Error('Доступ запрещён: путь проекта не зарегистрирован')
    }
    const messages = await expandOfficeAttachments(incomingMessages)
    // Crash-resume Фаза 2: возобновление с накопленным контекстом. Если передан
    // resumeFromRunId и у прогона есть валидный чекпойнт — берём полную историю
    // (она уже содержит system + все turn'ы), минуя пере-сборку system ниже.
    // Невалидный/отсутствующий снапшот → null → обычный старт по incomingMessages.
    const resumedMessages = overrides?.resumeFromRunId
      ? parseResumeCheckpoint(deps.agentRuns?.latestCheckpoint(overrides.resumeFromRunId)?.messagesJson ?? null)
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
    /**
     * Cleanup MUST handle every dangling state owned by this sendId. Per Gemini
     * audit finding 2.1 + 2.5: previously cleanup only wiped activeAborts,
     * leaving pending confirmations (and their pending Promises) alive
     * forever if the session crashed/aborted before user clicked. That was a
     * silent memory leak AND a source of weird "ghost confirmations" on the
     * next session with similar callId.
     */
    const cleanup = () => {
      activeAborts.delete(sendId)
      // Drain pending confirmations for this sendId — resolving with false so
      // any awaiter unwinds cleanly instead of leaking the Promise.
      for (const [k, p] of pendingWrites) {
        if (p.sendId === sendId) { p.resolve(false); pendingWrites.delete(k) }
      }
      for (const [k, p] of pendingCommands) {
        if (p.sendId === sendId) { p.resolve(false); pendingCommands.delete(k) }
      }
      // sendIdToChatId mapping cleared via separate ai:event done handler in
      // renderer — no need to touch from main.
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
    if (shouldInjectMemory) {
      try {
        memories = deps.searchMemories(projectPath!, '', 5)
      } catch (err) {
        // Память недоступна — продолжаем без неё, не блокируем пользователя
        console.warn('[ai] searchMemories failed:', err instanceof Error ? err.message : err)
      }
    }

    let messagesWithSystem = messages
    // composedSystem — точная system-строка, ушедшая модели в API-пути. Захватываем
    // для Debug Packet (снапшот реального входа run'а). Остаётся null для CLI-пути
    // (CLI строит свой промпт внутри buildCliPrompt — снапшот там пока не делаем) и
    // для reviewer override.
    let composedSystem: string | null = null
    let brain: { content: string; packType: string; tokenEstimate?: number | null } | null = null
    // Reviewer override (Explicit Review) — ПОЛНАЯ ЗАМЕНА системного промпта.
    // Ревьюер не является агентом проекта: он читает работу другого AI и даёт
    // независимый разбор. Давать ему system-layer + user-layer = заставить
    // вести себя как сам агент, а не как критик → теряется смысл кросс-ревью.
    // Поэтому reviewer-промпт остаётся единственной системной инструкцией.
    if (resumedMessages) {
      // Crash-resume Фаза 2: чекпойнт уже содержит system + полную историю прогона
      // — подаём как есть, минуя пере-сборку контекста. composedSystem остаётся
      // null (Debug-снапшот системы для возобновления не делаем — это продолжение).
      messagesWithSystem = resumedMessages
    } else if (overrides?.useReviewerPrompt) {
      messagesWithSystem = [{ role: 'system', content: REVIEWER_SYSTEM_PROMPT }, ...messages]
    } else if (descriptor.transport === 'API') {
      // Same assembly path as CLI providers — see ai/compose-system.ts.
      // projectSystemPrompt — пользовательский промпт из Project Settings
      // (UI шестерёнки в Project Rail). Хранится в settings ключом
      // `system_prompt_${path}`. Если пусто — игнорируется.
      const projectSystemPrompt = projectPath ? deps.getSecret(`system_prompt_${projectPath}`) : null
      // Core memory загружается при каждом turn'е — MEMORY.md + USER.md всегда актуальны.
      const coreMemory = projectPath ? loadCoreMemory(projectPath) : { memory: '', user: '' }
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
        coreMemory,
        agentMode,
        brainContext: brain?.content ?? null,
        skillPrompt: overrides?.systemPrompt
      })
      // Наслоение интенсивности (<intensity>) поверх собранного промпта — стерёт
      // поведение под Простой/Турбо. Простой-подсказка нейтральна к сегодняшнему
      // поведению (один прямой путь), Турбо — поощряет всю машинерию.
      composedSystem = composed.system + '\n\n' + intCfg.systemHint
      messagesWithSystem = [{ role: 'system', content: composedSystem }, ...messages]
    } else if (overrides?.systemPrompt) {
      // Не-API (CLI) транспорт со скилл-override. CLI-провайдеры строят свой
      // системный промпт внутри buildCliPrompt и игнорируют system-сообщение в
      // messages (cli-prompt.ts фильтрует role==='system'). Сам скилл наслаивается
      // для CLI через skillPromptForProvider → createProvider → buildCliPrompt
      // секцией <skill_layer> (см. ниже). Это system-сообщение — безвредный
      // fallback для гипотетических не-CLI не-API провайдеров (CLI его отфильтрует).
      messagesWithSystem = [{ role: 'system', content: overrides.systemPrompt }, ...messages]
    }

    const taggedSender = tagSender(e.sender, projectPath)
    // Project Brain (Итер.4 + Phase 3): бейдж «использован прогретый контекст» +
    // метрика экономии — сколько токенов контекста мозг дал готовыми (агент не
    // пере-сканировал проект). Честный показатель ценности прогрева.
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
        model = suggested
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
          systemPrompt: composedSystem,
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
    const skillPromptForProvider = overrides?.useReviewerPrompt ? null : (overrides?.systemPrompt ?? null)

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
          memories
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

    let provider: ChatProvider
    try {
      // Claude Code OAuth token (из `claude setup-token`) — для headless+Max.
      // Если задан в settings, передаётся как env var дочернему claude процессу.
      const claudeOauthToken = providerId === 'claude-cli'
        ? deps.getSecret('claude_code_oauth_token')
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
        customBaseUrl,
        customModels,
        yandexFolderId,
        gigachatClientSecret,
        gigachatTlsVerify,
        memories: descriptor.transport === 'CLI' ? memories : undefined,
        effortLevel: resolvedEffort,
        agentMode
      })
    } catch (err) {
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
    try {
      deps.agentRuns?.create({
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
      if (runTitle) deps.agentRuns?.appendEvent(runId, 'user_msg', { detail: runTitle })
    } catch (err) {
      console.warn('[agent-runs] create failed:', err instanceof Error ? err.message : err)
    }

    // Dev Task Flow (Фаза 2): если у активного чата есть открытая dev_task —
    // привязываем этот прогон к ней (один dev_task ↔ N run_id). Не для review-
    // прогонов (их активность к задаче не относится). Best-effort.
    if (projectPath && runOwner === 'main') {
      try {
        deps.linkDevTaskRun?.(projectPath, chatId ? Number(chatId) : null, runId)
      } catch (err) {
        console.warn('[dev-task] linkDevTaskRun failed:', err instanceof Error ? err.message : err)
      }
    }

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
      try {
        return createProvider(fallbackId, {
          apiKey: fallbackKey,
          model: fallbackModel,
          cwd: projectPath ?? process.cwd(),
          signal: ctrl.signal,
          projectSystemPrompt: projectSystemPromptForProvider,
          skillPrompt: skillPromptForProvider,
          effortLevel: overrides?.effortLevel,
          agentMode
        })
      } catch {
        return null
      }
    }

    if (useToolsPath) {
      const tools = createToolsForProject(projectPath, ctrl.signal)
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
      void runApiConversation({
        sender: taggedSender, sendId, provider, tools, projectPath,
        initialMessages: messagesWithSystem, signal: ctrl.signal,
        recordWrite: deps.recordWrite, recordPlan: deps.recordPlan,
        recordJournal: deps.recordJournal, readJournal: deps.readJournal,
        saveMemory: deps.saveMemory, saveDecision: deps.saveDecision,
        searchMemories: deps.searchMemories, searchConversations: deps.searchConversations,
        connectors: deps.connectors, agentMode, turnsBudget,
        skillRegistry: deps.skillRegistry, getSecretForDelegate: deps.getSecret, costGuard,
        providerId, model,
        fallbackOpts: smartFallbackEnabled ? { getNextProvider: makeFallbackProvider, getProviderModel: (id) => deps.getProviderModel(id) ?? PROVIDERS[id]?.defaultModel ?? null, configuredProviders: new Set(getConfiguredApiProviders(deps.getSecret)), triedProviders: new Set([providerId]) } : undefined,
        mcpClientRef: deps.mcpClient, appendAuditFn: auditFn, trackToolPatternFn: deps.trackToolPattern,
        parentChatId: chatId ? Number(chatId) : null,
        subSessions: deps.subSessions, sessionTodos: deps.sessionTodos,
        agentRuns: deps.agentRuns, runId, verifications: deps.verifications,
        toolsAllow: overrides?.toolsAllow ?? null,
      }).finally(cleanup)
    } else {
      void runPlainConversation(taggedSender, sendId, provider, projectPath, messagesWithSystem, ctrl.signal, deps.recordJournal, costGuard, providerId, model,
        smartFallbackEnabled ? { getNextProvider: makeFallbackProvider, getProviderModel: (id) => deps.getProviderModel(id) ?? PROVIDERS[id]?.defaultModel ?? null, configuredProviders: new Set(getConfiguredApiProviders(deps.getSecret)), triedProviders: new Set([providerId]) } : undefined,
        deps.agentRuns,
        runId
      ).finally(cleanup)
    }
    return sendId
  })

  ipcMain.handle('ai:stop', (_e, sendId: number) => abortSend(sendId))

  ipcMain.handle('ai:append-context', (_e, sendId: number, text: string) => {
    const trimmed = String(text ?? '').trim()
    if (!trimmed || sendId <= 0) return { ok: false as const, fallback: 'invalid' as const }
    if (!pushConversationSupplement(sendId, trimmed)) return { ok: false as const, fallback: 'unavailable' as const }
    return { ok: true as const }
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
          { role: 'user', parts: [{ text: composed.system }] }
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
}

/**
 * Маппинг exitReason агентного цикла → status строки agent_runs.
 * completed → done; aborted → stopped; error/crashed → failed.
 * max-turns/loop-detected → done: цикл штатно остановился по защитному лимиту
 * (бюджет ходов исчерпан / детектор зацикливания) — это не сбой выполнения,
 * пользователь может «↻ Переотправить» (Resume V1). Ошибкой это не считаем.
 */
function exitReasonToStatus(reason: ExitReason): AgentRunStatus {
  switch (reason) {
    case 'completed': return 'done'
    case 'aborted': return 'stopped'
    case 'error':
    case 'crashed': return 'failed'
    case 'max-turns':
    case 'loop-detected': return 'done'
    default: return 'done'
  }
}

/** Опции smart fallback — пробрасываются из ai:send в conversation runners. */
interface FallbackOpts {
  /** Создаёт провайдера для указанного fallback-кандидата (null если нет ключа). */
  getNextProvider: (id: ProviderId) => ChatProvider | null
  /** Модель fallback-кандидата — чтобы cost-guard/журнал прогона считались по
   *  РЕАЛЬНОЙ модели fallback'а, а не по модели упавшего провайдера (#7). */
  getProviderModel: (id: ProviderId) => string | null
  /** Провайдеры с настроенными ключами. */
  configuredProviders: Set<ProviderId>
  /** Уже попробованные провайдеры (мутируется по ходу). */
  triedProviders: Set<ProviderId>
}

/** Максимальное количество fallback-попыток (original + 2 alternates). */
const MAX_FALLBACK_ATTEMPTS = 2

/**
 * Plain streaming conversation — no tools, no multi-turn. Used for providers
 * that don't support function calling yet (Claude/Grok/OpenAI/Gemini CLI).
 *
 * Per Grok audit 2026-05-21 (CLI parity, finding 2.1/2.2/2.5): previously this
 * path was 17 lines with zero journaling, no lastAssistantText capture, no
 * usage tracking, no exit-reason. CLI sessions left no trail in dev-journal —
 * the same gap we already closed for the API path. Now mirrors the API
 * lifecycle: collect text/usage during the stream, write a session journal in
 * try/finally regardless of how the stream ended.
 */
async function runPlainConversation(
  sender: TaggedSender,
  sendId: number,
  provider: ChatProvider,
  projectPath: string | null,
  messages: ChatMessage[],
  signal: AbortSignal,
  recordJournal: AiDeps['recordJournal'],
  costGuard?: ReturnType<typeof createCostGuard>,
  providerId?: ProviderId,
  model?: string,
  fallbackOpts?: FallbackOpts,
  agentRuns?: AgentRuns,
  runId?: string
): Promise<void> {
  const currentMessages = [...messages]
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
        content: `[Дополнение к текущей задаче]\n${text}`
      })
      added = true
      if (agentRuns && runId) {
        try { agentRuns.appendEvent(runId, 'user_msg', { detail: text.slice(0, 500) }) } catch { /* best-effort */ }
      }
    }
    return added
  }

  let lastAssistantText = ''
  const sessionUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } = {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0
  }
  let exitReason: ExitReason = 'completed'
  let handedOff = false // #15: при fallback финализирует рекурсивный фрейм
  try {
    while (!signal.aborted) {
      drainSupplements()
      let roundText = ''
      let roundHadError = false

      for await (const event of provider.send(currentMessages, [])) {
        if (signal.aborted) {
          exitReason = 'aborted'
          sender.send('ai:event', { id: sendId, event: { type: 'done' } })
          return
        }
        // Accumulate stream into lastAssistantText so journal has a real summary.
        // CLI providers stream text in chunks via { type: 'text' } — same shape
        // as API providers.
        if (event.type === 'text' && typeof event.text === 'string') {
          roundText += event.text
          lastAssistantText += event.text
        } else if (event.type === 'usage' && event.usage) {
          sessionUsage.inputTokens += event.usage.inputTokens ?? 0
          sessionUsage.outputTokens += event.usage.outputTokens ?? 0
          sessionUsage.cachedInputTokens += event.usage.cachedInputTokens ?? 0
          // Cost guard check — abort если превышен лимит.
          if (costGuard && providerId) {
            const check = costGuard.recordAndCheck(
              providerId, model ?? '', event.usage.inputTokens ?? 0,
              event.usage.outputTokens ?? 0, event.usage.cachedInputTokens ?? 0
            )
            if (check.exceeded) {
              exitReason = 'error'
              sender.send('ai:event', { id: sendId, event: { type: 'error', message: check.message ?? 'cost cap exceeded' } })
              sender.send('ai:event', { id: sendId, event: { type: 'done' } })
              return
            }
          }
        } else if (event.type === 'error') {
          exitReason = 'error'
          roundHadError = true
        }
        if (event.type !== 'done') {
          sender.send('ai:event', { id: sendId, event })
        }
        if (event.type === 'done' || event.type === 'error') break
      }

      if (signal.aborted) {
        exitReason = 'aborted'
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
      if (roundHadError) {
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }

      if (roundText.trim()) {
        currentMessages.push({ role: 'assistant', content: roundText })
      }

      if (!drainSupplements()) {
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
    }
  } catch (err) {
    // Smart fallback: если ошибка retriable и есть ещё кандидаты — пробуем.
    if (fallbackOpts && providerId && (fallbackOpts.triedProviders.size - 1) < MAX_FALLBACK_ATTEMPTS) {
      fallbackOpts.triedProviders.add(providerId)
      if (shouldFallback(err)) {
        const nextId = getNextFallback(providerId, fallbackOpts.triedProviders, fallbackOpts.configuredProviders)
        const nextProvider = nextId ? fallbackOpts.getNextProvider(nextId) : null
        if (nextProvider && nextId) {
          console.log(`[fallback] ${providerId} failed: ${err instanceof Error ? err.message : String(err)}. Trying ${nextId}...`)
          sender.send('ai:event', {
            id: sendId,
            event: { type: 'info', text: `⚡ ${providerId} недоступен, переключаюсь на ${nextId}` }
          })
          fallbackOpts.triedProviders.add(nextId)
          // #7: модель fallback-провайдера, а не упавшего — для верного cost/журнала.
          const nextModel = fallbackOpts.getProviderModel(nextId) ?? model
          // #15: fallback-фрейм владеет финализацией (agentRuns/runId переданы).
          handedOff = true
          return runPlainConversation(sender, sendId, nextProvider, projectPath, messages, signal, recordJournal, costGuard, nextId, nextModel, fallbackOpts, agentRuns, runId)
        }
      }
    }
    exitReason = 'crashed'
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'error', message: err instanceof Error ? err.message : String(err) }
    })
    sender.send('ai:event', { id: sendId, event: { type: 'done' } })
  } finally {
    unregisterConversationSupplements(sendId)
    // Same guarantee as runApiConversation: every exit path writes a journal
    // entry. Skipped when there's no projectPath (background sessions in the
    // future may not have one). #15: при fallback журнал/finish делает рекурсивный фрейм.
    if (!handedOff && projectPath) {
      try {
        writeSessionJournal(
          recordJournal,
          projectPath,
          lastAssistantText,
          new Set<string>(),   // CLI path: no tool-driven file writes tracked here
          [],                  // CLI path: no command-tool dispatch (CLI runs them inside)
          sessionUsage,
          exitReason
        )
      } catch (err) {
        console.error('[ai.ts] writeSessionJournal (plain) failed in finally:', err)
      }
    }
    // Multi-agent Manager (Фаза 2): завершаем прогон. Best-effort — ошибка
    // storage не должна ломать runner. Plain-путь: tool/files = 0 (CLI крутит
    // их внутри, наружу не видно), стоимость из costGuard. agentRuns/runId не
    // (внешний finally, либо рекурсивный fallback-фрейм при handedOff — #15).
    // Review-прогоны (owner='review') финишируются здесь же.
    if (!handedOff && agentRuns && runId) {
      try {
        // Timeline: финальный ответ агента — итог CLI-прогона (на CLI-пути нет
        // recordRunEvent, так что это единственное содержательное событие ленты).
        if (lastAssistantText.trim()) {
          agentRuns.appendEvent(runId, 'assistant_msg', { detail: lastAssistantText.slice(0, 500), status: exitReason })
        }
        agentRuns.finish(runId, exitReasonToStatus(exitReason), {
          costCents: costGuard?.current() ?? 0,
          error: exitReason === 'error' || exitReason === 'crashed' ? lastAssistantText.slice(0, 500) || exitReason : null
        })
      } catch (err) {
        console.warn('[agent-runs] finish (plain) failed:', err instanceof Error ? err.message : err)
      }
    }
  }
}

// Type re-exports for renderer (api.d.ts)
export type { UsageDelta } from '../ai/types'

/**
 * Full agentic loop with file tools + diff confirmation + command sandbox.
 * Only providers that support function calling go through here.
 */
const DEFAULT_AGENT_TURNS = 8
const MAX_BUDGET_TURNS = 40  // hard ceiling even with continues — prevents infinite-budget abuse

/**
 * Аудит M4: отбирает инструменты, которые увидит модель, по tools_allow скилла.
 * - toolsAllow пуст/не задан → без ограничений (стандартные + MCP).
 * - задан → пересечение по имени и для стандартных, и для MCP-инструментов.
 * - все имена — опечатки (пересечение по стандартным пусто) → НЕ оставляем
 *   модель без инструментов: полный набор + warn (broken-скилл ≠ дыра).
 * Экспортируется для unit-теста — lock на поведение безопасности скиллов.
 */
export function selectAllowedToolDefs<T extends { name: string }>(
  baseDefs: readonly T[],
  mcpDefs: readonly T[],
  toolsAllow?: string[] | null
): T[] {
  const allowSet = Array.isArray(toolsAllow) && toolsAllow.length > 0 ? new Set(toolsAllow) : null
  if (!allowSet) return mcpDefs.length > 0 ? [...baseDefs, ...mcpDefs] : [...baseDefs]
  const base = baseDefs.filter(t => allowSet.has(t.name))
  const mcp = mcpDefs.filter(t => allowSet.has(t.name))
  // Ни одно имя не совпало (скилл целиком в опечатках) → fail-open + warn, чтобы
  // broken-скилл не стал молчаливым кирпичом. Если же совпали ТОЛЬКО mcp (скилл
  // хочет mcp-only) — это валидное ограничение, base не восстанавливаем.
  if (base.length === 0 && mcp.length === 0) {
    console.warn(`[agent] tools_allow=[${toolsAllow!.join(', ')}] не совпал ни с одним инструментом — ограничение пропущено (проверь имена в скилле)`)
    return mcpDefs.length > 0 ? [...baseDefs, ...mcpDefs] : [...baseDefs]
  }
  return mcp.length > 0 ? [...base, ...mcp] : [...base]
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
}

export async function runApiConversation(ctx: AgentRunContext): Promise<void> {
  const {
    sender, sendId, provider, tools, projectPath, initialMessages, signal,
    recordWrite, recordPlan, recordJournal, readJournal, saveMemory, saveDecision,
    searchMemories, searchConversations, connectors, agentMode,
    turnsBudget = DEFAULT_AGENT_TURNS, skillRegistry, getSecretForDelegate, costGuard,
    providerId, model, fallbackOpts, mcpClientRef, appendAuditFn, trackToolPatternFn,
    parentChatId, subSessions, sessionTodos, agentRuns, runId, verifications, toolsAllow,
  } = ctx
  const currentMessages = [...initialMessages]
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
        content: `[Дополнение к текущей задаче]\n${text}`
      })
      added = true
      if (agentRuns && runId) {
        try { agentRuns.appendEvent(runId, 'user_msg', { detail: text.slice(0, 500) }) } catch { /* best-effort */ }
      }
    }
    return added
  }
  const continueAfterPlainReply = (text: string): boolean => {
    if (text.trim()) {
      currentMessages.push({ role: 'assistant', content: text })
      lastAssistantText = text
    }
    return drainSupplements()
  }
  // Loop detection: per-signature occurrence counter across the whole agent
  // loop. We block when a single tool+args combination has been called 3 times
  // (the threshold the UI tells the user). Tracking via Map avoids the
  // sliding-window eviction problem of the previous flat-array approach.
  const signatureCounts = new Map<string, number>()
  const LOOP_THRESHOLD = 3
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
  // Attachments collected from browser_screenshot etc. — flushed into the
  // next user message so vision-capable providers see them.
  const pendingAttachments: Attachment[] = []
  // Exit reason for the finally-block journal write. Mutated as the loop hits
  // various terminal conditions. 'crashed' is the default — if the function
  // returns abnormally (uncaught exception during streaming) the journal
  // still captures it. Per Gemini audit 2.2 + Idea B.
  let exitReason: ExitReason = 'crashed'
  // #15: при smart-fallback финализацию (journal + agentRuns.finish) делает
  // рекурсивный fallback-фрейм — внешний finally её пропускает, иначе успешный
  // fallback писался бы статусом 'crashed' упавшей попытки.
  let handedOff = false
  // Дерево делегирования (Фаза 4, Идея 3): один счётчик агентов на весь прогон
  // (ai:send). Прокидывается во ВСЕ вложенные субы через ctx.agentCounter →
  // общий потолок MAX_TOTAL_AGENTS_PER_SESSION на всё дерево, а не на ветку.
  const agentCounter = new SessionAgentCounter()

  try {

  turnLoop: for (let turn = 0; turn < turnsBudget; turn++) {
    drainSupplements()
    if (signal.aborted) {
      exitReason = 'aborted'
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
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
    const allToolDefs = isLastTurn ? [] : selectAllowedToolDefs(TOOL_DEFS, mcpToolDefs, toolsAllow)
    const messagesToSend = isLastTurn
      ? [...messagesForProvider, { role: 'user' as const, content: MAX_STEPS_REPORT }]
      : messagesForProvider

    for await (const event of withInitialRetry(
      () => provider.send(messagesToSend, allToolDefs, undefined, signal),
      {
        label: `turn-${turnNum}`,
        signal,
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
        exitReason = 'aborted'
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
      if (event.type === 'text') {
        assistantText += event.text
        lastAssistantText = assistantText
        sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'thought') {
        // Forward chain-of-thought verbatim — renderer accumulates into the
        // assistant message's `thinking` field for collapsed display.
        sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'tool-call') {
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
          exitReason = 'completed'
          sender.send('ai:event', { id: sendId, event })
          // Cross-verify: запускаем асинхронно ПОСЛЕ отправки done,
          // чтобы не блокировать UI. Результат придёт отдельным событием.
          if (getSecretForDelegate) fireCrossVerify(sender, sendId, sessionChanges, providerId, getSecretForDelegate)
          return
        }
      } else if (event.type === 'error') {
        exitReason = 'error'
        sender.send('ai:event', { id: sendId, event })
        return
      }
    }
    if (toolCalls.length === 0) {
      if (continueAfterPlainReply(assistantText)) {
        assistantText = ''
        continue
      }
      exitReason = 'completed'
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      // Cross-verify: запускаем асинхронно ПОСЛЕ отправки done.
      if (getSecretForDelegate) fireCrossVerify(sender, sendId, sessionChanges, providerId, getSecretForDelegate)
      return
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
      sender.send('ai:event', {
        id: sendId,
        event: {
          type: 'tool-blocked',
          callId: loopHits[0].id,
          name: loopHits[0].name,
          reason: `Зацикливание: один и тот же вызов повторён 3+ раза подряд. Цикл остановлен.`
        }
      })
      // Feed back a supervisor note instead of executing again
      currentMessages.push({
        role: 'user',
        content: '',
        toolResults: loopHits.map(c => ({
          id: c.id,
          name: c.name,
          result: '',
          error: 'Supervisor: вы зациклились — этот же вызов повторён несколько раз. Смените подход или сообщите пользователю что нужна помощь.'
        }))
      })
      exitReason = 'loop-detected'
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }

    const toolResults: ToolResult[] = new Array(toolCalls.length)
    toolCallCount += toolCalls.length  // Manager (Фаза 2): tool_count прогона

    // Dispatch via tool-handlers registry. Each handler knows its own scheduling
    // mode (parallel-read / sequential / confirm-write); the loop honours it.
    const ctx: ToolContext = {
      sender, sendId, signal, projectPath, tools,
      recordWrite, recordPlan, recordJournal, readJournal, saveMemory, saveDecision, searchMemories, searchConversations, connectors,
      pendingAttachments, pendingWrites, pendingCommands, scopedKey,
      agentMode, skillRegistry, getSecretForDelegate,
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
      // attest_verification (Verification Фаза 2): снимок реально записанных за
      // прогон файлов — для сверки claimed vs actual в DoD-артефакте.
      runFilesTouched: () => Array.from(filesTouched),
      // Verification Фаза 3: фасад истории — attest_verification пишет строку
      // после writeVerificationArtifact (best-effort, для latest в Review DoD).
      verifications
    }
    const writePromises: Array<{ idx: number; promise: Promise<ToolResult> }> = []
    const readPromises: Array<{ idx: number; promise: Promise<ToolResult> }> = []
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
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
    // Tally tool usage for the end-of-session journal summary
    // auto_capture_memory: по умолчанию включено; выключается настройкой 'false'
    const autoCaptureEnabled = getSecretForDelegate?.('auto_capture_memory') !== 'false'
    let acceptedWritesThisTurn = 0
    let tsWritesThisTurn = 0  // Diagnostic Loop v2: правки .ts/.tsx → авто-tsc
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
      try {
        agentRuns.saveCheckpoint(runId, turn + 1, JSON.stringify(currentMessages))
      } catch { /* снапшот не критичен — resume просто не предложит контекст */ }
    }

    // Авто-компакшн: после каждого turn'а проверяем не исчерпали ли 95%
    // контекстного окна. Если да — суммаризируем одним синхронным API-вызовом
    // и заменяем currentMessages на сжатую версию. Механизм полностью независим
    // от sliding window (compactToolHistory выше) который работает на уровне
    // отдельных tool results.
    // auto_compact = 'false' отключает фичу; по умолчанию включена.
    const autoCompactEnabled = getSecretForDelegate?.('auto_compact') !== 'false'
    if (autoCompactEnabled && model && shouldAutoCompact(currentMessages, model)) {
      try {
        // Получаем резюме от той же модели — один non-streamed вызов
        const summaryMessages = buildCompactSummaryPrompt(currentMessages)
        let summaryText = ''
        for await (const ev of provider.send(summaryMessages, [], undefined, signal)) {
          if (ev.type === 'text') summaryText += ev.text
          if (ev.type === 'done' || ev.type === 'error') break
        }
        if (summaryText.trim()) {
          const beforeLen = currentMessages.length
          const compacted = createCompactedHistory(summaryText, currentMessages)
          currentMessages.length = 0
          currentMessages.push(...compacted)
          // Уведомляем пользователя через info-событие (UI покажет тост)
          sender.send('ai:event', {
            id: sendId,
            event: { type: 'info', text: '🔄 Контекст сжат — сессия продолжена' }
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
          console.warn('[agent] auto-compact: summary was empty, continuing without compaction')
        }
      } catch (err) {
        // Грейсфул деградация: компакшн упал — продолжаем без него
        console.warn('[agent] auto-compact failed, continuing without compaction:', err instanceof Error ? err.message : err)
      }
    }
  }
  // Budget exhausted — emit a dedicated event so the UI can offer "+N turns".
  // The renderer re-sends the current conversation with a larger budget if the
  // user clicks Continue.
  exitReason = 'max-turns'
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
    // Smart fallback для API-агентного пути: если withInitialRetry исчерпал
    // попытки и ошибка всё ещё retriable — переключаемся на следующего провайдера.
    if (fallbackOpts && providerId && (fallbackOpts.triedProviders.size - 1) < MAX_FALLBACK_ATTEMPTS) {
      fallbackOpts.triedProviders.add(providerId)
      if (shouldFallback(err)) {
        const nextId = getNextFallback(providerId, fallbackOpts.triedProviders, fallbackOpts.configuredProviders)
        const nextProvider = nextId ? fallbackOpts.getNextProvider(nextId) : null
        if (nextProvider && nextId) {
          console.log(`[fallback] ${providerId} failed: ${err instanceof Error ? err.message : String(err)}. Trying ${nextId}...`)
          sender.send('ai:event', {
            id: sendId,
            event: { type: 'info', text: `⚡ ${providerId} недоступен, переключаюсь на ${nextId}` }
          })
          fallbackOpts.triedProviders.add(nextId)
          // Передаём tools из замыкания — они привязаны к projectPath и signal, не к провайдеру.
          const fallbackTools = createToolsForProject(projectPath, signal)
          // #7: модель fallback-провайдера, а не упавшего — иначе cost-guard/журнал
          // считаются по тарифу чужой модели (cost cap не срабатывает).
          const nextModel = fallbackOpts.getProviderModel(nextId) ?? model
          // #15: передаём agentRuns/runId в fallback-фрейм — ОН финализирует run
          // своим (реальным) статусом; внешний finally пропускает финализацию по
          // handedOff. verifications/toolsAllow — capability-фильтр (M4) и индексация
          // attest обязаны действовать и при фолбэке.
          handedOff = true
          // 6.2: fallback продолжает с НАКОПЛЕННОЙ истории (currentMessages с
          // проделанными tool-результатами), а не с initialMessages — иначе
          // downstream-провайдер переделывает работу и повторно пишет файлы.
          return runApiConversation({ ...ctx, provider: nextProvider, tools: fallbackTools, initialMessages: currentMessages, providerId: nextId, model: nextModel })
        }
      }
    }
    exitReason = 'crashed'
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'error', message: err instanceof Error ? err.message : String(err) }
    })
    sender.send('ai:event', { id: sendId, event: { type: 'done' } })
  } finally {
    unregisterConversationSupplements(sendId)
    // #15: при handed-off fallback journal/finish делает рекурсивный фрейм (ему
    // переданы recordJournal + agentRuns/runId) — внешний пропускает, иначе
    // дублировал бы журнал и финализировал run статусом упавшей попытки.
    if (!handedOff) {
    // GUARANTEED journal write on every exit path — completion, abort, error,
    // max-turns, loop-detected, crashed (uncaught). Per Gemini audit Idea B:
    // 'любое завершение runApiConversation обязано вызвать writeSessionJournal'.
    try {
      writeSessionJournal(recordJournal, projectPath, lastAssistantText, filesTouched, commandsRun, sessionUsage, exitReason)
    } catch (err) {
      console.error('[ai.ts] writeSessionJournal failed in finally:', err)
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
        agentRuns.finish(runId, exitReasonToStatus(exitReason), {
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
      } catch (err) {
        console.warn('[agent-runs] finish (api) failed:', err instanceof Error ? err.message : err)
      }
    }
    } // /if (!handedOff) — #15
  }
}

