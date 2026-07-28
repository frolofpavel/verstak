// Распил ai.ts (2.1.10-E, срез 1): preflight Outcome-контекста ai:send.
//
// Вынесено из registerAiIpc БЕЗ изменения логики. Здесь живут две вещи:
//  · toolsForOutcomePhase — потолок возможностей фазы (main-process ceiling);
//  · preflightOutcome — валидация pipeline/phase/step ДО старта прогона.
//
// Fail-closed сохранён дословно: любая непроверенная комбинация pipeline/phase/step
// бросает ту же ошибку с тем же префиксом (рендерер различает их по префиксу).

import { pickNextStep } from '../../ai/plan-step-order'
import type { ToolContext } from '../tool-handlers'

const OUTCOME_READ_TOOLS = [
  'read_file',
  'list_directory',
  'search_project',
  'find_files',
  'find_definition',
  'find_references',
  'get_project_map',
  'read_journal',
  'memory_search',
  'conversation_search',
  'check_diagnostics',
] as const

export type OutcomePhase = 'refine' | 'plan' | 'execute-step' | 'verify' | 'replan'

/** Main-process capability ceiling: renderer/prompt cannot widen Outcome phases. */
export function toolsForOutcomePhase(phase: OutcomePhase): string[] | undefined {
  if (phase === 'refine') return [...OUTCOME_READ_TOOLS, 'submit_task_contract']
  if (phase === 'plan') {
    return [...OUTCOME_READ_TOOLS, 'delegate_task', 'delegate_parallel', 'create_plan']
  }
  if (phase === 'replan') {
    return [...OUTCOME_READ_TOOLS, 'delegate_task', 'delegate_parallel', 'replan_plan']
  }
  if (phase === 'verify') return [...OUTCOME_READ_TOOLS, 'run_command', 'attest_verification']
  return undefined
}

/** Server validates this against durable pipeline state before exposing it to tools. */
export interface OutcomeRequest {
  pipelineId: number
  phase: OutcomePhase
  planStepId?: number
  attempt?: number
}

export interface OutcomePreflightDeps {
  pipelineRuns?: ToolContext['pipelineRuns']
  plans?: ToolContext['plans']
  planOutcomes?: ToolContext['planOutcomes']
}

export interface OutcomePreflightResult {
  /** Нормализованный outcome: для execute-step без явного planStepId сюда доезжают
   *  подобранный шаг и номер попытки. */
  outcome: OutcomeRequest
  /** SERVER OUTCOME STEP-инструкция для execute-step; null для остальных фаз. */
  stepInstruction: string | null
}

/**
 * Сверяет запрошенный Outcome-контекст с durable-состоянием pipeline/плана.
 * Бросает при любой непроверенной комбинации — прогон в этом случае не стартует.
 */
export function preflightOutcome(
  outcome: OutcomeRequest,
  projectPath: string | null,
  deps: OutcomePreflightDeps,
): OutcomePreflightResult {
  const pipeline = deps.pipelineRuns?.get(outcome.pipelineId)
  const phases = new Set(['refine', 'plan', 'execute-step', 'verify', 'replan'])
  if (!Number.isInteger(outcome.pipelineId) || !phases.has(outcome.phase) || !pipeline || !projectPath || pipeline.projectPath !== projectPath) {
    throw new Error('OUTCOME_CONTEXT_INVALID: pipeline/phase не подтверждены main process')
  }
  if (outcome.phase !== 'execute-step') return { outcome, stepInstruction: null }

  const plan = pipeline.planId ? deps.plans?.get(pipeline.planId) : null
  const requestedStepId = outcome.planStepId
  // Блок D §4.4: следующий шаг — первый КАНДИДАТ, чьи зависимости готовы.
  // Прежний `find(status !== done)` возвращал провалившийся или пропущенный шаг
  // снова и снова (план упирался в него навсегда) и не смотрел на dependsOn
  // вовсе — тот проверялся только quality-гейтом при СОЗДАНИИ плана.
  const step = requestedStepId
    ? plan?.steps.find(item => item.id === requestedStepId)
    : (plan ? pickNextStep(plan.steps) ?? undefined : undefined)
  let resolved = outcome
  if (step && !outcome.planStepId) {
    const attempts = deps.planOutcomes?.list(plan?.id ?? 0)
      .filter(item => item.stepId === step.id).length ?? 0
    resolved = { ...outcome, planStepId: step.id, attempt: attempts + 1 }
  }
  if (!step || step.planId !== pipeline.planId || step.status === 'done') {
    throw new Error('OUTCOME_STEP_CONTEXT_INVALID: step не принадлежит активному плану или уже завершён')
  }
  const stepInstruction = [
    'SERVER OUTCOME STEP: execute exactly this one plan step, not the whole plan.',
    `Step id=${step.id}: ${step.title}`,
    step.detail ? `Detail: ${step.detail}` : '',
    step.spec ? `Structured spec: ${JSON.stringify(step.spec)}` : '',
    'Before the final answer call report_step_outcome with actual changed files, mandatory checks and evidence.',
  ].filter(Boolean).join('\n')
  return { outcome: resolved, stepInstruction }
}
