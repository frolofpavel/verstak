import type { AgentRunEvent, PipelineBrief, PipelineStep, TaskContractV1, VerificationOverall } from '../types/api'
import { TASK_SPEC_CONTRACT } from './task-spec'

/** Тон Verify-шага + можно ли переходить к Proof. passed → зелёный путь;
 *  partial/not_run → жёлтый (дожать); failed → красный (фикс/откат). */
export function verifyState(overall: VerificationOverall | null | undefined): {
  tone: 'pass' | 'warn' | 'fail'
  canProof: boolean
} {
  if (overall === 'passed') return { tone: 'pass', canProof: true }
  if (overall === 'failed') return { tone: 'fail', canProof: false }
  return { tone: 'warn', canProof: false } // partial / not_run / null
}

/** Шаги Outcome pipeline: raw brief → refine contract → compiled plan → proof. */
const STEP_ORDER: Record<PipelineStep, number> = {
  brief: 1, refine: 2, plan: 3, execute: 4, verify: 5, review: 6, proof: 7, completed: 7, cancelled: 7, blocked: 7,
}

/** {index 1-based, total} шага для баннера «Pipeline · N/6». */
export function pipelineStepIndex(step: PipelineStep): { index: number; total: number } {
  return { index: STEP_ORDER[step] ?? 1, total: 7 }
}

/** Пустой бриф для инициализации формы визарда. */
export const EMPTY_BRIEF: PipelineBrief = { goal: '', constraints: '', dod: '' }

/** Демо-бриф для «Попробовать Pipeline» из онбординга (First Win, D10). */
export const SAMPLE_BRIEF: PipelineBrief = {
  goal: 'Исправить ошибки типов в проекте (tsc)',
  constraints: 'Не трогать конфиги сборки и зависимости',
  dod: 'npm run type проходит без ошибок',
}

/**
 * Бриф готов к «Сформировать план», когда заданы цель и Definition of Done.
 * Границы (constraints) опциональны — не каждая задача их требует.
 */
export function isBriefReady(brief: PipelineBrief): boolean {
  return brief.goal.trim().length > 0
}

export function buildRefinePrompt(brief: PipelineBrief): string {
  return [
    `Исходная задача пользователя: ${brief.goal.trim()}`,
    `Предварительные ограничения: ${brief.constraints.trim() || 'не заданы'}`,
    `Предварительный DoD: ${brief.dod.trim() || 'не задан — выведи из задачи или задай blocking question'}`,
    '',
    'Это фаза Outcome refine. Только читай релевантный код и факты проекта; ничего не изменяй.',
    'После исследования ОБЯЗАТЕЛЬНО вызови submit_task_contract.',
    'Не выдумывай repoEvidence: указывай только реально прочитанные пути и символы.',
    'Если без ответа пользователя опасно продолжать — сохрани вопрос в blockingQuestions.',
  ].join('\n')
}

export function buildPlanningProtocol(contract: TaskContractV1): string {
  if (contract.planningMode === 'quick') {
    return [
      'Planning protocol QUICK: один planner, только релевантные файлы, один финальный plan.',
      'После самостоятельной проверки вызови create_plan ровно один раз.',
    ].join('\n')
  }
  const contractInstruction = 'Каждый critic/planner обязан сверять вывод с Task Contract и оставаться read-only.'
  if (contract.planningMode === 'controlled' || (contract.risk === 'low' && contract.repoEvidence.length <= 1)) {
    return [
      'Planning protocol CONTROLLED: подготовь черновик, затем вызови delegate_task с role=critic.',
      'Передай критику полный черновик и Task Contract; учти замечания, затем вызови create_plan ровно один раз.',
      contractInstruction,
      contract.planningMode === 'deep'
        ? 'Deep tournament сокращён до controlled: задача low-risk и затрагивает одну repo-зону.'
        : '',
    ].filter(Boolean).join('\n')
  }
  return [
    'Planning protocol DEEP:',
    '1. Вызови delegate_parallel: до трёх role=researcher, каждому дай отдельную repo-зону.',
    '2. По находкам вызови delegate_parallel: ровно два независимых role=planner с общей rubric Task Contract.',
    '3. Вызови delegate_task role=critic для сравнения двух candidates по coverage, dependencies, risks и verification.',
    '4. Сам синтезируй один structured plan и вызови create_plan ровно один раз.',
    contractInstruction,
  ].join('\n')
}

/**
 * Промпт Plan-шага (спек §3.2). Read-only: модель составляет план и вызывает
 * create_plan, НЕ трогая файлы.
 */
export function buildPlanPrompt(brief: PipelineBrief, contract?: TaskContractV1 | null): string {
  const constraints = brief.constraints.trim() || '—'
  const contractBlock = contract
    ? [
        `Task Contract revision: ${contract.revision}`,
        `Уточнённая цель: ${contract.goal}`,
        `Критерии: ${contract.successCriteria.map(item => `${item.id}: ${item.text}`).join('; ')}`,
        `Repo evidence: ${contract.repoEvidence.map(item => `${item.path}${item.symbol ? `#${item.symbol}` : ''}`).join(', ') || '—'}`,
        `Planning mode: ${contract.planningMode}`,
        buildPlanningProtocol(contract),
      ]
    : []
  return [
    `Задача: ${brief.goal.trim()}`,
    `Не трогать: ${constraints}`,
    `DoD: ${brief.dod.trim()}`,
    ...contractBlock,
    '',
    'Составь исполнимый structured plan из 1–7 шагов. НЕ вноси изменений в файлы.',
    'Для каждого шага заполни spec: key, intent, files/symbols/actions, dependsOn, readScope/writeScope, acceptanceCriterionIds, verification, expectedEvidence, rollback, role, execution, risk.',
    'Вызови create_plan один раз только с финальной версией.',
    '',
    TASK_SPEC_CONTRACT,
  ].join('\n')
}

/**
 * Промпт Execute-шага (спек §3.3). Выполнить утверждённый план + обязательный
 * attest_verification по DoD на финале.
 */
export function buildExecutePrompt(brief: PipelineBrief, planId: number, requireReviewGate = false): string {
  const lines = [
    `Выполни утверждённый план (plan id=${planId}).`,
    'Иди по шагам ПО ОДНОМУ, строго по detail-ТЗ каждого шага (файлы, что сделать, критерий готовности). Не перескакивай и не объединяй шаги.',
    `DoD: ${brief.dod.trim()}`,
    'По завершении ОБЯЗАТЕЛЬНО вызови attest_verification с task_summary и checks из DoD.',
  ]
  if (requireReviewGate) {
    lines.push(
      'Agency gate: after successful attest_verification, call review_before_commit before the final answer.',
      'Pass task_brief plus verify_commands from DoD. Do not finish until the tool returns "REVIEW GATE: ПРОЙДЕНО".',
    )
  }
  return lines.join('\n')
}

/**
 * runId для Proof Pack: приоритет — привязанный к прогону pipeline; иначе
 * прогон того же чата; иначе null. На свежайший прогон проекта не падаем:
 * для Proof это слишком слабая связка.
 * runs — список agent_runs проекта новейшими первыми (agentRuns.list).
 */
export function resolveProofRunId(
  agentRunId: string | null,
  chatId: number | null,
  runs: ReadonlyArray<{ runId: string; chatId: number | null }>,
): string | null {
  if (agentRunId) return agentRunId
  const sameChat = runs.find(r => r.chatId === chatId)
  return sameChat?.runId ?? null
}

/** runId для pipeline после Execute: приоритет — уже привязанный, затем sendId, затем тот же чат. */
export function resolvePipelineRunId(
  agentRunId: string | null,
  sendId: number | null,
  chatId: number | null,
  runs: ReadonlyArray<{ runId: string; chatId: number | null; sendId?: number | null }>,
): string | null {
  if (agentRunId) return agentRunId
  if (sendId != null) {
    const bySend = runs.find(r => r.sendId === sendId)
    if (bySend) return bySend.runId
  }
  return resolveProofRunId(null, chatId, runs)
}

/** Режим агента для авто-send шага pipeline. */
export type PipelineSendMode = 'plan' | 'accept-edits'

export interface PipelineSendOptions {
  requireReviewGate?: boolean
  taskContract?: TaskContractV1 | null
}

/**
 * Параметры авто-send для шага pipeline: текст промпта + режим агента.
 *  - plan → read-only (mode 'plan'), buildPlanPrompt;
 *  - execute → правки (mode 'accept-edits'), buildExecutePrompt с planId;
 *  - остальные шаги (verify/proof/…) авто-send не делают → null.
 */
export function buildPipelineSend(
  step: PipelineStep,
  brief: PipelineBrief,
  planId: number | null,
  opts: PipelineSendOptions = {},
): { text: string; mode: PipelineSendMode; outcomePhase?: 'refine' | 'plan' | 'execute-step' } | null {
  if (step === 'refine') return { text: buildRefinePrompt(brief), mode: 'plan', outcomePhase: 'refine' }
  if (step === 'plan') return { text: buildPlanPrompt(brief, opts.taskContract), mode: 'plan', outcomePhase: 'plan' }
  if (step === 'execute') return { text: buildExecutePrompt(brief, planId ?? 0, opts.requireReviewGate === true), mode: 'accept-edits', outcomePhase: 'execute-step' }
  return null
}

export type ReviewGateState = 'missing' | 'passed' | 'failed'

export function reviewGateState(
  events: ReadonlyArray<Pick<AgentRunEvent, 'kind' | 'label' | 'detail' | 'status'>>,
): { state: ReviewGateState; detail: string | null } {
  const reviews = events.filter(e => e.kind === 'tool_call' && e.label === 'review_before_commit')
  const last = reviews[reviews.length - 1]
  if (!last) return { state: 'missing', detail: null }
  const detail = last.detail ?? ''
  if (last.status === 'ok' && detail.includes('REVIEW GATE: ПРОЙДЕНО')) {
    return { state: 'passed', detail }
  }
  return { state: 'failed', detail: detail || last.status || null }
}

export function resolveReviewCandidateRunIds(
  agentRunId: string | null,
  chatId: number | null,
  runs: ReadonlyArray<{ runId: string; chatId: number | null }>,
): string[] {
  const ids: string[] = []
  if (agentRunId) ids.push(agentRunId)
  for (const r of runs) {
    if (r.chatId === chatId && !ids.includes(r.runId)) ids.push(r.runId)
  }
  return ids
}
