import { ipcMain } from 'electron'
import type { Plans, NewStep, PlanStatus, StepStatus } from '../storage/plans'
import type { AgentRuns } from '../storage/agent-runs'
import { planDecisionOutsideRun, type PlanContinuation } from '../ai/plan-await'
import { clearPlanAwaitingApproval } from '../ai/runner-shared'
import type { PlanDecision } from '../ai/plan-gate'

/** Ответ на решение по плану: что стало с планом и чем продолжать работу. */
export interface PlanApprovalResult {
  /** null — плана нет (удалён из UI, пока висела карточка). */
  planStatus: PlanStatus | null
  continuation: PlanContinuation | null
}

export function registerPlansIpc(plans: Plans, agentRuns?: AgentRuns): void {
  ipcMain.handle('plans:list', (_e, projectPath: string) => plans.list(projectPath))
  ipcMain.handle('plans:get', (_e, id: number) => plans.get(id))
  ipcMain.handle('plans:create', (_e, projectPath: string, title: string, steps: NewStep[]) =>
    plans.create(projectPath, title, steps)
  )
  ipcMain.handle('plans:set-status', (_e, id: number, status: PlanStatus) => {
    plans.updatePlanStatus(id, status)
  })
  ipcMain.handle('plans:update-step', (_e, id: number, patch: { status?: StepStatus; result?: string | null; runId?: string | null; verificationStatus?: string | null; changedFilesCount?: number | null }) => {
    plans.updateStep(id, patch)
  })
  ipcMain.handle('plans:remove', (_e, id: number) => plans.remove(id))

  /**
   * §10: решение по плану, принятое СНАРУЖИ прогона. Прогон, показавший
   * карточку, давно завершён — резолвить нечего и некому. Здесь мы меняем
   * статус плана и отдаём рендереру продолжение (текст + якорь чекпойнта);
   * отправляет его PlanConfirm обычным путём ai:send с resumeFromRunId.
   *
   * Плана может уже не быть: пользователь удалил его, пока висела карточка.
   * Это не ошибка — просто продолжать нечего.
   */
  ipcMain.handle('plans:resolve-approval', (_e, planId: number, decision: PlanDecision, feedback?: string): PlanApprovalResult => {
    const plan = plans.get(planId)
    if (!plan) return { planStatus: null, continuation: null }

    const outcome = planDecisionOutsideRun(decision, feedback, {
      id: plan.id,
      title: plan.title,
      agentRunId: plan.agentRunId,
    })
    plans.updatePlanStatus(plan.id, outcome.planStatus)
    if (outcome.releaseCheckpoint && plan.agentRunId) {
      // Отклонённый план не продолжится никогда — снапшот истории держать не за чем.
      try { agentRuns?.clearCheckpoint(plan.agentRunId) } catch { /* уборка не критична */ }
    }
    clearPlanAwaitingApproval(plan.agentRunId)
    return { planStatus: outcome.planStatus, continuation: outcome.continuation }
  })
}
