/**
 * Задача 7A: workflow = сохранённый повторяемый прогон. Здесь — ЧИСТАЯ логика
 * превращения прогона (agent_run) и его плана (plan_steps) в черновик
 * пользовательского workflow. IO (чтение прогона/плана, запись user_workflows)
 * живёт в ipc/workflows.ts; здесь только маппинг — пинуется.
 */
import type { WorkflowStep } from './types'

export interface PlanStepLike { title: string; detail?: string | null }
export interface RunLike { title: string | null }

/** Шаги плана прогона → шаги workflow. Инструкция = detail, при пустом — title. */
export function planToWorkflowSteps(steps: PlanStepLike[]): WorkflowStep[] {
  return steps.map((s, i) => {
    const detail = (s.detail ?? '').trim()
    return { id: `s${i + 1}`, title: s.title, instruction: detail || s.title }
  })
}

export interface DraftUserWorkflow {
  name: string
  description: string
  briefTemplate: string
  steps: WorkflowStep[]
}

/**
 * Черновик user-workflow из прогона + шагов его плана. Пустой план или прогон без
 * заголовка → честный отказ (пустышку не сохраняем — план это и стерёг `soonReason`).
 */
export function buildUserWorkflowFromRun(run: RunLike, planSteps: PlanStepLike[]): DraftUserWorkflow | { error: string } {
  const name = (run.title ?? '').trim()
  if (!name) return { error: 'no-title' }
  const steps = planToWorkflowSteps(planSteps)
  if (steps.length === 0) return { error: 'no-steps' }
  return {
    name,
    description: `Сохранено из прогона: ${name}`,
    briefTemplate: '',
    steps,
  }
}
