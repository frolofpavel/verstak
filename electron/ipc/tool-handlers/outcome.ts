import { scanText } from '../../ai/secret-scanner'
import { evidenceExists } from '../../ai/evidence'
import { pickNextStep, summarizePlan } from '../../ai/plan-step-order'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { decideAdaptiveAction, failureSignature } from '../../ai/adaptive-decision'
import { nextPipelineStep } from '../../ai/outcome-controller'
import { scorePlanQuality } from '../../ai/plan-quality'
import {
  parsePlanStepSpec,
  parseStepOutcome,
  parseTaskContract,
  type PlanStepSpecV1,
  type TaskContractV1,
} from '../../../shared/contracts/outcome'
import { planSpecFeedback } from '../../ai/task-spec-check'
import { awaitingApprovalResult } from '../../ai/plan-await'
import { planApprovalVerdict, explainVerdict } from '../../ai/plan-threshold'
import { planGateApplies } from '../../ai/plan-gate-modes'
import { markPlanAwaitingApproval, clearPlanAwaitingApproval } from '../../ai/runner-shared'
import type { ToolContext, ToolHandler } from './shared'
import type { ToolCall, ToolResult } from '../../ai/types'

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []

export const submitTaskContractHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.outcome || ctx.outcome.phase !== 'refine') {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_PHASE_REQUIRED: submit_task_contract доступен только в refine' }
    }
    if (!ctx.pipelineRuns) {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_STORAGE_UNAVAILABLE' }
    }
    const current = ctx.pipelineRuns.get(ctx.outcome.pipelineId)
    if (!current || current.projectPath !== ctx.projectPath) {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_PIPELINE_MISMATCH' }
    }
    const contract: TaskContractV1 = {
      schemaVersion: 1,
      revision: current.contractRevision + 1,
      rawRequest: current.brief.goal,
      goal: String(call.args.goal ?? '').trim(),
      successCriteria: list(call.args.successCriteria).map(raw => {
        const item = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        return {
          id: String(item.id ?? '').trim(),
          text: String(item.text ?? '').trim(),
          evidence: String(item.evidence ?? 'manual') as TaskContractV1['successCriteria'][number]['evidence'],
          ...(typeof item.verify === 'string' && item.verify.trim() ? { verify: item.verify.trim() } : {}),
        }
      }),
      constraints: list(call.args.constraints).map(String),
      nonGoals: list(call.args.nonGoals).map(String),
      assumptions: list(call.args.assumptions).map(raw => {
        const item = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        return {
          text: String(item.text ?? '').trim(),
          status: String(item.status ?? 'unconfirmed') as TaskContractV1['assumptions'][number]['status'],
        }
      }),
      blockingQuestions: list(call.args.blockingQuestions).map(String),
      repoEvidence: list(call.args.repoEvidence).map(raw => {
        const item = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        return {
          path: String(item.path ?? '').trim(),
          ...(typeof item.symbol === 'string' && item.symbol.trim() ? { symbol: item.symbol.trim() } : {}),
          why: String(item.why ?? '').trim(),
        }
      }),
      risk: String(call.args.risk ?? 'medium') as TaskContractV1['risk'],
      planningMode: String(call.args.planningMode ?? 'controlled') as TaskContractV1['planningMode'],
    }
    const parsed = parseTaskContract(contract)
    if (!parsed.value) {
      return { id: call.id, name: call.name, result: '', error: `TASK_CONTRACT_INVALID: ${parsed.diagnostics.map(d => `${d.path}: ${d.message}`).join('; ')}` }
    }
    const scan = scanText(JSON.stringify(parsed.value))
    if (scan.hits.length > 0) {
      return { id: call.id, name: call.name, result: '', error: `TASK_CONTRACT_SECRET_BLOCKED: ${scan.hits.join(', ')}` }
    }
    const updated = ctx.pipelineRuns.saveContract(current.id, parsed.value)
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      event: { type: 'task-contract-created', pipelineId: updated.id, revision: updated.contractRevision, contract: parsed.value },
    })
    return {
      id: call.id,
      name: call.name,
      result: parsed.value.blockingQuestions.length > 0
        ? `Task Contract revision ${parsed.value.revision} сохранён. План заблокирован до ответа на вопросы.`
        : `Task Contract revision ${parsed.value.revision} сохранён и готов к одобрению.`,
    }
  },
}

const norm = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
// Определение доказательства — общее для всего продукта (`ai/evidence.ts`).
// Раньше копия жила здесь и применялась только на пайплайн-оси, а чек-лист
// блока C считал доказательством любую непустую строку. Ревью 28.07 назвало это
// двумя разными понятиями внутри одного продукта — теперь оно одно.

export const reportStepOutcomeHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.outcome || ctx.outcome.phase !== 'execute-step' || !ctx.outcome.planStepId) {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_STEP_CONTEXT_REQUIRED' }
    }
    if (!ctx.pipelineRuns || !ctx.plans || !ctx.planOutcomes || !ctx.runId) {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_RUNTIME_UNAVAILABLE' }
    }
    const pipeline = ctx.pipelineRuns.get(ctx.outcome.pipelineId)
    const plan = pipeline?.planId ? ctx.plans.get(pipeline.planId) : null
    const step = plan?.steps.find(item => item.id === ctx.outcome?.planStepId)
    if (!pipeline || !plan || !step || pipeline.projectPath !== ctx.projectPath || !step.spec) {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_STEP_MISMATCH' }
    }
    const parsed = parseStepOutcome({
      status: call.args.status,
      summary: call.args.summary,
      observations: list(call.args.observations).map(String),
      changedFiles: list(call.args.changedFiles).map(String),
      checks: list(call.args.checks),
      evidence: list(call.args.evidence).map(String),
      assumptionFailures: list(call.args.assumptionFailures).map(String),
      recommendedAction: call.args.recommendedAction,
    })
    if (!parsed.value) {
      return { id: call.id, name: call.name, result: '', error: `STEP_OUTCOME_INVALID: ${parsed.diagnostics.map(d => d.message).join('; ')}` }
    }
    const actualFiles = (ctx.runFilesTouched?.() ?? []).map(norm)
    const claimed = parsed.value.changedFiles.map(norm)
    const writeScope = step.spec.writeScope.map(norm)
    const hiddenWrite = actualFiles.some(path => !claimed.includes(path))
    const outOfScope = actualFiles.some(path => !writeScope.some(scope => path === scope || path.startsWith(`${scope}/`)))
    const actualChecks = new Map((ctx.runChecks?.() ?? [])
      .map(check => [norm(check.command), check.exitCode] as const))
    const verifiedChecks = parsed.value.checks.map(check => {
      if (!check.command) return check
      const actualExit = actualChecks.get(norm(check.command))
      return actualExit === undefined
        ? { ...check, status: 'not_run' as const, exitCode: undefined }
        : { ...check, status: actualExit === 0 ? 'passed' as const : 'failed' as const, exitCode: actualExit }
    })
    const passedChecks = new Set(verifiedChecks
      .filter(check => check.status === 'passed' && check.command)
      .map(check => norm(check.command ?? '')))
    const mandatoryFailed = step.spec.verification
      .some(command => !passedChecks.has(norm(command)))
    const invalidEvidence = parsed.value.evidence.some(item => !evidenceExists(ctx.projectPath, item))
    const missingExpectedFiles = step.spec.files.filter(path => !evidenceExists(ctx.projectPath, path))
    const outcome = {
      ...parsed.value,
      checks: verifiedChecks,
      assumptionFailures: [
        ...parsed.value.assumptionFailures,
        ...missingExpectedFiles.map(path => `Expected file is missing: ${path}`),
      ],
      status: outOfScope || hiddenWrite
        ? 'diverged' as const
        : parsed.value.status === 'succeeded' && (mandatoryFailed || invalidEvidence || missingExpectedFiles.length > 0)
          ? 'failed' as const
          : parsed.value.status,
    }
    const signature = failureSignature(outcome)
    const repeated = signature ? ctx.planOutcomes.countFailureSignature(plan.id, signature) : 0
    const decision = decideAdaptiveAction(outcome, {
      attempt: ctx.outcome.attempt ?? 1,
      maxAttempts: 3,
      repeatedFailureCount: repeated,
      budgetExhausted: (ctx.outcome.attempt ?? 1) >= 3 && outcome.status !== 'succeeded',
      transientError: outcome.recommendedAction === 'retry',
      policyBlocked: outcome.recommendedAction === 'ask-user' || outcome.recommendedAction === 'rollback',
      writeScopeViolated: outOfScope || hiddenWrite,
    })
    const saved = ctx.planOutcomes.finalize({
      planId: plan.id,
      stepId: step.id,
      planRevision: plan.planRevision,
      runId: ctx.runId,
      attempt: ctx.outcome.attempt ?? 1,
      status: outcome.status,
      outcome,
      failureSignature: signature,
      decision,
    })
    ctx.plans.updateStep(step.id, {
      // Правило 2 цикла: отказ от подтверждения ответственного действия ПРОПУСКАЕТ
      // шаг, а не роняет план. До 29.07 статус 'skipped' не ставила ни одна строка
      // кода — «отказ пропускает шаг» существовало только на словах, и ревью это
      // назвало прямо. Теперь blocked-исход шага кладётся как 'skipped': работа не
      // сделана, но и не провалена — остальные шаги идут дальше.
      status: outcome.status === 'succeeded' ? 'done' : outcome.status === 'blocked' ? 'skipped' : 'failed',
      result: outcome.summary,
      runId: ctx.runId,
      verificationStatus: outcome.checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
      changedFilesCount: actualFiles.length,
    })
    // §4.4/§4.5 ТЗ (блок D): связанные пункты чек-листа обновляются вместе с
    // шагом — но закрываются ТОЛЬКО по подтверждённому результату и только с
    // доказательством. Провалившийся или заблокированный шаг оставляет пункт
    // открытым: «шаг больше не выполняется» и «дело сделано» — разные вещи.
    const stepEvidence = outcome.status === 'succeeded'
      ? [...outcome.evidence, ...actualFiles].map(item => item.trim()).filter(Boolean)[0] ?? null
      : null
    if (stepEvidence && ctx.tasks) {
      for (const task of ctx.tasks.list(ctx.projectPath)) {
        if (task.planStepId === step.id && !task.done) ctx.tasks.complete(task.id, stepEvidence)
      }
    }
    // Блок D §4.5: план дошёл до конца → человек получает ИТОГ обычным
    // сообщением ассистента (решение постановщика 29.07: не системной строкой —
    // это ответ на его задачу, а не служебная отметка).
    //
    // Хрупкая зона НЕ ТРОНУТА: подписка `ai.onEvent` в Chat.tsx не правится и не
    // пересоздаётся. Мы шлём событие `text` — того же типа, что уже льётся в
    // поток ответа; для renderer'а это обычный кусок ответа ассистента.
    // Оформление итога не изобретается: текст берётся у готовой `summarizePlan`,
    // а внешний вид — зона Павла.
    const afterStep = ctx.plans.get(plan.id)?.steps ?? []
    if (afterStep.length > 0 && pickNextStep(afterStep) === null) {
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'text', text: `

${summarizePlan(plan.title, afterStep)}` },
      })
    }
    const remainingSteps = afterStep.filter(item => item.status !== 'done').length
    ctx.pipelineRuns.advance(pipeline.id, {
      step: nextPipelineStep(decision, remainingSteps),
      agentRunId: ctx.runId,
    })
    if (decision.action === 'replan') ctx.outcome.phase = 'replan'
    if (saved.inserted) {
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: {
          type: 'step-outcome-reported',
          planId: plan.id,
          stepId: step.id,
          status: outcome.status,
          decision,
          attempt: ctx.outcome.attempt ?? 1,
        },
      })
    }
    return {
      id: call.id,
      name: call.name,
      result: `Step outcome ${saved.inserted ? 'saved' : 'already finalized'}: ${outcome.status}; decision=${decision.action}; ${decision.reason}`,
    }
  },
}

/**
 * Доработка плана на ЧАТ-ПУТИ (§10 хвост, дефект 1).
 *
 * Отличий от outcome-ветки ровно три, и все три — про то, чего на этом пути не
 * существует: нет Task Contract'а (значит нет quality-скоринга), нет пайплайна
 * (значит некуда двигать фазу) и нет structured spec как обязательного условия —
 * `create_plan` на чат-пути его тоже не требует, и доработка обязана принимать
 * ровно то, что принимало создание. Всё остальное совпадает: тот же planId, та
 * же замена НЕзавершённых шагов, тот же рост ревизии.
 *
 * Цель доработки берётся из `ctx.revisePlanId` — рантайм считает её из якоря
 * продолжения. Модель id не выбирает: ошибись она номером, правка ушла бы в
 * чужой план.
 */
async function replanOnChatPath(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.plans) {
    return { id: call.id, name: call.name, result: '', error: 'REPLAN_STORAGE_UNAVAILABLE' }
  }
  const planId = ctx.revisePlanId ?? null
  const plan = planId != null ? ctx.plans.get(planId) : null
  if (!plan) {
    // Честная ошибка вместо тихой правки соседнего плана: без якоря продолжения
    // мы не знаем, что именно человек просил доработать.
    return { id: call.id, name: call.name, result: '', error: 'REPLAN_TARGET_REQUIRED' }
  }
  // План, рождённый Outcome-пайплайном, чат-ветка трогать НЕ ИМЕЕТ ПРАВА.
  //
  // Найдено ревью 28.07 и это регрессия САМОГО фикса дефекта 1. У такого плана
  // есть Task Contract, а значит quality gate и запрет на расширение writeScope
  // high-risk шагами (см. outcome-ветку ниже) — на чат-пути ни того, ни другого
  // нет. Хуже: на plan-шаге пайплайна режим прогона принудительно 'plan', в нём
  // матрица §5 карточку не показывает, и доработка проходила БЕЗ гейта качества
  // и БЕЗ нового согласования — то есть молча.
  //
  // `contractRevision`/`quality` проставляет ровно одна ветка — outcome'овая
  // (там есть контракт, которым они считаются), поэтому это честный признак
  // происхождения, а не эвристика.
  if (plan.contractRevision != null || plan.quality != null) {
    return {
      id: call.id, name: call.name, result: '',
      error: 'REPLAN_PIPELINE_OWNED: план создан Outcome-пайплайном и правится только внутри него (фаза replan). ' +
        'Сообщи это пользователю — молча переписывать такой план нельзя.',
    }
  }
  const reason = String(call.args.reason ?? '').trim()
  const steps = list(call.args.steps).flatMap(raw => {
    if (typeof raw !== 'object' || raw === null) return []
    const item = raw as Record<string, unknown>
    const title = String(item.title ?? '').trim()
    if (!title) return []
    const parsed = item.spec === undefined ? null : parsePlanStepSpec(item.spec).value
    return [{ title, detail: item.detail == null ? null : String(item.detail), ...(parsed ? { spec: parsed } : {}) }]
  })
  if (!reason || steps.length === 0) {
    return { id: call.id, name: call.name, result: '', error: 'REPLAN_INVALID: reason и steps обязательны' }
  }
  // Та же планка к описанию шага, что у create_plan на этом пути: доработка не
  // должна быть способом протащить тонкое ТЗ мимо проверки.
  const specFeedback = planSpecFeedback(steps)
  if (specFeedback) {
    return { id: call.id, name: call.name, result: `План не обновлён: требуется доработка.${specFeedback}` }
  }

  // История ревизий — best-effort: на чат-пути её может не быть, и это не повод
  // терять саму доработку.
  try { ctx.planOutcomes?.saveRevision(plan.id, plan.planRevision, reason, plan) } catch { /* история не критична */ }
  const previousRunId = plan.agentRunId
  const updated = ctx.plans.replacePending(plan.id, steps, {
    planRevision: plan.planRevision + 1,
    // Якорь переезжает на ТЕКУЩИЙ прогон: продолжение после нового approve
    // должно реплеить разговор с замечаниями, а не исходный план без них.
    agentRunId: ctx.runId ?? null,
  })
  // …и ровно поэтому прежний прогон надо отпустить ЗДЕСЬ. После переезда якоря
  // его чекпойнт не связан ни с одним планом, а releasePlanApproval ищет прогон
  // только через план — освободить было бы больше нечем, и каждая доработка
  // оставляла осиротевший снапшот истории навсегда (найдено ревью 28.07).
  if (previousRunId && previousRunId !== ctx.runId) {
    clearPlanAwaitingApproval(previousRunId)
    try { ctx.clearRunCheckpoint?.(previousRunId) } catch { /* уборка не критична */ }
  }
  ctx.sender.send('ai:event', {
    id: ctx.sendId,
    event: { type: 'plan-replanned', planId: plan.id, revision: updated.planRevision, reason, preservedSteps: updated.steps.filter(s => s.status === 'done').length },
  })

  // Новая ревизия — новое решение человека (§4.3: выполнение не начинается до
  // approve). Порог и матрица режимов те же, что у create_plan: план, который
  // только читает, автоутверждается и здесь.
  const gateApplies = planGateApplies({
    agentMode: ctx.agentMode,
    outcomePhase: null,
    planApprovalSetting: ctx.getSecretForDelegate?.('plan_approval_gate') === 'true',
    delegationDepth: ctx.delegationDepth,
  })
  const verdict = planApprovalVerdict(updated.steps.map(step => ({ title: step.title, detail: step.detail, spec: step.spec })))
  if (gateApplies && verdict.needsCard) {
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      event: {
        type: 'plan-approval',
        callId: call.id,
        planId: plan.id,
        title: updated.title,
        stepCount: updated.steps.length,
      },
    })
    markPlanAwaitingApproval(ctx.runId, plan.id)
    if (ctx.setAgentMode) ctx.setAgentMode('plan'); else ctx.agentMode = 'plan'
    return { id: call.id, name: call.name, result: awaitingApprovalResult({ id: plan.id, stepCount: updated.steps.length }) }
  }
  if (gateApplies) {
    return {
      id: call.id, name: call.name,
      result: `План #${plan.id} обновлён до ревизии ${updated.planRevision} и автоутверждён: ${explainVerdict(verdict)} ` +
        'Права на запись НЕ выданы: попытка изменить файлы или внешнюю систему пройдёт обычную проверку режима.',
    }
  }
  return {
    id: call.id, name: call.name,
    result: `План #${plan.id} обновлён до ревизии ${updated.planRevision}; шагов: ${updated.steps.length}.`,
  }
}

export const replanPlanHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    // §10 хвост, дефект 1. Карточка согласования говорит модели: «правь план
    // через replan_plan». Продолжение после «Доработать» — обычная отправка в
    // чат, outcome в ней нет и быть не может, поэтому проверка ниже отвергала
    // ЛЮБУЮ доработку на чат-пути. Своя ветка: тот же инструмент, тот же план,
    // только без Task Contract'а и пайплайна, которых на этом пути не бывает.
    if (!ctx.outcome) return replanOnChatPath(call, ctx)
    if (ctx.outcome.phase !== 'replan' || !ctx.pipelineRuns || !ctx.plans || !ctx.planOutcomes) {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_REPLAN_CONTEXT_REQUIRED' }
    }
    const pipeline = ctx.pipelineRuns.get(ctx.outcome.pipelineId)
    const plan = pipeline?.planId ? ctx.plans.get(pipeline.planId) : null
    if (!pipeline || !pipeline.taskContract || !plan || pipeline.projectPath !== ctx.projectPath) {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_PLAN_MISMATCH' }
    }
    const reason = String(call.args.reason ?? '').trim()
    const rawSteps = list(call.args.steps)
    const specs: PlanStepSpecV1[] = []
    const steps = rawSteps.flatMap((raw, index) => {
      if (typeof raw !== 'object' || raw === null) return []
      const item = raw as Record<string, unknown>
      const parsed = parsePlanStepSpec(item.spec)
      if (!parsed.value) throw new Error(`steps.${index}.spec invalid: ${parsed.diagnostics.map(d => d.message).join('; ')}`)
      specs.push(parsed.value)
      return [{ title: String(item.title ?? parsed.value.title), detail: item.detail == null ? null : String(item.detail), spec: parsed.value }]
    })
    if (!reason || steps.length === 0) {
      return { id: call.id, name: call.name, result: '', error: 'REPLAN_INVALID: reason и steps обязательны' }
    }
    const completedSpecs = plan.steps.filter(step => step.status === 'done' && step.spec).map(step => step.spec as PlanStepSpecV1)
    const quality = scorePlanQuality(pipeline.taskContract, [...completedSpecs, ...specs])
    if (quality.hardErrors.length > 0) {
      return { id: call.id, name: call.name, result: `Replan заблокирован quality gate:\n- ${quality.hardErrors.join('\n- ')}` }
    }
    const previousScope = new Set(plan.steps.filter(step => step.status !== 'done').flatMap(step => step.spec?.writeScope ?? []).map(norm))
    const expansion = specs.flatMap(spec => spec.writeScope).map(norm).some(path => !previousScope.has(path))
    if (expansion && specs.some(spec => spec.risk === 'high')) {
      return { id: call.id, name: call.name, result: '', error: 'REPLAN_APPROVAL_REQUIRED: high-risk writeScope expansion' }
    }
    ctx.planOutcomes.saveRevision(plan.id, plan.planRevision, reason, plan)
    const updated = ctx.plans.replacePending(plan.id, steps, {
      planRevision: plan.planRevision + 1,
      quality,
    })
    ctx.pipelineRuns.advance(pipeline.id, { step: 'execute' })
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      event: { type: 'plan-replanned', planId: plan.id, revision: updated.planRevision, reason, preservedSteps: completedSpecs.length },
    })
    return { id: call.id, name: call.name, result: `Plan #${plan.id} replanned to revision ${updated.planRevision}; completed steps preserved=${completedSpecs.length}` }
  },
}
