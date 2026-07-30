import type { ToolHandler, ToolContext } from '../shared'
import type { ProviderId } from '../../../ai/registry'
import { addWorktree, removeWorktree, worktreeDiff } from '../../../ai/git-worktree'
import type { AgentJobV1 } from '../../../../shared/contracts/agent-job'
import {
  acquireDurableJob,
  finishDurableJob,
  linkDurableJob,
  markDurableJobRunning,
  roleWriteScope,
  startDurableJob,
} from './job-runtime'
import {
  DEFAULT_BATCH_COST_CAP_CENTS,
  SUB_TASK_TIMEOUT_MS,
  buildSubCreateOptions,
  resolveSubModel,
  dedupeTaskIds,
} from './common'

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
  const { createProvider } = await import('../../../ai/registry')
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
        guard.recordAndCheck(providerId, model, event.usage.inputTokens ?? null, event.usage.outputTokens ?? null, event.usage.cacheReadTokens ?? event.usage.cachedInputTokens ?? null, event.usage.inputAccounting, event.usage.cacheWriteTokens ?? event.usage.cacheCreationInputTokens ?? null)
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

      const { createProvider, PROVIDERS } = await import('../../../ai/registry')
      const { estimateComplexity, recommendModel } = await import('../../../ai/smart-router')
      const { runSubAgentLoop } = await import('../../../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../../../ai/role-tools')
      const { getRolePrompt } = await import('../../../ai/agent-roles')
      const { subAgentQueue } = await import('../../../ai/sub-queue')
      const { createToolsForProject } = await import('../../../ai/tools')

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
      const plannerModel = resolveSubModel(recommendModel(baseProviderId, 'moderate'), ctx.currentModel, descriptor.defaultModel)
      const subtasks = await decomposeGoal(goal, maxSubtasks, baseProviderId, apiKey, plannerModel, ctx, ctx.signal)
      // Дедуп id подзадач — планировщик-модель может выдать одинаковые id, а
      // subCallId = `${call.id}:${task.id}` должен быть уникальным (см. dedupeTaskIds).
      dedupeTaskIds(subtasks)
      const isolateWriters = subtasks.filter(task => roleWriteScope(task.role, undefined).length > 0).length >= 2

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
        const subModel = resolveSubModel(recommendModel(baseProviderId, complexity), ctx.currentModel, descriptor.defaultModel)

        const subCallId = `${call.id}:${task.id}`
        let toolCount = 0
        let durableJob: AgentJobV1 | null = null
        const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: { type: 'subagent-run', callId: subCallId, jobId: durableJob?.id, label: `${task.role} (${complexity})`, provider: baseProviderId, role: task.role, toolCount, task: task.prompt, status, result }
          })
        }
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

        durableJob = startDurableJob(ctx, {
          kind: 'orchestrate-member',
          role: task.role,
          goal: task.prompt,
          providerId: baseProviderId,
          model: subModel,
          callId: subCallId,
          groupId: groupTag,
          readScope: ['**'],
          writeScope: roleWriteScope(task.role, undefined),
          costCapCents: batchCapCents,
        })
        durableJob = linkDurableJob(ctx, durableJob, { subSessionId })
        emitSubagent('running')

        const taskAc = new AbortController()
        const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
        const parentAbortHandler = () => taskAc.abort()
        ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

        let queueSlot: { release: () => void; ticketId: number } | null = null
        let jobLease: Awaited<ReturnType<typeof acquireDurableJob>> = null
        let worktree: string | null = null
        try {
          jobLease = await acquireDurableJob(ctx, durableJob, taskAc.signal, () => taskAc.abort())
          if (jobLease) durableJob = jobLease.job
          else {
            queueSlot = await subAgentQueue.enter({ group: groupTag, role: task.role, abort: () => taskAc.abort() }, taskAc.signal)
            durableJob = markDurableJobRunning(ctx, durableJob)
          }
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
          jobLease?.release()
          queueSlot?.release()
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'остановлен по cost-cap')
          finalizeSub('cancelled')
          throw new Error('остановлен по cost-cap')
        }

        try {
          let taskRoot = ctx.projectPath
          let taskTools = ctx.tools
          if (isolateWriters && (durableJob?.writeScope.length ?? 0) > 0) {
            worktree = addWorktree(ctx.projectPath, `orchestrate-${task.id}`)
            if (!worktree) throw new Error('не удалось создать обязательный worktree для orchestrate writer')
            durableJob = linkDurableJob(ctx, durableJob, { worktreePath: worktree })
            taskRoot = worktree
            taskTools = createToolsForProject(taskRoot, taskAc.signal)
          }
          const provider = createProvider(
            baseProviderId,
            buildSubCreateOptions(baseProviderId, apiKey, subModel, taskAc.signal, { ...ctx, projectPath: taskRoot })
          )
          // Идея 8: просим суб выдать СТРУКТУРИРОВАННЫЙ итог (handoff-формат), чтобы
          // главный агент получал сжатые выводы, а не простыни при 20+ субах.
          const rolePrompt = getRolePrompt(task.role) ?? 'Ты — sub-agent с доступом к инструментам.'
          const systemContent = `${rolePrompt}\n\nВ финале дай СТРУКТУРИРОВАННЫЙ итог тремя короткими блоками:\nСДЕЛАЛ: ...\nНАШЁЛ: ...\nРЕКОМЕНДУЮ: ...\nКлючевые находки сохраняй через memory_save (если доступен).`
          const allowedTools = getRoleToolset(task.role, { depth: depth + 1 })
          const subCtx: ToolContext = {
            ...ctx, projectPath: taskRoot, tools: taskTools, signal: taskAc.signal,
            subProviderId: baseProviderId, subModel,
            delegationDepth: depth + 1,
            parentCallId: subCallId,
            parentJobId: durableJob?.id ?? ctx.parentJobId ?? null
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
          let result = trimmed
          if (worktree) {
            const diff = worktreeDiff(worktree)
            result = `${trimmed}\n\n--- ИЗМЕНЕНИЯ В ИЗОЛИРОВАННОМ WORKTREE ---\n${diff || '(изменений нет)'}`
          }
          finishDurableJob(ctx, durableJob, res.exitReason === 'aborted' ? 'cancelled' : 'succeeded', result)
          return { id: task.id, role: task.role, model: subModel, result }
        } catch (taskErr) {
          emitSubagent('error', taskErr instanceof Error ? taskErr.message : String(taskErr))
          finalizeSub('error')
          finishDurableJob(ctx, durableJob, 'failed', taskErr instanceof Error ? taskErr.message : String(taskErr))
          throw taskErr
        } finally {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          jobLease?.release()
          queueSlot?.release()
          const finalJob = durableJob && ctx.agentJobs ? ctx.agentJobs.get(durableJob.id) : null
          if (worktree && finalJob?.status !== 'succeeded') {
            try { removeWorktree(ctx.projectPath, worktree) } catch { /* cleanup best-effort */ }
          }
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

