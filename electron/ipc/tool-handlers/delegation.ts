// Delegation: delegate_task / delegate_parallel / orchestrate / swarm + хелперы. Вынесено при распиле.
import type { ToolHandler, ToolContext } from './shared'
import type { ProviderId, CreateOptions } from '../../ai/registry'
import { getRolePrompt } from '../../ai/agent-roles'
import { findUserAgent } from '../../ai/user-agents'
import { addWorktree, removeWorktree, worktreeDiff } from '../../ai/git-worktree'

// T1.2 — кап на размер diff изолированного worktree в выдаче арбитру (символы).
const MAX_WORKTREE_DIFF_CHARS = 6000

// Таймаут на одну делегированную подзадачу. Поднят с 60с (one-shot эра) до 180с:
// субагент теперь крутит agent-loop с tool-вызовами (read/patch/run_command),
// что требует заметно больше времени. Лимит итераций (MAX_SUB_ITERATIONS) —
// вторая, независимая граница; таймаут страхует от зависшего провайдера/команды.
const SUB_TASK_TIMEOUT_MS = 180_000

// Cost-cap на ОДИН delegate_parallel вызов (помимо cap всей сессии из Settings).
// Защищает от батча из 30 задач, который один пожрёт весь бюджет: при превышении
// оставшиеся задачи батча не стартуют. В центах. Дефолт $3 — можно переопределить
// аргументом cost_cap_usd у delegate_parallel.
const DEFAULT_BATCH_COST_CAP_CENTS = 300

// ============================================================================

/**
 * Собрать опции для createProvider субагента. grok-версия ограничивалась
 * {apiKey, model, cwd, signal} — для verstak этого мало: российские и custom
 * провайдеры требуют дополнительные секреты:
 *   - yandex-gpt    → yandexFolderId (yandex_folder_id)
 *   - gigachat      → gigachatClientSecret (gigachat_client_secret)
 *   - custom-openai → customBaseUrl/customModels (custom_openai_baseurl/_models)
 *   - verstak-gateway → customBaseUrl (verstak_gateway_baseurl kill-switch)
 *   - claude-cli    → claudeOauthToken (claude_code_oauth_token, для headless+Max)
 * Секреты добираются через ctx.getSecretForDelegate (тот же reader, что и в
 * главном ai.ts:405-427). Без этого суб на 4+ провайдерах падает «Folder ID
 * не задан / Client Secret не задан / Base URL не задан».
 */
function buildSubCreateOptions(
  providerId: ProviderId,
  apiKey: string | null,
  model: string,
  signal: AbortSignal,
  ctx: ToolContext
): CreateOptions {
  const getSecret = ctx.getSecretForDelegate
  let customModels: string[] | undefined
  let customBaseUrl: string | undefined
  if (providerId === 'custom-openai') {
    const modelsRaw = getSecret?.('custom_openai_models')
    if (modelsRaw) customModels = modelsRaw.split(',').map(s => s.trim()).filter(Boolean)
    customBaseUrl = getSecret?.('custom_openai_baseurl') ?? undefined
  } else if (providerId === 'verstak-gateway') {
    customBaseUrl = getSecret?.('verstak_gateway_baseurl') ?? undefined
  }
  return {
    apiKey,
    model,
    cwd: ctx.projectPath,
    signal,
    claudeOauthToken: providerId === 'claude-cli' ? (getSecret?.('claude_code_oauth_token') ?? null) : undefined,
    customBaseUrl,
    customModels,
    yandexFolderId: providerId === 'yandex-gpt' ? (getSecret?.('yandex_folder_id') ?? undefined) : undefined,
    gigachatClientSecret: providerId === 'gigachat' ? (getSecret?.('gigachat_client_secret') ?? undefined) : undefined,
    gigachatTlsVerify: providerId === 'gigachat' ? (getSecret?.('gigachat_tls_verify') === 'true') : undefined,
    agentMode: ctx.agentMode
  }
}

// ============================================================================
// delegate_task — мультиагент V1
// ============================================================================

/**
 * Нормализует и дедуплицирует поле `id` у элементов батча IN-PLACE. Пустой id →
 * `<prefix>-N`, повтор → `id#2`, `id#3`… Нужно потому что subCallId строится как
 * `${call.id}:${item.id}` — дубль id схлопывает карточки субагентов (upsert по
 * callId) и ломает дерево суб-сессий. id — модельный ввод, программно не уникален.
 */
export function dedupeTaskIds(items: Array<{ id: string }>, prefix = 'task'): void {
  const seen = new Set<string>()
  items.forEach((item, i) => {
    let id = String(item.id ?? '').trim() || `${prefix}-${i + 1}`
    if (seen.has(id)) {
      let n = 2
      while (seen.has(`${id}#${n}`)) n++
      id = `${id}#${n}`
    }
    seen.add(id)
    item.id = id
  })
}

export const delegateTaskHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const skillId = call.args.skill_id ? String(call.args.skill_id) : null
      const providerOverride = call.args.provider_id ? String(call.args.provider_id) : null
      const modelOverride = call.args.model ? String(call.args.model) : null
      const role = call.args.role ? String(call.args.role) : null
      // Субагент-как-файл: пользовательский субагент из .verstak/agents/<name>.md —
      // свой system prompt + tools-whitelist + провайдер/модель. Перебивает скилл/роль.
      const agentName = call.args.agent ? String(call.args.agent) : null
      const userAgent = agentName ? findUserAgent(ctx.projectPath, agentName) : null
      if (agentName && !userAgent) {
        return { id: call.id, name: call.name, result: '', error: `delegate_task: субагент "${agentName}" не найден в .verstak/agents/` }
      }
      const prompt = String(call.args.prompt ?? '').trim()
      if (!prompt) {
        return { id: call.id, name: call.name, result: '', error: 'delegate_task: prompt обязателен' }
      }

      // Фаза 4 (Идея 3): гейт глубины + общего числа агентов. Главный агент имеет
      // depth=0; каждый суб увеличивает depth на 1. Если глубина исчерпана или
      // достигнут потолок числа агентов — отказываем понятной ошибкой. Резерв
      // считается ДО запуска, чтобы вложенное дерево не обошло лимит.
      const depth = ctx.delegationDepth ?? 0
      if (ctx.agentCounter) {
        const gate = ctx.agentCounter.tryReserve(depth, 1)
        if (!gate.allowed) {
          return { id: call.id, name: call.name, result: '', error: `delegate_task: ${gate.reason}` }
        }
      }

      // Скилл — опционально. Если задан, тащим его системный промпт + default provider/model.
      const skills = ctx.skillRegistry ? ctx.skillRegistry.list() : []
      const skill = skillId ? skills.find(s => s.id === skillId) ?? null : null

      const subProvider = providerOverride
        ?? userAgent?.provider
        ?? skill?.default_provider
        ?? null  // null → ai:send возьмёт текущий default из settings
      const subModel = modelOverride ?? userAgent?.model ?? skill?.default_model ?? null
      // Промпт субагента: пользовательский субагент (файл) > роль > скилл > generic.
      // Роль определяет и поведение, и набор tools (getRoleToolset). С tool-enabled
      // loop'ом важно явно сказать субу, что у него ЕСТЬ инструменты.
      const rolePrompt = role ? getRolePrompt(role) : null
      const systemPrompt = userAgent?.systemPrompt
        ?? rolePrompt
        ?? skill?.systemPrompt
        ?? 'Ты — sub-agent с доступом к инструментам (чтение файлов, поиск по проекту). Выполни узкую задачу, при необходимости используй tools, ответь по существу.'

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: {
          type: 'tool-activity',
          callId: call.id,
          name: 'delegate_task',
          label: 'delegate_task',
          detail: `${skill?.name ?? skillId ?? role ?? 'generic'} via ${subProvider ?? 'auto'}`,
          status: 'ok'
        }
      })

      // subagent-run visibility (fan-out V1) — additive card в чате. label/skill/
      // provider/task + status running → done/error + tool-счётчик (Фаза 1).
      const subLabel = userAgent?.name ?? skill?.name ?? skillId ?? role ?? 'sub-agent'
      let toolCount = 0
      const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
        ctx.sender.send('ai:event', {
          id: ctx.sendId,
          event: {
            type: 'subagent-run',
            callId: call.id,
            label: subLabel,
            provider: subProvider ?? undefined,
            skill: skillId ?? undefined,
            role: role ?? undefined,
            toolCount,
            task: prompt,
            status,
            result
          }
        })
      }
      emitSubagent('running')

      // Персистентная суб-сессия (Фаза 2, Идея 1): создаём строку kind='subagent',
      // привязанную к главному чату. Промпт суба сохраняем как первое сообщение.
      // Без subSessions фасада — работает как прежде (только эфемерная карточка).
      let subSessionId: number | null = null
      if (ctx.subSessions) {
        try {
          subSessionId = ctx.subSessions.create({
            projectPath: ctx.projectPath,
            parentChatId: ctx.parentChatId ?? null,
            role, task: prompt, callId: call.id,
            providerId: subProvider ?? ctx.currentProviderId ?? null,
            model: subModel ?? null,
            depth: depth + 1, parentCallId: ctx.parentCallId ?? null
          })
          ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'user', prompt)
        } catch { /* persist не критично — карточка всё равно покажется */ }
      }
      const finalizeSub = (status: string, assistant?: string) => {
        if (subSessionId == null || !ctx.subSessions) return
        try {
          if (assistant) ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'assistant', assistant)
          ctx.subSessions.update(subSessionId, { status, endedAt: Date.now() })
        } catch { /* persist не критично */ }
      }

      const { createProvider, PROVIDERS } = await import('../../ai/registry')
      const { runSubAgentLoop } = await import('../../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../../ai/role-tools')
      const fallbackProvider = subProvider ?? ctx.currentProviderId ?? null
      if (!fallbackProvider) {
        ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
        emitSubagent('error', 'нет провайдера')
        finalizeSub('error')
        return { id: call.id, name: call.name, result: '', error: 'delegate_task: provider_id не задан и у текущего чата нет провайдера. Укажи provider_id явно.' }
      }
      const descriptor = PROVIDERS[fallbackProvider as keyof typeof PROVIDERS]
      if (!descriptor) {
        ctx.agentCounter?.release(1)
        emitSubagent('error', `неизвестный provider ${fallbackProvider}`)
        finalizeSub('error')
        return { id: call.id, name: call.name, result: '', error: `delegate_task: неизвестный provider ${fallbackProvider}` }
      }
      const apiKey = descriptor.secretKey ? ctx.getSecretForDelegate?.(descriptor.secretKey) ?? null : null
      if (descriptor.secretKey && !apiKey) {
        ctx.agentCounter?.release(1)
        emitSubagent('error', `нет API key для ${fallbackProvider}`)
        finalizeSub('error')
        return { id: call.id, name: call.name, result: '', error: `delegate_task: нет API key для ${fallbackProvider}` }
      }

      // Per-task signal: проброс родительского abort + таймаут на весь loop.
      // 180с (было 60с для one-shot) — loop с tool-вызовами требует больше времени.
      const taskAc = new AbortController()
      const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
      const parentAbortHandler = () => taskAc.abort()
      ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

      // Глобальная очередь (Идея 6): ждём слот в семафоре процесса. Группа —
      // опциональный group-тег, чтобы суб можно было отменить массово.
      const { subAgentQueue } = await import('../../ai/sub-queue')
      const groupTag = call.args.group ? String(call.args.group) : null
      let queueSlot: { release: () => void; ticketId: number } | null = null
      try {
        queueSlot = await subAgentQueue.enter({ group: groupTag, role, abort: () => taskAc.abort() }, taskAc.signal)
      } catch {
        clearTimeout(timeoutId)
        ctx.signal.removeEventListener('abort', parentAbortHandler)
        ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
        emitSubagent('error', 'отменён в очереди')
        finalizeSub('cancelled')
        return { id: call.id, name: call.name, result: '', error: 'delegate_task: задача отменена в очереди' }
      }

      try {
        const resolvedModel = subModel ?? descriptor.defaultModel
        const provider = createProvider(
          fallbackProvider as ProviderId,
          buildSubCreateOptions(fallbackProvider as ProviderId, apiKey, resolvedModel, taskAc.signal, ctx)
        )
        // Whitelist tools: пользовательский субагент задаёт свой набор явно (файл),
        // иначе — по роли + глубине (Фаза 4). Субагент-файл с tools=[] → read-only
        // набор роли (безопасный дефолт). Объявленные tools всё равно гейтятся
        // mode-policy в хендлерах — декларация не повышает привилегии сверх режима.
        // SUBAGENT_FORBIDDEN_TOOLS (orchestrate/swarm) отсеиваем и из файлового набора
        // тоже — иначе субагент-файл обошёл бы инвариант «суб не оркеструет» (ревью MEDIUM).
        const { SUBAGENT_FORBIDDEN_TOOLS } = await import('../../ai/role-tools')
        const allowedTools = (userAgent && userAgent.tools.length)
          ? userAgent.tools.filter(t => !SUBAGENT_FORBIDDEN_TOOLS.has(t))
          : getRoleToolset(role, { depth: depth + 1 })
        const subCtx: ToolContext = {
          ...ctx,
          subProviderId: fallbackProvider as ProviderId,
          subModel: resolvedModel,
          // Дерево делегирования: суб глубже на 1, его родитель — этот вызов.
          delegationDepth: depth + 1,
          parentCallId: call.id
        }
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: prompt }
        ]
        const res = await runSubAgentLoop({
          provider, messages, allowedToolNames: allowedTools, ctx: subCtx,
          signal: taskAc.signal, role,
          onToolActivity: () => { toolCount++; emitSubagent('running') }
        })
        if (res.exitReason === 'error') {
          emitSubagent('error', res.error)
          finalizeSub('error', res.text.trim() || undefined)
          // Timeline задачи (Фаза 4): делегирование завершилось ошибкой.
          try { ctx.recordRunEvent?.('delegate', { label: subLabel, detail: res.error, ref: call.id, status: 'error' }) } catch { /* best-effort */ }
          return { id: call.id, name: call.name, result: '', error: `delegate_task error: ${res.error}` }
        }
        const trimmed = res.text.trim()
        if (!trimmed) {
          emitSubagent('error', 'sub-agent вернул пустой ответ')
          finalizeSub('error')
          try { ctx.recordRunEvent?.('delegate', { label: subLabel, detail: 'пустой ответ', ref: call.id, status: 'error' }) } catch { /* best-effort */ }
          return { id: call.id, name: call.name, result: '', error: 'delegate_task: sub-agent вернул пустой ответ' }
        }
        emitSubagent('done', trimmed.length > 1200 ? trimmed.slice(0, 1200) + '…' : trimmed)
        finalizeSub(res.exitReason === 'aborted' ? 'cancelled' : 'done', trimmed)
        // Timeline задачи (Фаза 4): делегирование завершено. label=роль/скилл/
        // провайдер суба, ref=callId, detail — число tool-вызовов суба.
        try { ctx.recordRunEvent?.('delegate', { label: subLabel, detail: `${res.toolCallCount} tools via ${subProvider ?? fallbackProvider}`, ref: call.id, status: 'ok' }) } catch { /* best-effort */ }
        try {
          ctx.recordJournal(ctx.projectPath, 'note',
            `🎭 Делегирование → ${skill?.name ?? skillId ?? role ?? fallbackProvider} (${res.toolCallCount} tools, ${res.exitReason})`,
            `Запрос: ${prompt.slice(0, 200)}\n---\nОтвет: ${trimmed.slice(0, 600)}${trimmed.length > 600 ? '…' : ''}`)
        } catch { /* journal не критично */ }
        return { id: call.id, name: call.name, result: `[Delegate from ${skill?.name ?? skillId ?? role ?? fallbackProvider}]\n\n${trimmed}` }
      } finally {
        clearTimeout(timeoutId)
        ctx.signal.removeEventListener('abort', parentAbortHandler)
        queueSlot?.release()
      }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// oracle (ось 3, кластер B) — reasoning-советник как first-class tool. Тонкая
// обёртка над delegate_task role=critic: read-only, лимиты глубины/числа агентов,
// суб-сессия, cost-guard — всё переиспользуется. Агент зовёт его проактивно для
// плана / ревью своего кода / дебага (инструкция в system-layer).
// ============================================================================

/** Рефрейм oracle-вызова в delegate_task role=critic. null если нет question (чистое, тестируемо). */
export function buildOracleDelegateArgs(args: Record<string, unknown>): Record<string, unknown> | null {
  const question = String(args.question ?? '').trim()
  if (!question) return null
  const context = args.context ? `\n\nКОНТЕКСТ:\n${String(args.context)}` : ''
  const files = Array.isArray(args.files) && args.files.length
    ? `\n\nОтносящиеся файлы (прочитай их): ${(args.files as unknown[]).map(String).join(', ')}` : ''
  const prompt = `Ты — senior-советник (oracle). Дай экспертную оценку/план/ревью по запросу. Будь критичен и конкретен, опирайся на РЕАЛЬНЫЙ код (читай файлы). Не правь и не запускай команды — ТОЛЬКО анализ и рекомендации.\n\nЗАПРОС: ${question}${context}${files}`
  // role=critic → read-only набор (researcher/critic/planner read-only по role-tools).
  return { role: 'critic', prompt, provider_id: args.provider_id, model: args.model, group: 'oracle' }
}

export const oracleHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const dargs = buildOracleDelegateArgs(call.args as Record<string, unknown>)
    if (!dargs) return { id: call.id, name: call.name, result: '', error: 'oracle: question обязателен' }
    const res = await delegateTaskHandler.handle({ ...call, args: dargs }, ctx)
    return { ...res, name: call.name }
  }
}

// new_task (ось 3 H) — агент пакует дистиллят и просит чистый контекст. Сигналит прогону
// через ctx.requestNewTask; сама очистка currentMessages — в безопасной точке turn-цикла.
export const newTaskHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const summary = String(call.args.summary ?? '').trim()
    if (!summary) return { id: call.id, name: call.name, result: '', error: 'new_task: summary (дистиллят) обязателен' }
    if (!ctx.requestNewTask) return { id: call.id, name: call.name, result: '', error: 'new_task недоступен в этом контексте' }
    ctx.requestNewTask(summary)
    return { id: call.id, name: call.name, result: 'Контекст будет очищен до твоего дистиллята перед следующим шагом. Продолжай с чистого окна — у тебя только дистиллят и активный todo-лист.' }
  }
}

// ============================================================================
// delegate_parallel — мультиагент V2: параллельное выполнение N задач
// ============================================================================

export const delegateParallelHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const tasks = call.args.tasks as Array<{ id: string; prompt: string; provider_id?: string; model?: string; role?: string }> | undefined
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return { id: call.id, name: call.name, result: '', error: 'delegate_parallel: tasks обязателен и не должен быть пустым' }
      }
      // Потолок поднят до 50 (было 12): задачи держатся в глобальной очереди
      // (sub-queue), а одновременно стримит не больше GLOBAL_SUB_CONCURRENCY —
      // т.е. 50 в очереди не убивают провайдер. См. Фаза 2, Идея 6.
      const MAX_PARALLEL = 50
      if (tasks.length > MAX_PARALLEL) {
        return { id: call.id, name: call.name, result: '', error: `delegate_parallel: максимум ${MAX_PARALLEL} задач в одном батче` }
      }

      // Нормализация-дедуп task.id: subCallId = `${call.id}:${task.id}` должен быть
      // уникальным в батче, иначе карточки субагентов сливаются (upsert по callId)
      // и связь суб-сессий/дерева рушится. Пустой id → task-N, дубль → id#2/#3…
      dedupeTaskIds(tasks)

      // Фаза 4 (Идея 3): гейт глубины + общего числа агентов. Резервируем сразу
      // ВЕСЬ батч (tasks.length) — если квота/глубина не позволяют, не стартуем
      // вообще (иначе вложенный fan-out обошёл бы потолок). depth берётся из ctx.
      const depth = ctx.delegationDepth ?? 0
      if (ctx.agentCounter) {
        const gate = ctx.agentCounter.tryReserve(depth, tasks.length)
        if (!gate.allowed) {
          return { id: call.id, name: call.name, result: '', error: `delegate_parallel: ${gate.reason}` }
        }
      }

      // Группа/тег батча — для массовой отмены «по тегу» (Идея 6). Если не задан
      // явно — используем callId как авто-группу, чтобы можно было отменить весь
      // этот конкретный delegate_parallel разом.
      const groupTag = call.args.group ? String(call.args.group) : call.id

      // Cost-cap на весь батч (Идея 6): помимо cap всей сессии. Параметр
      // cost_cap_usd опционален; дефолт — DEFAULT_BATCH_COST_CAP_CENTS.
      const batchCapCents = typeof call.args.cost_cap_usd === 'number' && call.args.cost_cap_usd > 0
        ? Math.round(call.args.cost_cap_usd * 100)
        : DEFAULT_BATCH_COST_CAP_CENTS
      // Стартовая стоимость сессии — батч считаем как прирост сверх неё.
      const batchStartCents = ctx.subCostGuard?.current() ?? 0
      // Флаг «батч превысил cap» — взводится первой задачей, которая увидела
      // превышение; остальные ожидающие задачи в очереди не стартуют.
      let batchCapped = false

      const { createProvider, PROVIDERS } = await import('../../ai/registry')
      const { subAgentQueue, GLOBAL_SUB_CONCURRENCY } = await import('../../ai/sub-queue')

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: {
          type: 'tool-activity',
          callId: call.id,
          name: 'delegate_parallel',
          label: 'delegate_parallel',
          detail: `${tasks.length} задач (очередь, ≤${GLOBAL_SUB_CONCURRENCY} разом)`,
          status: 'ok'
        }
      })

      const { runSubAgentLoop } = await import('../../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../../ai/role-tools')

      // Запускаем ВСЕ задачи сразу — глобальный семафор сам ограничит реальную
      // одновременность. Это даёт честную очередь (а не локальные батчи по 4).
      const results = await Promise.allSettled(tasks.map(async (task) => {
        // Provider задаётся per-task → в одном батче можно смешивать разные
        // провайдеры (например API и CLI). Здесь каждая задача независимо
        // резолвит свой провайдер.
        const providerId = task.provider_id ?? ctx.currentProviderId ?? 'gemini-api'

        // subagent-run visibility (fan-out V2) — каждая параллельная задача
        // показывается как своя карточка. Distinct callId `${call.id}:${task.id}`
        // → upsert по callId, обновление status running → done/error в месте.
        const subCallId = `${call.id}:${task.id}`
        let toolCount = 0
        const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: {
              type: 'subagent-run',
              callId: subCallId,
              label: task.role ?? task.id,
              provider: providerId,
              role: task.role,
              toolCount,
              task: task.prompt,
              status,
              result
            }
          })
        }
        emitSubagent('running')

        // Персистентная суб-сессия (Идея 1). Каждая задача батча — своя сессия.
        let subSessionId: number | null = null
        if (ctx.subSessions) {
          try {
            subSessionId = ctx.subSessions.create({
              projectPath: ctx.projectPath,
              parentChatId: ctx.parentChatId ?? null,
              role: task.role ?? null, task: task.prompt, group: groupTag, callId: subCallId,
              providerId, model: task.model ?? null,
              depth: depth + 1, parentCallId: ctx.parentCallId ?? null
            })
            ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'user', task.prompt)
          } catch { /* persist не критично */ }
        }
        const finalizeSub = (status: string, assistant?: string) => {
          if (subSessionId == null || !ctx.subSessions) return
          try {
            if (assistant) ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'assistant', assistant)
            ctx.subSessions.update(subSessionId, { status, toolCount, endedAt: Date.now() })
          } catch { /* persist не критично */ }
        }

        const descriptor = PROVIDERS[providerId as keyof typeof PROVIDERS]
        if (!descriptor) {
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', `неизвестный provider ${providerId}`)
          finalizeSub('error')
          throw new Error(`неизвестный provider ${providerId}`)
        }
        const apiKey = descriptor.secretKey ? ctx.getSecretForDelegate?.(descriptor.secretKey) ?? null : null
        if (descriptor.secretKey && !apiKey) {
          ctx.agentCounter?.release(1)
          emitSubagent('error', `нет API key для ${providerId}`)
          finalizeSub('error')
          throw new Error(`нет API key для ${providerId}`)
        }

        // Per-task AbortController. Таймаут поднят с 60с до 180с — субагент
        // теперь крутит tool-loop. Родительский signal прерывает подзадачу.
        const taskAc = new AbortController()
        const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
        const parentAbortHandler = () => taskAc.abort()
        ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

        // Глобальная очередь: ждём слот. Если батч уже превысил cost-cap пока
        // мы стояли в очереди — не стартуем (экономим деньги).
        let queueSlot: { release: () => void; ticketId: number } | null = null
        try {
          queueSlot = await subAgentQueue.enter({ group: groupTag, role: task.role ?? null, abort: () => taskAc.abort() }, taskAc.signal)
        } catch {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'отменён в очереди')
          finalizeSub('cancelled')
          throw new Error('отменён в очереди')
        }
        if (batchCapped) {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          queueSlot.release()
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'батч остановлен по cost-cap')
          finalizeSub('cancelled')
          throw new Error('батч остановлен по cost-cap')
        }

        try {
          const subModel = task.model ?? descriptor.defaultModel
          const provider = createProvider(
            providerId as ProviderId,
            buildSubCreateOptions(providerId as ProviderId, apiKey, subModel, taskAc.signal, ctx)
          )
          const rolePrompt = task.role ? getRolePrompt(task.role) : null
          // Идея 8 (handoff): просим суб дать СТРУКТУРИРОВАННЫЙ итог, чтобы при
          // 20+ параллельных субах главный агент получал сжатые выводы, а не
          // простыни. researcher/verifier также сохраняют находки через memory_save.
          const baseContent = rolePrompt
            ?? 'Ты — sub-agent с доступом к инструментам (чтение файлов, поиск по проекту). Выполни узкую задачу, при необходимости используй tools, ответь по существу.'
          const systemContent = `${baseContent}\n\nВ финале дай СТРУКТУРИРОВАННЫЙ итог тремя короткими блоками:\nСДЕЛАЛ: ...\nНАШЁЛ: ...\nРЕКОМЕНДУЮ: ...\nКлючевые находки сохраняй через memory_save (если доступен).`
          const messages = [
            { role: 'system' as const, content: systemContent },
            { role: 'user' as const, content: task.prompt }
          ]
          // Whitelist tools по роли задачи + глубине (Фаза 4): суб-исполнитель
          // на разрешённой глубине может делегировать дальше.
          const allowedTools = getRoleToolset(task.role, { depth: depth + 1 })
          const subCtx: ToolContext = {
            ...ctx,
            signal: taskAc.signal,
            subProviderId: providerId as ProviderId,
            subModel,
            delegationDepth: depth + 1,
            parentCallId: subCallId
          }
          const res = await runSubAgentLoop({
            provider, messages, allowedToolNames: allowedTools, ctx: subCtx,
            signal: taskAc.signal, role: task.role,
            onToolActivity: () => { toolCount++; emitSubagent('running') }
          })
          // Cost-cap батча: после каждой задачи смотрим прирост стоимости сессии.
          // Превысили — взводим флаг + отменяем ещё бегущие/ждущие задачи группы.
          if (ctx.subCostGuard) {
            const spentByBatch = ctx.subCostGuard.current() - batchStartCents
            if (spentByBatch >= batchCapCents && !batchCapped) {
              batchCapped = true
              subAgentQueue.cancel({ group: groupTag })
            }
          }
          if (res.exitReason === 'error') { finalizeSub('error', res.text.trim() || undefined); throw new Error(res.error ?? 'sub-agent error') }
          const trimmed = res.text.trim()
          if (!trimmed) { finalizeSub('error'); throw new Error('sub-agent вернул пустой ответ') }
          emitSubagent('done', trimmed.length > 1200 ? trimmed.slice(0, 1200) + '…' : trimmed)
          finalizeSub(res.exitReason === 'aborted' ? 'cancelled' : 'done', trimmed)
          return { id: task.id, result: trimmed }
        } catch (taskErr) {
          // Любой неожиданный throw (createProvider, abort/timeout) — карточка
          // не должна застрять на 'running'. Rethrow → Promise.allSettled reject.
          emitSubagent('error', taskErr instanceof Error ? taskErr.message : String(taskErr))
          finalizeSub('error')
          throw taskErr
        } finally {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          queueSlot?.release()
        }
      }))

      const output = results.map((r, i) => {
        const taskId = tasks[i].id
        if (r.status === 'fulfilled') {
          return `## ${taskId}\n${r.value.result}`
        } else {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
          return `## ${taskId}\n❌ Ошибка: ${msg}`
        }
      }).join('\n\n---\n\n')

      const successCount = results.filter(r => r.status === 'fulfilled').length
      try {
        ctx.recordJournal(ctx.projectPath, 'note',
          `🔀 delegate_parallel — ${successCount}/${tasks.length} успешно${batchCapped ? ' (стоп по cost-cap батча)' : ''}`,
          tasks.map(t => t.id).join(', '))
      } catch { /* journal не критично */ }

      const capNote = batchCapped
        ? `\n\n---\n\n⚠️ Батч остановлен: превышен cost-cap $${(batchCapCents / 100).toFixed(2)} на один delegate_parallel. Оставшиеся задачи не выполнены.`
        : ''
      return { id: call.id, name: call.name, result: output + capNote }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// orchestrate — Smart Orchestrator + авто-декомпозиция (Фаза 3, Идея 5)
// ============================================================================

export interface DecomposedSubtask { id: string; prompt: string; role: string }

/**
 * Чистый парсер ответа планировщика → список подзадач. Устойчив: берёт первый
 * '[' … последний ']', валидирует роли, режет до maxSubtasks. Если распарсить не
 * удалось — фоллбэк: одна executor-подзадача = вся цель. Экспортируется для тестов.
 */
export function parseDecomposition(text: string, goal: string, maxSubtasks: number): DecomposedSubtask[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  let parsed: unknown = null
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { /* фоллбэк ниже */ }
  }
  const validRoles = new Set(['researcher', 'executor', 'verifier', 'critic', 'planner'])
  const tasks: DecomposedSubtask[] = []
  if (Array.isArray(parsed)) {
    for (let i = 0; i < parsed.length && tasks.length < maxSubtasks; i++) {
      const o = parsed[i]
      if (typeof o !== 'object' || o === null) continue
      const r = o as Record<string, unknown>
      const prompt = String(r.prompt ?? '').trim()
      if (!prompt) continue
      const role = validRoles.has(String(r.role)) ? String(r.role) : 'executor'
      const id = String(r.id ?? `task-${i + 1}`).slice(0, 40) || `task-${i + 1}`
      tasks.push({ id, prompt, role })
    }
  }
  if (tasks.length === 0) {
    tasks.push({ id: 'task-1', prompt: goal, role: 'executor' })
  }
  return tasks
}

/**
 * Декомпозиция цели через вызов модели-планировщика. Просим вернуть JSON-массив
 * подзадач с ролями. Парс — через чистый parseDecomposition (тестируемый).
 */
export async function decomposeGoal(
  goal: string,
  maxSubtasks: number,
  providerId: ProviderId,
  apiKey: string | null,
  model: string,
  ctx: ToolContext,
  signal: AbortSignal
): Promise<DecomposedSubtask[]> {
  const { createProvider } = await import('../../ai/registry')
  // buildSubCreateOptions добирает yandexFolderId/gigachatClientSecret/customBaseUrl/
  // claudeOauthToken под российские/custom провайдеры (Фаза 1 helper).
  const provider = createProvider(providerId, buildSubCreateOptions(providerId, apiKey, model, signal, ctx))
  const sys = 'Ты — планировщик-декомпозитор. Разбей цель пользователя на независимые подзадачи, каждую с ролью из набора: researcher (анализ/поиск), executor (правка кода), verifier (проверка), critic (ревью), planner (под-план). Верни СТРОГО JSON-массив объектов {"id": "краткий-id", "prompt": "что сделать", "role": "роль"} и ничего больше. Подзадачи должны быть атомарными и параллелизуемыми.'
  const user = `Цель: ${goal}\n\nМаксимум подзадач: ${maxSubtasks}. Верни только JSON-массив.`
  let text = ''
  for await (const event of provider.send([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ], [], undefined, signal)) {
    if (signal.aborted) break
    if (event.type === 'text' && typeof event.text === 'string') text += event.text
    else if (event.type === 'usage' && event.usage) {
      // Токены планировщика — платный API-вызов до старта батча. Учитываем их в
      // session cost guard, иначе orchestrate недосчитывает стоимость (асимметрия
      // с runSubAgentLoop, который usage обрабатывает). providerId/model здесь =
      // baseProviderId/plannerModel из orchestrate, поэтому модель совпадёт с PRICES.
      const guard = ctx.subCostGuard
      if (guard) {
        // 2.0.8-E commit 2 (ревью-находка): decomposeGoal — 5-й денежный потребитель, карточка его
        // пропустила. Без inputAccounting дефект B жил бы здесь для Claude (planner на exclusive).
        guard.recordAndCheck(providerId, model, event.usage.inputTokens ?? null, event.usage.outputTokens ?? null, event.usage.cacheReadTokens ?? event.usage.cachedInputTokens ?? null, event.usage.inputAccounting)
      }
    }
    else if (event.type === 'error') throw new Error(event.message)
    else if (event.type === 'done') break
  }
  return parseDecomposition(text, goal, maxSubtasks)
}

export const orchestrateHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const goal = String(call.args.goal ?? '').trim()
      if (!goal) {
        return { id: call.id, name: call.name, result: '', error: 'orchestrate: goal обязателен' }
      }
      const maxSubtasks = Math.max(1, Math.min(12, typeof call.args.max_subtasks === 'number' ? Math.floor(call.args.max_subtasks) : 5))
      const batchCapCents = typeof call.args.cost_cap_usd === 'number' && call.args.cost_cap_usd > 0
        ? Math.round(call.args.cost_cap_usd * 100)
        : DEFAULT_BATCH_COST_CAP_CENTS

      const { createProvider, PROVIDERS } = await import('../../ai/registry')
      const { estimateComplexity, recommendModel } = await import('../../ai/smart-router')
      const { runSubAgentLoop } = await import('../../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../../ai/role-tools')
      const { getRolePrompt } = await import('../../ai/agent-roles')
      const { subAgentQueue } = await import('../../ai/sub-queue')

      const baseProviderId = (ctx.currentProviderId ?? 'gemini-api') as ProviderId
      const descriptor = PROVIDERS[baseProviderId]
      if (!descriptor) {
        return { id: call.id, name: call.name, result: '', error: `orchestrate: неизвестный provider ${baseProviderId}` }
      }
      const apiKey = descriptor.secretKey ? ctx.getSecretForDelegate?.(descriptor.secretKey) ?? null : null
      if (descriptor.secretKey && !apiKey) {
        return { id: call.id, name: call.name, result: '', error: `orchestrate: нет API key для ${baseProviderId}` }
      }

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'orchestrate', label: 'orchestrate', detail: `декомпозиция цели · ${baseProviderId}`, status: 'ok' }
      })

      // 1) Декомпозиция через модель-планировщик (дешёвая модель достаточна).
      const plannerModel = recommendModel(baseProviderId, 'moderate') ?? descriptor.defaultModel
      const subtasks = await decomposeGoal(goal, maxSubtasks, baseProviderId, apiKey, plannerModel, ctx, ctx.signal)
      // Дедуп id подзадач — планировщик-модель может выдать одинаковые id, а
      // subCallId = `${call.id}:${task.id}` должен быть уникальным (см. dedupeTaskIds).
      dedupeTaskIds(subtasks)

      // 2) Создаём todo-лист из подзадач (TodoGate, Идея 2 — связь).
      if (ctx.sessionTodos) {
        try {
          ctx.sessionTodos.createBatch({
            projectPath: ctx.projectPath, sessionId: ctx.parentChatId ?? null,
            goal, titles: subtasks.map(t => `[${t.role}] ${t.prompt.slice(0, 120)}`)
          })
          ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'todo-updated' } })
        } catch { /* todo не критично для прогона */ }
      }

      // Группа батча = callId оркестратора (массовая отмена через панель).
      const groupTag = call.id
      const batchStartCents = ctx.subCostGuard?.current() ?? 0
      let batchCapped = false

      // Фаза 4: оркестратор работает на глубине главного агента (depth 0) и
      // порождает субов depth 1. Резервируем всё дерево подзадач в общий счётчик.
      const depth = ctx.delegationDepth ?? 0
      if (ctx.agentCounter) {
        const gate = ctx.agentCounter.tryReserve(depth, subtasks.length)
        if (!gate.allowed) {
          return { id: call.id, name: call.name, result: '', error: `orchestrate: ${gate.reason}` }
        }
      }

      // 3) Параллельный запуск подзадач с умным выбором модели на каждую.
      const results = await Promise.allSettled(subtasks.map(async (task) => {
        // Smart-router: оцениваем сложность подзадачи по её промпту → модель.
        // Простую → дешёвая модель, сложную → дорогая (полный verstak recommendModel).
        const complexity = estimateComplexity([{ role: 'user', content: task.prompt }], [])
        const subModel = recommendModel(baseProviderId, complexity) ?? descriptor.defaultModel

        const subCallId = `${call.id}:${task.id}`
        let toolCount = 0
        const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: { type: 'subagent-run', callId: subCallId, label: `${task.role} (${complexity})`, provider: baseProviderId, role: task.role, toolCount, task: task.prompt, status, result }
          })
        }
        emitSubagent('running')

        let subSessionId: number | null = null
        if (ctx.subSessions) {
          try {
            subSessionId = ctx.subSessions.create({
              projectPath: ctx.projectPath, parentChatId: ctx.parentChatId ?? null,
              role: task.role, task: task.prompt, group: groupTag, callId: subCallId,
              providerId: baseProviderId, model: subModel,
              depth: depth + 1, parentCallId: ctx.parentCallId ?? call.id
            })
            ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'user', task.prompt)
          } catch { /* persist не критично */ }
        }
        const finalizeSub = (status: string, assistant?: string) => {
          if (subSessionId == null || !ctx.subSessions) return
          try {
            if (assistant) ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'assistant', assistant)
            ctx.subSessions.update(subSessionId, { status, toolCount, endedAt: Date.now() })
          } catch { /* persist не критично */ }
        }

        const taskAc = new AbortController()
        const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
        const parentAbortHandler = () => taskAc.abort()
        ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

        let queueSlot: { release: () => void; ticketId: number } | null = null
        try {
          queueSlot = await subAgentQueue.enter({ group: groupTag, role: task.role, abort: () => taskAc.abort() }, taskAc.signal)
        } catch {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'отменён в очереди')
          finalizeSub('cancelled')
          throw new Error('отменён в очереди')
        }
        if (batchCapped) {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          queueSlot.release()
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'остановлен по cost-cap')
          finalizeSub('cancelled')
          throw new Error('остановлен по cost-cap')
        }

        try {
          const provider = createProvider(
            baseProviderId,
            buildSubCreateOptions(baseProviderId, apiKey, subModel, taskAc.signal, ctx)
          )
          // Идея 8: просим суб выдать СТРУКТУРИРОВАННЫЙ итог (handoff-формат), чтобы
          // главный агент получал сжатые выводы, а не простыни при 20+ субах.
          const rolePrompt = getRolePrompt(task.role) ?? 'Ты — sub-agent с доступом к инструментам.'
          const systemContent = `${rolePrompt}\n\nВ финале дай СТРУКТУРИРОВАННЫЙ итог тремя короткими блоками:\nСДЕЛАЛ: ...\nНАШЁЛ: ...\nРЕКОМЕНДУЮ: ...\nКлючевые находки сохраняй через memory_save (если доступен).`
          const allowedTools = getRoleToolset(task.role, { depth: depth + 1 })
          const subCtx: ToolContext = {
            ...ctx, signal: taskAc.signal,
            subProviderId: baseProviderId, subModel,
            delegationDepth: depth + 1,
            parentCallId: subCallId
          }
          const res = await runSubAgentLoop({
            provider, messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: task.prompt }
            ], allowedToolNames: allowedTools, ctx: subCtx, signal: taskAc.signal, role: task.role,
            onToolActivity: () => { toolCount++; emitSubagent('running') }
          })
          if (ctx.subCostGuard) {
            const spent = ctx.subCostGuard.current() - batchStartCents
            if (spent >= batchCapCents && !batchCapped) {
              batchCapped = true
              subAgentQueue.cancel({ group: groupTag })
            }
          }
          if (res.exitReason === 'error') { finalizeSub('error', res.text.trim() || undefined); throw new Error(res.error ?? 'sub-agent error') }
          const trimmed = res.text.trim()
          if (!trimmed) { finalizeSub('error'); throw new Error('sub-agent вернул пустой ответ') }
          emitSubagent('done', trimmed.length > 1200 ? trimmed.slice(0, 1200) + '…' : trimmed)
          finalizeSub(res.exitReason === 'aborted' ? 'cancelled' : 'done', trimmed)
          return { id: task.id, role: task.role, model: subModel, result: trimmed }
        } catch (taskErr) {
          emitSubagent('error', taskErr instanceof Error ? taskErr.message : String(taskErr))
          finalizeSub('error')
          throw taskErr
        } finally {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          queueSlot?.release()
        }
      }))

      // 4) Сжатый handoff главному агенту: по подзадаче — роль/модель + итог суба.
      const successCount = results.filter(r => r.status === 'fulfilled').length
      const blocks = results.map((r, i) => {
        const t = subtasks[i]
        if (r.status === 'fulfilled') {
          return `## ${t.id} — ${r.value.role} (${r.value.model})\n${r.value.result}`
        }
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
        return `## ${t.id} — ${t.role}\n❌ ${msg}`
      }).join('\n\n---\n\n')

      try {
        ctx.recordJournal(ctx.projectPath, 'note',
          `🧭 orchestrate — ${successCount}/${subtasks.length} подзадач${batchCapped ? ' (стоп по cost-cap)' : ''}`,
          `Цель: ${goal.slice(0, 200)}\nРоли: ${subtasks.map(t => t.role).join(', ')}`)
      } catch { /* journal не критично */ }

      const capNote = batchCapped ? `\n\n---\n\n⚠️ Оркестратор остановлен: превышен cost-cap $${(batchCapCents / 100).toFixed(2)}.` : ''
      const header = `🧭 Оркестратор разбил цель на ${subtasks.length} подзадач (${successCount} успешно). Сводка выводов:\n\n`
      return { id: call.id, name: call.name, result: header + blocks + capNote }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// swarm — Agent Swarms с консенсусом-арбитром (Фаза 4, Идея 10)
// ============================================================================

export interface SwarmMember { id: string; role: string; angle: string }

/**
 * Чистый билдер ростера роя: одна цель → N агентов, атакующих её с РАЗНЫХ углов.
 * В отличие от orchestrate (декомпозиция на подзадачи) рой делает N независимых
 * ПОПЫТОК решить ту же цель целиком + критика. Углы детерминированы (тестируется).
 *
 * Состав для size=4: 2 executor с разными стратегиями + 1 researcher + 1 critic.
 * Масштабируется: лишние слоты — дополнительные executor-варианты с новыми углами.
 */
export function buildSwarmRoster(size: number): SwarmMember[] {
  const n = Math.max(2, Math.min(8, Math.floor(size) || 4))
  // Углы-стратегии для executor-вариантов — разные «характеры» решения.
  const angles = [
    'самое прямое и минимальное решение',
    'максимально надёжное решение с проверкой edge cases',
    'решение с упором на читаемость и поддерживаемость',
    'нестандартный подход — найди обходной/более простой путь',
    'решение с упором на производительность',
    'решение с упором на безопасность и валидацию входных данных'
  ]
  const members: SwarmMember[] = []
  // Первый слот — researcher (соберёт контекст под общую цель).
  members.push({ id: 'scout', role: 'researcher', angle: 'разведка: собери релевантный контекст и ограничения для цели' })
  // Последний слот — critic (оценит варианты независимо).
  // Между ними — executor-варианты с разными углами.
  const executorSlots = n - 2  // минус researcher и critic
  for (let i = 0; i < executorSlots; i++) {
    members.push({ id: `solver-${i + 1}`, role: 'executor', angle: angles[i % angles.length] })
  }
  members.push({ id: 'critic', role: 'critic', angle: 'найди слабые места во всех подходах к цели' })
  return members
}

export const swarmHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const goal = String(call.args.goal ?? '').trim()
      if (!goal) {
        return { id: call.id, name: call.name, result: '', error: 'swarm: goal обязателен' }
      }
      const strategy = call.args.strategy ? String(call.args.strategy).trim() : ''
      // T1.2: opt-in изоляция executor'ов в отдельных git-worktree, чтобы их
      // параллельные правки не клобберили друг друга на диске. По умолчанию OFF.
      const isolate = call.args.isolate === true
      const roster = buildSwarmRoster(typeof call.args.size === 'number' ? call.args.size : 4)
      // Дедуп id членов роя — buildSwarmRoster даёт уникальные id по построению,
      // но subCallId = `${call.id}:${m.id}` требует гарантии (см. dedupeTaskIds).
      dedupeTaskIds(roster, 'member')
      const batchCapCents = typeof call.args.cost_cap_usd === 'number' && call.args.cost_cap_usd > 0
        ? Math.round(call.args.cost_cap_usd * 100)
        : DEFAULT_BATCH_COST_CAP_CENTS

      const { createProvider, PROVIDERS } = await import('../../ai/registry')
      const { runSubAgentLoop } = await import('../../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../../ai/role-tools')
      const { getRolePrompt } = await import('../../ai/agent-roles')
      const { subAgentQueue } = await import('../../ai/sub-queue')
      // T1.2: для isolate — отдельный FileTools, заруленный на worktree executor'а.
      const { createToolsForProject } = await import('../../ai/tools')

      const baseProviderId = (ctx.currentProviderId ?? 'gemini-api') as ProviderId
      const descriptor = PROVIDERS[baseProviderId]
      if (!descriptor) {
        return { id: call.id, name: call.name, result: '', error: `swarm: неизвестный provider ${baseProviderId}` }
      }
      const apiKey = descriptor.secretKey ? ctx.getSecretForDelegate?.(descriptor.secretKey) ?? null : null
      if (descriptor.secretKey && !apiKey) {
        return { id: call.id, name: call.name, result: '', error: `swarm: нет API key для ${baseProviderId}` }
      }

      // Фаза 4 (Идея 3): резервируем весь рой + арбитра в общий счётчик агентов.
      // Рой работает на depth главного агента; его члены — depth+1.
      const depth = ctx.delegationDepth ?? 0
      if (ctx.agentCounter) {
        const gate = ctx.agentCounter.tryReserve(depth, roster.length + 1) // +1 арбитр
        if (!gate.allowed) {
          return { id: call.id, name: call.name, result: '', error: `swarm: ${gate.reason}` }
        }
      }

      // Группа батча = callId роя (массовая отмена через панель). UI пометит группу.
      const groupTag = call.id
      const batchStartCents = ctx.subCostGuard?.current() ?? 0
      let batchCapped = false

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'swarm', label: 'swarm', detail: `рой из ${roster.length} + арбитр · ${baseProviderId}`, status: 'ok' }
      })

      const runMember = async (m: SwarmMember) => {
        const subCallId = `${call.id}:${m.id}`
        let toolCount = 0
        const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: { type: 'subagent-run', callId: subCallId, label: `🐝 ${m.role}/${m.id}`, provider: baseProviderId, role: m.role, swarm: groupTag, toolCount, task: goal, status, result }
          })
        }
        emitSubagent('running')

        let subSessionId: number | null = null
        if (ctx.subSessions) {
          try {
            subSessionId = ctx.subSessions.create({
              projectPath: ctx.projectPath, parentChatId: ctx.parentChatId ?? null,
              role: m.role, task: `[swarm] ${goal}`, group: groupTag, callId: subCallId,
              providerId: baseProviderId, model: descriptor.defaultModel,
              depth: depth + 1, parentCallId: ctx.parentCallId ?? call.id
            })
            ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'user', goal)
          } catch { /* persist не критично */ }
        }
        const finalizeSub = (status: string, assistant?: string) => {
          if (subSessionId == null || !ctx.subSessions) return
          try {
            if (assistant) ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'assistant', assistant)
            ctx.subSessions.update(subSessionId, { status, toolCount, endedAt: Date.now() })
          } catch { /* persist не критично */ }
        }

        const taskAc = new AbortController()
        const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
        const parentAbortHandler = () => taskAc.abort()
        ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

        let queueSlot: { release: () => void; ticketId: number } | null = null
        try {
          queueSlot = await subAgentQueue.enter({ group: groupTag, role: m.role, abort: () => taskAc.abort() }, taskAc.signal)
        } catch {
          clearTimeout(timeoutId); ctx.signal.removeEventListener('abort', parentAbortHandler)
          ctx.agentCounter?.release(1)  // член роя не стартовал — возвращаем слот
          emitSubagent('error', 'отменён в очереди'); finalizeSub('cancelled')
          throw new Error('отменён в очереди')
        }
        if (batchCapped) {
          clearTimeout(timeoutId); ctx.signal.removeEventListener('abort', parentAbortHandler); queueSlot.release()
          ctx.agentCounter?.release(1)  // член роя не стартовал — возвращаем слот
          emitSubagent('error', 'остановлен по cost-cap'); finalizeSub('cancelled')
          throw new Error('остановлен по cost-cap')
        }

        // T1.2: executor — в изолированный worktree (если isolate). researcher/critic
        // читают/ревьюят, изоляция не нужна. Не git / ошибка add → memberRoot=main (graceful).
        let worktree: string | null = null
        let memberRoot = ctx.projectPath
        let memberTools = ctx.tools
        if (isolate && m.role === 'executor') {
          worktree = addWorktree(ctx.projectPath, m.id)
          if (worktree) {
            memberRoot = worktree
            // КЛЮЧЕВОЕ: пере-рутим FileTools на worktree — иначе write_file/apply_patch/
            // run_command субагента шли бы в ГЛАВНОЕ дерево и изоляция была бы инертна
            // (executor'ы клобберили бы один main-файл, а diff читался бы из пустого wt).
            memberTools = createToolsForProject(memberRoot, taskAc.signal)
          }
        }
        try {
          const provider = createProvider(
            baseProviderId,
            buildSubCreateOptions(baseProviderId, apiKey, descriptor.defaultModel, taskAc.signal, { ...ctx, projectPath: memberRoot })
          )
          const rolePrompt = getRolePrompt(m.role) ?? 'Ты — sub-agent с доступом к инструментам.'
          // Угол/стратегия члена роя + общая стратегия-подсказка → разнообразие попыток.
          const strategyLine = strategy ? `\nОбщая стратегия роя: ${strategy}.` : ''
          const systemContent = `${rolePrompt}\n\nТы — участник РОЯ агентов, работающих над ОДНОЙ целью независимо. Твой угол: ${m.angle}.${strategyLine}\n\nДай законченный вариант решения/вывода по цели целиком (не часть). В финале — краткий итог: ПОДХОД / РЕЗУЛЬТАТ / РИСКИ.`
          const allowedTools = getRoleToolset(m.role, { depth: depth + 1 })
          const subCtx: ToolContext = {
            ...ctx, projectPath: memberRoot, tools: memberTools, signal: taskAc.signal,
            subProviderId: baseProviderId, subModel: descriptor.defaultModel,
            delegationDepth: depth + 1, parentCallId: subCallId
          }
          const res = await runSubAgentLoop({
            provider, messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: goal }
            ], allowedToolNames: allowedTools, ctx: subCtx, signal: taskAc.signal, role: m.role,
            onToolActivity: () => { toolCount++; emitSubagent('running') }
          })
          if (ctx.subCostGuard) {
            const spent = ctx.subCostGuard.current() - batchStartCents
            if (spent >= batchCapCents && !batchCapped) { batchCapped = true; subAgentQueue.cancel({ group: groupTag }) }
          }
          if (res.exitReason === 'error') { finalizeSub('error', res.text.trim() || undefined); throw new Error(res.error ?? 'swarm member error') }
          const trimmed = res.text.trim()
          if (!trimmed) { finalizeSub('error'); throw new Error('участник роя вернул пустой ответ') }
          // T1.2: приложить git diff изолированного worktree → арбитр видит реальные
          // изменения, а не только текст. Главный агент применит выбранный в main.
          let result = trimmed
          if (worktree) {
            const diff = worktreeDiff(worktree)
            result = diff.trim()
              ? `${trimmed}\n\n--- ИЗМЕНЕНИЯ (git diff изолированного worktree) ---\n${diff.length > MAX_WORKTREE_DIFF_CHARS ? diff.slice(0, MAX_WORKTREE_DIFF_CHARS) + '\n…(diff обрезан)' : diff}`
              : `${trimmed}\n\n(изолированный worktree — файловых изменений нет)`
          }
          emitSubagent('done', result.length > 1200 ? result.slice(0, 1200) + '…' : result)
          finalizeSub(res.exitReason === 'aborted' ? 'cancelled' : 'done', result)
          return { id: m.id, role: m.role, angle: m.angle, result }
        } catch (taskErr) {
          emitSubagent('error', taskErr instanceof Error ? taskErr.message : String(taskErr))
          finalizeSub('error')
          throw taskErr
        } finally {
          clearTimeout(timeoutId); ctx.signal.removeEventListener('abort', parentAbortHandler); queueSlot?.release()
          // T1.2: cleanup worktree (diff уже снят в result). best-effort.
          if (worktree) { try { removeWorktree(ctx.projectPath, worktree) } catch { /* best-effort */ } }
        }
      }

      // 1) Запускаем рой параллельно (через общий семафор/очередь).
      const settled = await Promise.allSettled(roster.map(runMember))
      const variants = settled
        .map((r, i) => r.status === 'fulfilled'
          ? { id: roster[i].id, role: roster[i].role, angle: roster[i].angle, result: r.value.result }
          : null)
        .filter((v): v is { id: string; role: string; angle: string; result: string } => v !== null)

      if (variants.length === 0) {
        ctx.agentCounter?.release(1)  // арбитр (+1 в резерве) не стартует — возвращаем слот
        const errs = settled.map((r, i) => r.status === 'rejected' ? `${roster[i].id}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}` : '').filter(Boolean)
        return { id: call.id, name: call.name, result: '', error: `swarm: ни один агент роя не дал результат. ${errs.join('; ')}` }
      }

      // 2) АРБИТР: отдельный агент собирает варианты, оценивает и синтезирует
      // консенсус. Read-only (роль critic) — он не правит код, только выбирает/
      // синтезирует. Если арбитр упал — фоллбэк: вернуть все варианты главному.
      const variantsBlock = variants
        .map((v, i) => `### Вариант ${i + 1} — ${v.role}/${v.id} (угол: ${v.angle})\n${v.result}`)
        .join('\n\n')
      const arbiterSystem = isolate
        ? 'Ты — АРБИТР роя агентов. Каждый вариант содержит решение + git diff изменений в изолированном worktree. Оцени варианты, выбери ЛУЧШИЙ (или укажи какие части каких вариантов объединить). Верни: 1) ВЫБОР — какой вариант (по id) применить и какие именно файлы/правки взять из его diff; 2) ОБОСНОВАНИЕ (1-3 строки). Главный агент применит выбранные изменения в основном дереве сам — будь конкретен.'
        : 'Ты — АРБИТР роя агентов. Тебе дают несколько независимых вариантов решения ОДНОЙ цели. Твоя задача: оценить их, выбрать лучший ИЛИ синтезировать консенсус из сильных сторон нескольких. Верни: 1) КОНСЕНСУС — итоговое лучшее решение цели (готовое к использованию); 2) ОБОСНОВАНИЕ — на каких вариантах оно основано и почему (1-3 строки). Будь решительным: один чёткий результат, а не пересказ всех.'
      const arbiterUser = `Цель: ${goal}\n\nВарианты роя (${variants.length}):\n\n${variantsBlock}\n\nВыбери/синтезируй лучший консенсусный результат.`

      let consensus = ''
      let arbiterOk = false
      const arbiterCallId = `${call.id}:arbiter`
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'subagent-run', callId: arbiterCallId, label: '⚖️ arbiter', provider: baseProviderId, role: 'critic', swarm: groupTag, toolCount: 0, task: `консенсус из ${variants.length} вариантов`, status: 'running' }
      })
      let arbiterSessionId: number | null = null
      if (ctx.subSessions) {
        try {
          arbiterSessionId = ctx.subSessions.create({
            projectPath: ctx.projectPath, parentChatId: ctx.parentChatId ?? null,
            role: 'arbiter', task: `[swarm-arbiter] ${goal}`, group: groupTag, callId: arbiterCallId,
            providerId: baseProviderId, model: descriptor.defaultModel,
            depth: depth + 1, parentCallId: ctx.parentCallId ?? call.id
          })
          ctx.subSessions.appendMessage(arbiterSessionId, ctx.projectPath, 'user', arbiterUser)
        } catch { /* persist не критично */ }
      }
      // Per-task таймаут арбитра — тот же паттерн, что у членов роя (runMember).
      // Без него зависший арбитрский провайдер вешал swarm до ручной отмены
      // всего ai:send: signal === ctx.signal не обрывается по таймауту.
      const arbAc = new AbortController()
      const arbTimeoutId = setTimeout(() => arbAc.abort(), SUB_TASK_TIMEOUT_MS)
      const arbAbortHandler = () => arbAc.abort()
      ctx.signal.addEventListener('abort', arbAbortHandler, { once: true })
      try {
        const arbiterProvider = createProvider(
          baseProviderId,
          buildSubCreateOptions(baseProviderId, apiKey, descriptor.defaultModel, arbAc.signal, ctx)
        )
        // Арбитр — read-only (никаких правок при синтезе).
        const res = await runSubAgentLoop({
          provider: arbiterProvider,
          messages: [{ role: 'system', content: arbiterSystem }, { role: 'user', content: arbiterUser }],
          allowedToolNames: getRoleToolset('critic', { depth: depth + 1 }),
          ctx: { ...ctx, subProviderId: baseProviderId, subModel: descriptor.defaultModel, delegationDepth: depth + 1, parentCallId: arbiterCallId },
          signal: arbAc.signal, role: 'critic'
        })
        consensus = res.text.trim()
        arbiterOk = res.exitReason !== 'error' && consensus.length > 0
        ctx.sender.send('ai:event', {
          id: ctx.sendId,
          event: { type: 'subagent-run', callId: arbiterCallId, label: '⚖️ arbiter', provider: baseProviderId, role: 'critic', swarm: groupTag, toolCount: 0, task: `консенсус из ${variants.length} вариантов`, status: arbiterOk ? 'done' : 'error', result: consensus.slice(0, 1200) } })
        if (arbiterSessionId != null && ctx.subSessions) {
          try {
            if (consensus) ctx.subSessions.appendMessage(arbiterSessionId, ctx.projectPath, 'assistant', consensus)
            ctx.subSessions.update(arbiterSessionId, { status: arbiterOk ? 'done' : 'error', endedAt: Date.now() })
          } catch { /* persist не критично */ }
        }
      } catch (arbErr) {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'subagent-run', callId: arbiterCallId, label: '⚖️ arbiter', provider: baseProviderId, role: 'critic', swarm: groupTag, toolCount: 0, task: 'консенсус', status: 'error', result: arbErr instanceof Error ? arbErr.message : String(arbErr) } })
        if (arbiterSessionId != null && ctx.subSessions) {
          try { ctx.subSessions.update(arbiterSessionId, { status: 'error', endedAt: Date.now() }) } catch { /* */ }
        }
      } finally {
        clearTimeout(arbTimeoutId)
        ctx.signal.removeEventListener('abort', arbAbortHandler)
      }

      try {
        ctx.recordJournal(ctx.projectPath, 'note',
          `🐝 swarm — ${variants.length}/${roster.length} вариантов${arbiterOk ? ' + консенсус арбитра' : ' (арбитр не дал ответ)'}${batchCapped ? ' (стоп по cost-cap)' : ''}`,
          `Цель: ${goal.slice(0, 200)}`)
      } catch { /* journal не критично */ }

      const capNote = batchCapped ? `\n\n⚠️ Рой остановлен: превышен cost-cap $${(batchCapCents / 100).toFixed(2)}.` : ''
      if (arbiterOk) {
        return { id: call.id, name: call.name, result: `🐝 Рой из ${variants.length} агентов → консенсус арбитра:\n\n${consensus}${capNote}` }
      }
      // Фоллбэк: арбитр не справился — отдаём главному все варианты, пусть решит сам.
      return { id: call.id, name: call.name, result: `🐝 Рой дал ${variants.length} вариантов (арбитр не синтезировал консенсус — выбери лучший сам):\n\n${variantsBlock}${capNote}` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
