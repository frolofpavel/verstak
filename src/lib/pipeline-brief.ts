import type { PipelineBrief, PipelineStep, VerificationOverall } from '../types/api'
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

/** Шаги «N/5» для баннера: brief(1) собирается в визарде, дальше plan→proof. */
const STEP_ORDER: Record<PipelineStep, number> = {
  brief: 1, plan: 2, execute: 3, verify: 4, proof: 5, completed: 5, cancelled: 5, blocked: 4,
}

/** {index 1-based, total} шага для баннера «Pipeline · N/5». */
export function pipelineStepIndex(step: PipelineStep): { index: number; total: number } {
  return { index: STEP_ORDER[step] ?? 1, total: 5 }
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
  return brief.goal.trim().length > 0 && brief.dod.trim().length > 0
}

/**
 * Промпт Plan-шага (спек §3.2). Read-only: модель составляет план и вызывает
 * create_plan, НЕ трогая файлы.
 */
export function buildPlanPrompt(brief: PipelineBrief): string {
  const constraints = brief.constraints.trim() || '—'
  return [
    `Задача: ${brief.goal.trim()}`,
    `Не трогать: ${constraints}`,
    `DoD: ${brief.dod.trim()}`,
    '',
    'Составь план из 3–7 шагов. НЕ вноси изменений в файлы.',
    'Вызови create_plan. В конце — риски и список файлов которые затронешь.',
    '',
    TASK_SPEC_CONTRACT,
  ].join('\n')
}

/**
 * Промпт Execute-шага (спек §3.3). Выполнить утверждённый план + обязательный
 * attest_verification по DoD на финале.
 */
export function buildExecutePrompt(brief: PipelineBrief, planId: number): string {
  return [
    `Выполни утверждённый план (plan id=${planId}).`,
    'Иди по шагам ПО ОДНОМУ, строго по detail-ТЗ каждого шага (файлы, что сделать, критерий готовности). Не перескакивай и не объединяй шаги.',
    `DoD: ${brief.dod.trim()}`,
    'По завершении ОБЯЗАТЕЛЬНО вызови attest_verification с task_summary и checks из DoD.',
  ].join('\n')
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
): { text: string; mode: PipelineSendMode } | null {
  if (step === 'plan') return { text: buildPlanPrompt(brief), mode: 'plan' }
  if (step === 'execute') return { text: buildExecutePrompt(brief, planId ?? 0), mode: 'accept-edits' }
  return null
}
