import type { ToolHandler, ToolContext } from '../shared'
import type { ProviderId } from '../../../ai/registry'
import { addWorktree, removeWorktree, worktreeDiff } from '../../../ai/git-worktree'
import type { AgentJobV1 } from '../../../../shared/contracts/agent-job'
import {
  acquireDurableJob,
  finishDurableJob,
  linkDurableJob,
  markDurableJobRunning,
  startDurableJob,
} from './job-runtime'
import { decideSwarmRubric } from '../../../ai/swarm-rubric'
import {
  DEFAULT_BATCH_COST_CAP_CENTS,
  MAX_WORKTREE_DIFF_CHARS,
  SUB_TASK_TIMEOUT_MS,
  buildSubCreateOptions,
  dedupeTaskIds,
} from './common'

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
      const roster = buildSwarmRoster(typeof call.args.size === 'number' ? call.args.size : 4)
      const isolate = call.args.isolate === true || roster.filter(member => member.role === 'executor').length >= 2
      // Дедуп id членов роя — buildSwarmRoster даёт уникальные id по построению,
      // но subCallId = `${call.id}:${m.id}` требует гарантии (см. dedupeTaskIds).
      dedupeTaskIds(roster, 'member')
      const batchCapCents = typeof call.args.cost_cap_usd === 'number' && call.args.cost_cap_usd > 0
        ? Math.round(call.args.cost_cap_usd * 100)
        : DEFAULT_BATCH_COST_CAP_CENTS

      const { createProvider, PROVIDERS } = await import('../../../ai/registry')
      const { runSubAgentLoop } = await import('../../../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../../../ai/role-tools')
      const { getRolePrompt } = await import('../../../ai/agent-roles')
      const { subAgentQueue } = await import('../../../ai/sub-queue')
      // T1.2: для isolate — отдельный FileTools, заруленный на worktree executor'а.
      const { createToolsForProject } = await import('../../../ai/tools')

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
        let durableJob: AgentJobV1 | null = null
        durableJob = startDurableJob(ctx, {
          kind: 'swarm-member',
          role: m.role,
          goal,
          providerId: baseProviderId,
          model: descriptor.defaultModel,
          callId: subCallId,
          groupId: groupTag,
          readScope: ['**'],
          writeScope: m.role === 'executor' ? ['**'] : [],
          costCapCents: batchCapCents,
        })
        const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: { type: 'subagent-run', callId: subCallId, jobId: durableJob?.id, label: `🐝 ${m.role}/${m.id}`, provider: baseProviderId, role: m.role, swarm: groupTag, toolCount, task: goal, status, result }
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
        durableJob = linkDurableJob(ctx, durableJob, { subSessionId })
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
        let jobLease: Awaited<ReturnType<typeof acquireDurableJob>> = null
        try {
          jobLease = await acquireDurableJob(ctx, durableJob, taskAc.signal, () => taskAc.abort())
          if (jobLease) durableJob = jobLease.job
          else {
            queueSlot = await subAgentQueue.enter({ group: groupTag, role: m.role, abort: () => taskAc.abort() }, taskAc.signal)
            durableJob = markDurableJobRunning(ctx, durableJob)
          }
        } catch {
          clearTimeout(timeoutId); ctx.signal.removeEventListener('abort', parentAbortHandler)
          ctx.agentCounter?.release(1)  // член роя не стартовал — возвращаем слот
          emitSubagent('error', 'отменён в очереди'); finalizeSub('cancelled')
          throw new Error('отменён в очереди')
        }
        if (batchCapped) {
          clearTimeout(timeoutId); ctx.signal.removeEventListener('abort', parentAbortHandler); jobLease?.release(); queueSlot?.release()
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
            durableJob = linkDurableJob(ctx, durableJob, { worktreePath: worktree })
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
            delegationDepth: depth + 1, parentCallId: subCallId,
            parentJobId: durableJob?.id ?? ctx.parentJobId ?? null
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
          finishDurableJob(ctx, durableJob, res.exitReason === 'aborted' ? 'cancelled' : 'succeeded', result)
          return { id: m.id, role: m.role, angle: m.angle, result }
        } catch (taskErr) {
          emitSubagent('error', taskErr instanceof Error ? taskErr.message : String(taskErr))
          finalizeSub('error')
          finishDurableJob(ctx, durableJob, 'failed', taskErr instanceof Error ? taskErr.message : String(taskErr))
          throw taskErr
        } finally {
          clearTimeout(timeoutId); ctx.signal.removeEventListener('abort', parentAbortHandler); jobLease?.release(); queueSlot?.release()
          // Успешный вариант сохраняется до явного выбора/отклонения пользователем.
          const finalJob = durableJob && ctx.agentJobs ? ctx.agentJobs.get(durableJob.id) : null
          if (worktree && finalJob?.status !== 'succeeded') {
            try { removeWorktree(ctx.projectPath, worktree) } catch { /* best-effort */ }
          }
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
      const rubric = decideSwarmRubric(variants.map(variant => ({ id: variant.id, result: variant.result })))
      const rubricBlock = JSON.stringify(rubric, null, 2)
      const arbiterSystem = isolate
        ? 'Ты — АРБИТР роя агентов. Каждый вариант содержит решение + git diff изменений в изолированном worktree. Оцени варианты, выбери ЛУЧШИЙ (или укажи какие части каких вариантов объединить). Верни: 1) ВЫБОР — какой вариант (по id) применить и какие именно файлы/правки взять из его diff; 2) ОБОСНОВАНИЕ (1-3 строки). Главный агент применит выбранные изменения в основном дереве сам — будь конкретен.'
        : 'Ты — АРБИТР роя агентов. Тебе дают несколько независимых вариантов решения ОДНОЙ цели. Твоя задача: оценить их, выбрать лучший ИЛИ синтезировать консенсус из сильных сторон нескольких. Верни: 1) КОНСЕНСУС — итоговое лучшее решение цели (готовое к использованию); 2) ОБОСНОВАНИЕ — на каких вариантах оно основано и почему (1-3 строки). Будь решительным: один чёткий результат, а не пересказ всех.'
      const arbiterUser = `Цель: ${goal}\n\nВарианты роя (${variants.length}):\n\n${variantsBlock}\n\nSTRUCTURED RUBRIC:\n${rubricBlock}\n\nВыбери/синтезируй лучший консенсусный результат. Не скрывай objections и uncertainty.`

      let consensus = ''
      let arbiterOk = false
      const arbiterCallId = `${call.id}:arbiter`
      let arbiterJob = startDurableJob(ctx, {
        kind: 'swarm-arbiter',
        role: 'critic',
        goal: `Арбитраж ${variants.length} вариантов: ${goal}`,
        providerId: baseProviderId,
        model: descriptor.defaultModel,
        callId: arbiterCallId,
        groupId: groupTag,
        readScope: ['**'],
      })
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'subagent-run', callId: arbiterCallId, jobId: arbiterJob?.id, label: '⚖️ arbiter', provider: baseProviderId, role: 'critic', swarm: groupTag, toolCount: 0, task: `консенсус из ${variants.length} вариантов`, status: 'running' }
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
      arbiterJob = linkDurableJob(ctx, arbiterJob, { subSessionId: arbiterSessionId })
      // Per-task таймаут арбитра — тот же паттерн, что у членов роя (runMember).
      // Без него зависший арбитрский провайдер вешал swarm до ручной отмены
      // всего ai:send: signal === ctx.signal не обрывается по таймауту.
      const arbAc = new AbortController()
      const arbTimeoutId = setTimeout(() => arbAc.abort(), SUB_TASK_TIMEOUT_MS)
      const arbAbortHandler = () => arbAc.abort()
      ctx.signal.addEventListener('abort', arbAbortHandler, { once: true })
      let arbiterLease: Awaited<ReturnType<typeof acquireDurableJob>> = null
      let arbiterQueueSlot: { release: () => void; ticketId: number } | null = null
      try {
        arbiterLease = await acquireDurableJob(ctx, arbiterJob, arbAc.signal, () => arbAc.abort())
        if (arbiterLease) arbiterJob = arbiterLease.job
        else {
          arbiterQueueSlot = await subAgentQueue.enter({ group: groupTag, role: 'critic', abort: () => arbAc.abort() }, arbAc.signal)
          arbiterJob = markDurableJobRunning(ctx, arbiterJob)
        }
        const arbiterProvider = createProvider(
          baseProviderId,
          buildSubCreateOptions(baseProviderId, apiKey, descriptor.defaultModel, arbAc.signal, ctx)
        )
        // Арбитр — read-only (никаких правок при синтезе).
        const res = await runSubAgentLoop({
          provider: arbiterProvider,
          messages: [{ role: 'system', content: arbiterSystem }, { role: 'user', content: arbiterUser }],
          allowedToolNames: getRoleToolset('critic', { depth: depth + 1 }),
          ctx: { ...ctx, subProviderId: baseProviderId, subModel: descriptor.defaultModel, delegationDepth: depth + 1, parentCallId: arbiterCallId, parentJobId: arbiterJob?.id ?? ctx.parentJobId ?? null },
          signal: arbAc.signal, role: 'critic'
        })
        consensus = res.text.trim()
        arbiterOk = res.exitReason !== 'error' && consensus.length > 0
        finishDurableJob(ctx, arbiterJob, arbiterOk ? 'succeeded' : 'failed', consensus || res.error || 'arbiter returned an empty response')
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
        finishDurableJob(ctx, arbiterJob, 'failed', arbErr instanceof Error ? arbErr.message : String(arbErr))
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'subagent-run', callId: arbiterCallId, label: '⚖️ arbiter', provider: baseProviderId, role: 'critic', swarm: groupTag, toolCount: 0, task: 'консенсус', status: 'error', result: arbErr instanceof Error ? arbErr.message : String(arbErr) } })
        if (arbiterSessionId != null && ctx.subSessions) {
          try { ctx.subSessions.update(arbiterSessionId, { status: 'error', endedAt: Date.now() }) } catch { /* */ }
        }
      } finally {
        clearTimeout(arbTimeoutId)
        ctx.signal.removeEventListener('abort', arbAbortHandler)
        arbiterLease?.release()
        arbiterQueueSlot?.release()
      }

      try {
        ctx.recordJournal(ctx.projectPath, 'note',
          `🐝 swarm — ${variants.length}/${roster.length} вариантов${arbiterOk ? ' + консенсус арбитра' : ' (арбитр не дал ответ)'}${batchCapped ? ' (стоп по cost-cap)' : ''}`,
          `Цель: ${goal.slice(0, 200)}`)
      } catch { /* journal не критично */ }

      const capNote = batchCapped ? `\n\n⚠️ Рой остановлен: превышен cost-cap $${(batchCapCents / 100).toFixed(2)}.` : ''
      if (arbiterOk) {
        const decisionNote = rubric.needsUserDecision
          ? `\n\n⚠️ НУЖНО РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ: ${rubric.reason}\n${rubricBlock}`
          : `\n\n✅ Rubric рекомендует вариант ${rubric.recommendedId}.\n${rubricBlock}`
        return { id: call.id, name: call.name, result: `🐝 Рой из ${variants.length} агентов → консенсус арбитра:\n\n${consensus}${decisionNote}${capNote}` }
      }
      // Фоллбэк: арбитр не справился — отдаём главному все варианты, пусть решит сам.
      return { id: call.id, name: call.name, result: `🐝 Рой дал ${variants.length} вариантов (арбитр не синтезировал консенсус — выбери лучший сам):\n\n${variantsBlock}${capNote}` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
