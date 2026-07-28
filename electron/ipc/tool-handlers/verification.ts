// Verification-хендлеры: attest_verification / create_plan / preflight. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity } from './shared'
import { planSpecFeedback } from '../../ai/task-spec-check'
import { awaitingApprovalResult } from '../../ai/plan-await'
import { scanText } from '../../ai/secret-scanner'
import type { VerificationArtifact, VerificationCheck, VerificationChangedFile } from '../../ai/verification'
import { scorePlanQuality } from '../../ai/plan-quality'
import { parsePlanStepSpec, type PlanStepSpecV1 } from '../../../shared/contracts/outcome'
import { getPlanForRun, rememberPlanForRun, markPlanAwaitingApproval } from '../../ai/runner-shared'
import { planApprovalVerdict, explainVerdict } from '../../ai/plan-threshold'
import { planGateApplies } from '../../ai/plan-gate-modes'

// Потолок проверок-с-командой на один attest — чтобы агент не превратил его в
// способ прогнать 50 команд разом. Ручные проверки сверх лимита не режем.
const MAX_VERIFICATION_CHECKS = 10
// Сколько символов вывода (stdout+stderr) сохраняем в артефакт.
const VERIFICATION_TAIL_CHARS = 800

export const attestVerificationHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { writeVerificationArtifact } = await import('../../ai/artifacts')
      const { computeOverall } = await import('../../ai/verification')

      const taskSummary = String(call.args.task_summary ?? '').trim()
      if (!taskSummary) return { id: call.id, name: call.name, result: '', error: 'attest_verification: task_summary обязателен' }

      const claimedFiles = Array.isArray(call.args.changed_files)
        ? call.args.changed_files.map(String).map(s => s.trim()).filter(Boolean)
        : []
      const risks = Array.isArray(call.args.risks)
        ? call.args.risks.map(String).map(s => s.trim()).filter(Boolean)
        : []
      const rawChecks = Array.isArray(call.args.checks) ? call.args.checks : []

      // --- Проверки: перепрогон команд через тот же runCommand (denylist+scanner внутри).
      const checks: VerificationCheck[] = []
      let commandRuns = 0
      for (const raw of rawChecks) {
        if (typeof raw !== 'object' || raw === null) continue
        const c = raw as Record<string, unknown>
        const command = c.command != null ? String(c.command).trim() : ''
        const summary = c.summary != null ? String(c.summary).trim() : undefined

        if (!command) {
          // Ручная проверка — статус not_run, берём summary от модели.
          checks.push({ command: null, status: 'not_run', manual: true, summary })
          continue
        }

        // Денилист: классифицируем ДО запуска. Заблокированная команда → not_run+manual,
        // причина в summary (агент сам решит, что с ней делать).
        const verdict = ctx.tools.classifyCommand(command)
        if (!verdict.allowed) {
          checks.push({
            command, status: 'not_run', manual: true,
            summary: summary ? `${summary} · заблокирована: ${verdict.reason ?? 'denylist'}` : `Заблокирована политикой: ${verdict.reason ?? 'denylist'}`
          })
          continue
        }

        // Cap: сверх лимита команды не прогоняем — фиксируем как not_run.
        if (commandRuns >= MAX_VERIFICATION_CHECKS) {
          checks.push({ command, status: 'not_run', manual: true, summary: summary ? `${summary} · не запущена (лимит проверок)` : 'Не запущена — превышен лимит проверок' })
          continue
        }
        commandRuns++

        try {
          const r = await ctx.tools.runCommand(command)
          // Доктрина: статус по exitCode, не по слову модели.
          const status: VerificationCheck['status'] = r.exitCode === 0 ? 'passed' : 'failed'
          // runCommand редактирует через secret-scanner на своём пути, но прогоняем
          // ещё раз на всякий случай — tail попадает в артефакт/контекст.
          const combined = scanText(`${r.stdout}\n${r.stderr}`).redacted.trim()
          const tail = combined.length > VERIFICATION_TAIL_CHARS
            ? combined.slice(-VERIFICATION_TAIL_CHARS)
            : (combined || undefined)
          checks.push({ command, status, manual: false, summary, exitCode: r.exitCode, tail })
          // Эфемерный фидбек в Timeline чата — видно что проверка прогнана.
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: { type: 'tool-activity', callId: call.id, name: 'attest_verification', label: `проверка: ${status === 'passed' ? 'OK' : 'FAIL'}`, detail: `${command} · exit ${r.exitCode}`, status: status === 'passed' ? 'ok' : 'error' }
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          checks.push({ command, status: 'failed', manual: false, summary, tail: scanText(msg).redacted.slice(0, VERIFICATION_TAIL_CHARS) })
        }
      }

      // --- changed_files: сверка claimed (из args) vs actual (реально записано прогоном).
      // actualSet — снимок filesTouched из ai.ts; нормализуем пути к forward-slash для сравнения.
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')
      const actualList = ctx.runFilesTouched ? ctx.runFilesTouched().map(norm) : null
      const actualSet = actualList ? new Set(actualList) : null
      const changedFiles: VerificationChangedFile[] = claimedFiles.map(p => ({
        path: p,
        claimed: true,
        // Если источник actual недоступен — считаем actual=claimed (не блокируем фазу).
        actual: actualSet ? actualSet.has(norm(p)) : true
      }))
      // Файлы, реально тронутые, но НЕ заявленные агентом — тоже в артефакт (claimed=false).
      if (actualList) {
        const claimedNorm = new Set(claimedFiles.map(norm))
        for (const a of actualList) {
          if (!claimedNorm.has(a)) changedFiles.push({ path: a, claimed: false, actual: true })
        }
      }

      // --- UI screenshot: последний browser_screenshot из pendingAttachments (image/png).
      let screenshotPath: string | undefined
      if (call.args.ui_screenshot === true) {
        const shot = [...ctx.pendingAttachments].reverse().find(a => a.mimeType === 'image/png' && a.data)
        if (shot) {
          try {
            const { artifactsDir } = await import('../../ai/artifacts')
            const { mkdir, writeFile } = await import('fs/promises')
            const { join } = await import('path')
            const dir = artifactsDir(ctx.projectPath)
            await mkdir(dir, { recursive: true })
            const shotName = `verification-shot-${Date.now()}.png`
            await writeFile(join(dir, shotName), Buffer.from(shot.data, 'base64'))
            // Относительный путь — html артефакт лежит в той же папке.
            screenshotPath = shotName
          } catch { /* скриншот не критичен — пропускаем */ }
        }
      }

      const overall = computeOverall(checks)
      const art: VerificationArtifact = {
        version: 1,
        taskSummary,
        overall,
        changedFiles,
        checks,
        screenshotPath,
        risks,
        createdAt: Date.now(),
        runId: ctx.runId,
        chatId: ctx.parentChatId ?? undefined
      }

      const res = await writeVerificationArtifact(ctx.projectPath, art)
      const checksPassed = checks.filter(c => c.status === 'passed').length

      // Персист (Фаза 3): лёгкая строка истории поверх файла-артефакта. Нужна для
      // verifications.latest(chatId) в Review DoD и панели истории. Best-effort —
      // источник истины это файл, провал записи в БД не ломает attest.
      try {
        ctx.verifications?.insert({
          projectPath: ctx.projectPath,
          chatId: ctx.parentChatId ?? null,
          runId: ctx.runId ?? null,
          overall,
          checksTotal: checks.length,
          checksPassed,
          changedFilesCount: changedFiles.length,
          artifactPath: res.jsonPath,
          htmlPath: res.htmlPath,
          taskSummary,
          createdAt: art.createdAt
        })
      } catch { /* история не критична — файл-артефакт уже записан */ }

      try { ctx.recordJournal(ctx.projectPath, 'session', `${overall === 'passed' ? '✅' : overall === 'failed' ? '✗' : '⚠'} Верификация: ${overall}`, taskSummary) } catch { /* journal not critical */ }

      // artifact-created — как файл-артефакт (pill + preview), kind='verification'.
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'artifact-created', callId: call.id, kind: 'verification', filename: res.filename, path: res.htmlPath, sizeBytes: res.sizeBytes }
      })
      // verification-attested — эфемерный бейдж DoD для UI.
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'verification-attested', callId: call.id, overall, checksTotal: checks.length, checksPassed, changedFilesCount: changedFiles.length }
      })
      // Timeline задачи (Manager): событие verify со статусом overall.
      try { ctx.recordRunEvent?.('verify', { label: `DoD ${checksPassed}/${checks.length}`, detail: taskSummary, ref: res.htmlPath, status: overall }) } catch { /* best-effort */ }

      return {
        id: call.id, name: call.name,
        result: `Verification attested: overall=${overall}, DoD ${checksPassed}/${checks.length} проверок зелёные.\nАртефакт: ${res.htmlPath}\nСтатусы проверок поставлены по реальному exitCode перепрогона.`
      }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

/**
 * Понизить права ПРОГОНА — и сразу, и на будущие ходы.
 *
 * Две записи, а не одна, и это существенно. `ctx.setAgentMode` мутирует
 * переменную прогона в `runner-api` (её видят СЛЕДУЮЩИЕ ходы), а `ctx.agentMode`
 * — снимок в объекте контекста, по которому судят инструменты ТЕКУЩЕГО хода.
 * Раньше писалось только первое, поэтому `write_file`, вызванный моделью в одном
 * ходе с `create_plan`, проходил ещё по старому режиму: понижение опаздывало
 * ровно на тот ход, в котором оно и нужно.
 *
 * «Понизить» — не «переставить»: строгий режим не ослабляем. Порядок строгости
 * plan > ask > остальные, поэтому просьба понизить до `ask` план-режим не тронет.
 */
function lowerRunMode(ctx: Parameters<ToolHandler['handle']>[1], target: 'ask' | 'plan'): void {
  const STRICTNESS: Record<string, number> = { plan: 3, ask: 2, 'accept-edits': 1, auto: 0, bypass: 0 }
  const current = STRICTNESS[ctx.agentMode] ?? 0
  if (current >= (STRICTNESS[target] ?? 0)) return
  ctx.setAgentMode?.(target)
  ctx.agentMode = target
}

export const createPlanHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const title = String(call.args.title ?? 'План без названия')
      const rawSteps = Array.isArray(call.args.steps) ? call.args.steps : []
      const steps = rawSteps
        .filter((s: unknown): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .map((s) => ({
          title: String(s.title ?? ''),
          detail: s.detail != null ? String(s.detail) : null,
          rawSpec: s.spec,
        }))
        .filter(s => s.title.length > 0)
      if (steps.length === 0) {
        return { id: call.id, name: call.name, result: '', error: 'create_plan: пустой список шагов' }
      }

      // Legacy и Outcome проходят quality ДО persistence/approval. Это закрывает
      // исторический bypass: plan-mode раньше возвращался из approval раньше feedback.
      const specFeedback = planSpecFeedback(steps)
      if (!ctx.outcome && specFeedback) {
        return { id: call.id, name: call.name, result: `План не сохранён: требуется доработка.${specFeedback}` }
      }

      let quality: ReturnType<typeof scorePlanQuality> | null = null
      let specs: PlanStepSpecV1[] = []
      let contractRevision: number | null = null
      let planRevision = 1
      if (ctx.outcome) {
        if (ctx.outcome.phase !== 'plan' || !ctx.pipelineRuns) {
          return { id: call.id, name: call.name, result: '', error: 'OUTCOME_PHASE_REQUIRED: create_plan требует phase=plan' }
        }
        const pipeline = ctx.pipelineRuns.get(ctx.outcome.pipelineId)
        if (!pipeline || pipeline.projectPath !== ctx.projectPath || !pipeline.taskContract) {
          return { id: call.id, name: call.name, result: '', error: 'OUTCOME_CONTRACT_REQUIRED' }
        }
        const parsedSpecs = steps.map((step, index) => {
          const parsed = parsePlanStepSpec(step.rawSpec)
          return { index, parsed }
        })
        const diagnostics = parsedSpecs.flatMap(item =>
          item.parsed.diagnostics.map(d => `steps.${item.index}.spec.${d.path}: ${d.message}`)
        )
        specs = parsedSpecs.flatMap(item => item.parsed.value ? [item.parsed.value] : [])
        if (diagnostics.length > 0 || specs.length !== steps.length) {
          return { id: call.id, name: call.name, result: `План не сохранён: structured spec невалиден.\n- ${diagnostics.join('\n- ')}` }
        }
        quality = scorePlanQuality(pipeline.taskContract, specs)
        if (quality.hardErrors.length > 0) {
          return { id: call.id, name: call.name, result: `План не сохранён: deterministic gate требует revise.\n- ${quality.hardErrors.join('\n- ')}` }
        }
        contractRevision = pipeline.contractRevision
        planRevision = pipeline.planId
          ? (ctx.getPlan?.(pipeline.planId)?.planRevision ?? 1) + 1
          : 1
      }

      // Порог показа карточки (§4.2). Гейт как таковой прежний; порог решает
      // только, ПОКАЗЫВАТЬ ли карточку. План, объявивший одно чтение,
      // автоутверждается: карточки нет, след в БД остаётся.
      //
      // КЛЮЧЕВОЕ ПРО БЕЗОПАСНОСТЬ: автоутверждение НЕ трогает режим прогона.
      // Approve по кнопке переключает режим (ctx.setAgentMode) и тем самым выдаёт
      // право писать; автоутверждение этого НЕ делает. Поэтому план, объявивший
      // себя read-only и попытавшийся писать, упирается в обычный
      // mode-policy.decide и останавливается — неверная самооценка модели даёт
      // лишний вопрос, а не тихую запись.
      // §5: кто спрашивает — решает матрица режимов; что в плане — порог ниже.
      const gateApplies = planGateApplies({
        agentMode: ctx.agentMode,
        outcomePhase: ctx.outcome?.phase ?? null,
        planApprovalSetting: ctx.getSecretForDelegate?.('plan_approval_gate') === 'true',
        delegationDepth: ctx.delegationDepth,
      })
      // §4.2 живой порог: сырой spec отдаём порогу ВСЕГДА. `specs` заполняется
      // только под ctx.outcome, поэтому на чат-пути сюда приезжал null даже
      // когда модель spec ПРИСЛАЛА — порог судил по пустоте и требовал карточку
      // на каждый план. Полный разбор для outcome/quality не меняется: там
      // по-прежнему нужен parsePlanStepSpec без диагностик.
      const verdict = planApprovalVerdict(steps.map((step, index) => ({
        title: step.title,
        detail: step.detail,
        spec: specs[index] ?? null,
        rawSpec: step.rawSpec,
      })))
      const requiresApproval = gateApplies && verdict.needsCard

      // Идемпотентность (§9 ТЗ): один прогон — один план. Повторный create_plan в
      // том же прогоне возвращает уже созданный planId, а не плодит дубликат.
      // Проверка стоит ПОСЛЕ валидации и quality-гейта: невалидный повторный
      // вызов должен получить свою ошибку, а не молча «успех» со старым id.
      // …и та же защита для прогона ДОРАБОТКИ (доработка после ревью 28.07).
      // Реестр выше ключуется по sendId, а у продолжения он ДРУГОЙ: модель,
      // позвавшая create_plan вместо replan_plan, спокойно создавала второй
      // план на ту же задачу. «Дубликата нет» держалось на послушании модели —
      // теперь на рантайме. Только чат-путь: у пайплайна свой create_plan с
      // контрактом и своей ревизией, его поведение не трогаем.
      const alreadyCreated = getPlanForRun(ctx.sendId) ?? (ctx.outcome ? null : ctx.revisePlanId ?? null)
      if (alreadyCreated != null && ctx.getPlan?.(alreadyCreated)) {
        return {
          id: call.id,
          name: call.name,
          result: `План этой задачи уже создан: planId=${alreadyCreated}. ` +
            'Повторный create_plan не нужен — дубликат не создан. ' +
            'Для доработки существующего плана используй replan_plan.',
        }
      }

      const plan = ctx.recordPlan(
        ctx.projectPath,
        title,
        steps.map((step, index) => ({
          title: step.title,
          detail: step.detail,
          ...(specs[index] ? { spec: specs[index] } : {}),
        })),
        // §10: происхождение плана. agentRunId — якорь продолжения после approve:
        // по нему находят чекпойнт прогона, с которого работа поедет дальше.
        // sourceMessageId у ToolContext нет — остаётся null (см. остаток блока B).
        {
          ...(quality ? { contractRevision, planRevision, quality } : {}),
          chatId: ctx.parentChatId ?? null,
          agentRunId: ctx.runId ?? null,
        },
      )
      rememberPlanForRun(ctx.sendId, plan.id)
      try { ctx.recordJournal(ctx.projectPath, 'note', `План: ${title}`, `${steps.length} шагов`) } catch { /* journal not critical */ }
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: {
          type: 'plan-created',
          planId: plan.id,
          title,
          stepCount: steps.length,
          ...(quality ? { quality: { score: quality.score, status: quality.status, warnings: quality.warnings } } : {}),
        },
      })
      // §10 plan-gate: карточку показываем, а ЖДЁМ решения снаружи прогона.
      // Раньше здесь стоял await на промисе, и параллельно тикал сторож времени
      // прогона: ушёл человек от карточки надолго — вернулся к мёртвому прогону.
      // Теперь прогон завершается штатно (сторож снимается вместе с ним), а
      // ожидание держит БД: план в draft + agent_run_id + чекпойнт прогона.
      // Продолжение после approve собирает ipc/plans.ts → PlanConfirm.
      if (requiresApproval) {
        ctx.sender.send('ai:event', {
          id: ctx.sendId,
          event: {
            type: 'plan-approval',
            callId: call.id,
            planId: plan.id,
            title,
            stepCount: steps.length,
            ...(quality ? { quality: { score: quality.score, status: quality.status, warnings: quality.warnings } } : {}),
          },
        })
        // Финализация прогона узнаёт отсюда, что чекпойнт удалять нельзя: он и
        // есть место, с которого продолжится работа.
        markPlanAwaitingApproval(ctx.runId, plan.id)
        // Права на остаток прогона ПОНИЖАЕМ до plan-режима. Это рантайм, а не
        // просьба в тексте: модель может проигнорировать «ничего не выполняй»,
        // но mode-policy.decide в режиме plan блокирует запись независимо от её
        // намерений. Повышение режима сюда не приходит и прийти не может —
        // единственный путь к нему остаётся через решение человека.
        lowerRunMode(ctx, 'plan')
        return {
          id: call.id,
          name: call.name,
          result: awaitingApprovalResult({ id: plan.id, stepCount: steps.length }),
        }
      }
      // Автоутверждение: гейт применим, но план только читает.
      //
      // ПОЗИЦИЯ 1 РЕВЬЮ 28.07 — здесь была дыра, и она была живой. Раньше эта
      // ветка не трогала режим вовсе, а текст обещал, что «права на запись НЕ
      // выданы». В режиме «Принимать правки» обещание было ложным: правки там
      // проходят автоматически, поэтому ошибка порога (модель объявила пишущий
      // шаг читающим) давала запись файла БЕЗ единого клика — ни карточки, ни
      // вопроса. Теперь права понижаются рантаймом: чтение остаётся свободным
      // (read-инструменты не гейтятся вовсе), а любая попытка записи или команды
      // упирается в подтверждение. Ровно то, что обещает §4.2: неверная
      // самооценка модели стоит пользователю лишнего вопроса, а не тихой записи.
      if (gateApplies && !verdict.needsCard) {
        lowerRunMode(ctx, 'ask')
        return {
          id: call.id,
          name: call.name,
          result: `План #${plan.id} сохранён и автоутверждён: ${explainVerdict(verdict)} ` +
            'Выполняй читающие шаги. Права на запись НЕ выданы: попытка изменить ' +
            'файлы или внешнюю систему потребует подтверждения человека.',
        }
      }
      return { id: call.id, name: call.name, result: `Plan #${plan.id} created with ${steps.length} steps. User will execute/confirm in the Plan view.${specFeedback}` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// preflight — объявление плана перед сложной/деструктивной задачей
// ============================================================================

function toStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : []
}

export const preflightHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const summary = String(call.args.summary ?? '').trim()
      if (!summary) {
        return { id: call.id, name: call.name, result: '', error: 'preflight: summary обязателен' }
      }
      const rawRisk = String(call.args.risk ?? '').trim()
      const risk: 'low' | 'medium' | 'high' = rawRisk === 'high' || rawRisk === 'medium' ? rawRisk : 'low'
      const affectedZones = toStringList(call.args.affectedZones)
      const verifyAfter = toStringList(call.args.verifyAfter)
      const outOfScope = toStringList(call.args.outOfScope)
      const riskReason = String(call.args.riskReason ?? '').trim()

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'preflight', callId: call.id, summary, affectedZones, risk, riskReason, verifyAfter, outOfScope }
      })
      try { ctx.recordJournal(ctx.projectPath, 'note', `🛫 Preflight (${risk}): ${summary.slice(0, 120)}`, affectedZones.join(', ') || null) } catch { /* journal not critical */ }
      emitActivity(ctx, call, 'ok', 'preflight', `${risk} · ${summary.slice(0, 60)}`)
      return { id: call.id, name: call.name, result: 'preflight shown — продолжай выполнение задачи по объявленному плану.' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}
