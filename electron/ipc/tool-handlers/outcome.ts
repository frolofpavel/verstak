import { scanText } from '../../ai/secret-scanner'
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
import type { ToolHandler } from './shared'

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
const evidenceExists = (projectPath: string, evidence: string): boolean => {
  if (/^(run|event|artifact|command):\S+/i.test(evidence)) return true
  const absolute = isAbsolute(evidence) ? resolve(evidence) : resolve(projectPath, evidence)
  const rel = relative(projectPath, absolute)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(absolute)
}

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
      status: outcome.status === 'succeeded' ? 'done' : 'failed',
      result: outcome.summary,
      runId: ctx.runId,
      verificationStatus: outcome.checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
      changedFilesCount: actualFiles.length,
    })
    const remainingSteps = ctx.plans.get(plan.id)?.steps
      .filter(item => item.status !== 'done').length ?? 0
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

export const replanPlanHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.outcome || ctx.outcome.phase !== 'replan' || !ctx.pipelineRuns || !ctx.plans || !ctx.planOutcomes) {
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
