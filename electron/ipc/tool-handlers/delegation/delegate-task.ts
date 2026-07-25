import type { ToolHandler, ToolContext } from '../shared'
import type { ProviderId } from '../../../ai/registry'
import { getRolePrompt } from '../../../ai/agent-roles'
import { findUserAgent } from '../../../ai/user-agents'
import type { AgentJobV1 } from '../../../../shared/contracts/agent-job'
import {
  acquireDurableJob,
  finishDurableJob,
  linkDurableJob,
  markDurableJobRunning,
  roleWriteScope,
  scopesFromArgs,
  startDurableJob,
} from './job-runtime'
import {
  SUB_TASK_TIMEOUT_MS,
  buildSubCreateOptions,
} from './common'

export const delegateTaskHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    let durableJob: AgentJobV1 | null = null
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
            jobId: durableJob?.id,
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

      const { createProvider, PROVIDERS } = await import('../../../ai/registry')
      const { runSubAgentLoop } = await import('../../../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../../../ai/role-tools')
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
      const resolvedModel = subModel ?? descriptor.defaultModel
      const scopes = scopesFromArgs(call.args)
      durableJob = startDurableJob(ctx, {
        kind: 'delegate',
        role: role ?? 'executor',
        goal: prompt,
        providerId: fallbackProvider,
        model: resolvedModel,
        callId: call.id,
        groupId: call.args.group ? String(call.args.group) : null,
        readScope: scopes.readScope,
        writeScope: roleWriteScope(role, scopes.writeScope),
      })
      durableJob = linkDurableJob(ctx, durableJob, { subSessionId })
      emitSubagent('running')

      const taskAc = new AbortController()
      const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
      const parentAbortHandler = () => taskAc.abort()
      ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

      // Глобальная очередь (Идея 6): ждём слот в семафоре процесса. Группа —
      // опциональный group-тег, чтобы суб можно было отменить массово.
      const { subAgentQueue } = await import('../../../ai/sub-queue')
      const groupTag = call.args.group ? String(call.args.group) : null
      let queueSlot: { release: () => void; ticketId: number } | null = null
      let jobLease: Awaited<ReturnType<typeof acquireDurableJob>> = null
      try {
        jobLease = await acquireDurableJob(ctx, durableJob, taskAc.signal, () => taskAc.abort())
        if (jobLease) durableJob = jobLease.job
        else {
          queueSlot = await subAgentQueue.enter({ group: groupTag, role, abort: () => taskAc.abort() }, taskAc.signal)
          durableJob = markDurableJobRunning(ctx, durableJob)
        }
      } catch {
        clearTimeout(timeoutId)
        ctx.signal.removeEventListener('abort', parentAbortHandler)
        ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
        emitSubagent('error', 'отменён в очереди')
        finalizeSub('cancelled')
        finishDurableJob(ctx, durableJob, 'cancelled', 'cancelled in queue')
        return { id: call.id, name: call.name, result: '', error: 'delegate_task: задача отменена в очереди' }
      }

      try {
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
        const { SUBAGENT_FORBIDDEN_TOOLS } = await import('../../../ai/role-tools')
        const allowedTools = (userAgent && userAgent.tools.length)
          ? userAgent.tools.filter(t => !SUBAGENT_FORBIDDEN_TOOLS.has(t))
          : getRoleToolset(role, { depth: depth + 1 })
        const subCtx: ToolContext = {
          ...ctx,
          subProviderId: fallbackProvider as ProviderId,
          subModel: resolvedModel,
          // Дерево делегирования: суб глубже на 1, его родитель — этот вызов.
          delegationDepth: depth + 1,
          parentCallId: call.id,
          parentJobId: durableJob?.id ?? ctx.parentJobId ?? null
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
          finishDurableJob(ctx, durableJob, 'failed', res.error ?? 'delegate_task error')
          // Timeline задачи (Фаза 4): делегирование завершилось ошибкой.
          try { ctx.recordRunEvent?.('delegate', { label: subLabel, detail: res.error, ref: call.id, status: 'error' }) } catch { /* best-effort */ }
          return { id: call.id, name: call.name, result: '', error: `delegate_task error: ${res.error}` }
        }
        const trimmed = res.text.trim()
        if (!trimmed) {
          emitSubagent('error', 'sub-agent вернул пустой ответ')
          finalizeSub('error')
          finishDurableJob(ctx, durableJob, 'failed', 'sub-agent returned an empty response')
          try { ctx.recordRunEvent?.('delegate', { label: subLabel, detail: 'пустой ответ', ref: call.id, status: 'error' }) } catch { /* best-effort */ }
          return { id: call.id, name: call.name, result: '', error: 'delegate_task: sub-agent вернул пустой ответ' }
        }
        emitSubagent('done', trimmed.length > 1200 ? trimmed.slice(0, 1200) + '…' : trimmed)
        finalizeSub(res.exitReason === 'aborted' ? 'cancelled' : 'done', trimmed)
        finishDurableJob(
          ctx,
          durableJob,
          res.exitReason === 'aborted' ? 'cancelled' : 'succeeded',
          trimmed,
          {
            changedFiles: subCtx.runFilesTouched?.() ?? [],
            checks: (subCtx.runChecks?.() ?? []).map(check => ({
              command: check.command,
              status: check.exitCode === 0 ? 'passed' : 'failed',
              exitCode: check.exitCode,
            })),
          },
        )
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
        jobLease?.release()
        queueSlot?.release()
      }
    } catch (err) {
      finishDurableJob(ctx, durableJob, 'failed', err instanceof Error ? err.message : String(err))
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

