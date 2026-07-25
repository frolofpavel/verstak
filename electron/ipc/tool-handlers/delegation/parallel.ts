import type { ToolHandler, ToolContext } from '../shared'
import type { ProviderId } from '../../../ai/registry'
import { getRolePrompt } from '../../../ai/agent-roles'
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
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_BATCH_COST_CAP_CENTS,
  SUB_TASK_TIMEOUT_MS,
  buildSubCreateOptions,
  dedupeTaskIds,
} from './common'

export const delegateParallelHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const tasks = call.args.tasks as Array<{
        id: string
        prompt: string
        provider_id?: string
        model?: string
        role?: string
        read_scope?: string[]
        write_scope?: string[]
        depends_on?: string[]
      }> | undefined
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

      const { createProvider, PROVIDERS } = await import('../../../ai/registry')
      const { subAgentQueue, GLOBAL_SUB_CONCURRENCY } = await import('../../../ai/sub-queue')

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

      const { runSubAgentLoop } = await import('../../../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../../../ai/role-tools')
      const { createToolsForProject } = await import('../../../ai/tools')
      const parallelWriterCount = tasks.filter(task =>
        roleWriteScope(task.role, task.write_scope).length > 0
      ).length
      const parallelIsolation = parallelWriterCount >= 2
      const parallelJobIds = new Map(tasks.map(task => [task.id, randomUUID()]))
      const parallelJobs = new Map<string, AgentJobV1 | null>()
      for (const task of tasks) {
        const providerId = task.provider_id ?? ctx.currentProviderId ?? 'gemini-api'
        const descriptor = PROVIDERS[providerId as keyof typeof PROVIDERS]
        parallelJobs.set(task.id, startDurableJob(ctx, {
          id: parallelJobIds.get(task.id),
          kind: 'parallel-member',
          role: task.role ?? 'executor',
          goal: task.prompt,
          providerId,
          model: task.model ?? descriptor?.defaultModel ?? '',
          callId: `${call.id}:${task.id}`,
          groupId: groupTag,
          dependsOn: (task.depends_on ?? []).map(id => parallelJobIds.get(id)).filter(Boolean) as string[],
          readScope: task.read_scope ?? [],
          writeScope: roleWriteScope(task.role, task.write_scope),
          costCapCents: batchCapCents,
        }))
      }

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
        let durableJob: AgentJobV1 | null = parallelJobs.get(task.id) ?? null
        const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: {
              type: 'subagent-run',
              callId: subCallId,
              jobId: durableJob?.id,
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
          finishDurableJob(ctx, durableJob, 'failed', `unknown provider ${providerId}`)
          throw new Error(`неизвестный provider ${providerId}`)
        }
        const apiKey = descriptor.secretKey ? ctx.getSecretForDelegate?.(descriptor.secretKey) ?? null : null
        if (descriptor.secretKey && !apiKey) {
          ctx.agentCounter?.release(1)
          emitSubagent('error', `нет API key для ${providerId}`)
          finalizeSub('error')
          finishDurableJob(ctx, durableJob, 'blocked', `missing API key for ${providerId}`)
          throw new Error(`нет API key для ${providerId}`)
        }

        // Per-task AbortController. Таймаут поднят с 60с до 180с — субагент
        // теперь крутит tool-loop. Родительский signal прерывает подзадачу.
        const subModel = task.model ?? descriptor.defaultModel
        durableJob = linkDurableJob(ctx, durableJob, { subSessionId })
        emitSubagent('running')

        const taskAc = new AbortController()
        const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
        const parentAbortHandler = () => taskAc.abort()
        ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

        // Глобальная очередь: ждём слот. Если батч уже превысил cost-cap пока
        // мы стояли в очереди — не стартуем (экономим деньги).
        let queueSlot: { release: () => void; ticketId: number } | null = null
        let jobLease: Awaited<ReturnType<typeof acquireDurableJob>> = null
        let worktree: string | null = null
        try {
          jobLease = await acquireDurableJob(ctx, durableJob, taskAc.signal, () => taskAc.abort())
          if (jobLease) durableJob = jobLease.job
          else {
            queueSlot = await subAgentQueue.enter({ group: groupTag, role: task.role ?? null, abort: () => taskAc.abort() }, taskAc.signal)
            durableJob = markDurableJobRunning(ctx, durableJob)
          }
        } catch {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'отменён в очереди')
          finalizeSub('cancelled')
          finishDurableJob(ctx, durableJob, 'cancelled', 'cancelled in queue')
          throw new Error('отменён в очереди')
        }
        if (batchCapped) {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          jobLease?.release()
          queueSlot?.release()
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'батч остановлен по cost-cap')
          finalizeSub('cancelled')
          finishDurableJob(ctx, durableJob, 'blocked', 'batch cost cap exhausted', {
            recommendedAction: 'replan',
          })
          throw new Error('батч остановлен по cost-cap')
        }

        try {
          let taskRoot = ctx.projectPath
          let taskTools = ctx.tools
          if (parallelIsolation && (durableJob?.writeScope.length ?? 0) > 0) {
            worktree = addWorktree(ctx.projectPath, `job-${task.id}`)
            if (!worktree) throw new Error('не удалось создать обязательный worktree для parallel writer')
            durableJob = linkDurableJob(ctx, durableJob, { worktreePath: worktree })
            taskRoot = worktree
            taskTools = createToolsForProject(taskRoot, taskAc.signal)
          }
          const provider = createProvider(
            providerId as ProviderId,
            buildSubCreateOptions(providerId as ProviderId, apiKey, subModel, taskAc.signal, { ...ctx, projectPath: taskRoot })
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
            projectPath: taskRoot,
            tools: taskTools,
            signal: taskAc.signal,
            subProviderId: providerId as ProviderId,
            subModel,
            delegationDepth: depth + 1,
            parentCallId: subCallId,
            parentJobId: durableJob?.id ?? ctx.parentJobId ?? null
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
          let result = trimmed
          if (worktree) {
            const diff = worktreeDiff(worktree)
            result = `${trimmed}\n\n--- ИЗМЕНЕНИЯ В ИЗОЛИРОВАННОМ WORKTREE ---\n${diff || '(изменений нет)'}`
          }
          finishDurableJob(ctx, durableJob, res.exitReason === 'aborted' ? 'cancelled' : 'succeeded', result)
          return { id: task.id, result }
        } catch (taskErr) {
          // Любой неожиданный throw (createProvider, abort/timeout) — карточка
          // не должна застрять на 'running'. Rethrow → Promise.allSettled reject.
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

