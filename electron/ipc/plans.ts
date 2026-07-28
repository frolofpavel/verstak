import { ipcMain } from 'electron'
import type { Plans, NewStep, PlanStatus, StepStatus } from '../storage/plans'
import type { AgentRuns } from '../storage/agent-runs'
import { planDecisionOutsideRun, type PlanContinuation } from '../ai/plan-await'
import { planApprovalVerdict } from '../ai/plan-threshold'
import { clearPlanAwaitingApproval } from '../ai/runner-shared'
import type { PlanDecision } from '../ai/plan-gate'

/** Ответ на решение по плану: что стало с планом и чем продолжать работу. */
export interface PlanApprovalResult {
  /** null — плана нет (удалён из UI, пока висела карточка). */
  planStatus: PlanStatus | null
  continuation: PlanContinuation | null
}

/**
 * §10 хвост (дефект 5): карточка снята БЕЗ решения — Stop, Shift+Esc, закрытие
 * проекта, удаление плана.
 *
 * Прогон, показавший карточку, помечает себя «план ждёт решения», и финализация
 * ради этого НЕ удаляет его чекпойнт. Снимала пометку ровно одна дорога —
 * `plans:resolve-approval`, то есть кнопка. Всё остальное чистило только слот в
 * интерфейсе, а снапшот полной истории прогона оставался в БД навсегда.
 *
 * Решения здесь нет и не выдумывается: статус плана не трогаем, план остаётся
 * виден в «Планах». Освобождается только то, чем всё равно уже не
 * воспользоваться — продолжение запускала карточка, а её больше нет.
 */
export function releasePlanApproval(plans: Plans, agentRuns: AgentRuns | undefined, planId: number): void {
  const runId = plans.get(planId)?.agentRunId ?? null
  if (!runId) return
  clearPlanAwaitingApproval(runId)
  try { agentRuns?.clearCheckpoint(runId) } catch { /* уборка не критична */ }
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
  ipcMain.handle('plans:remove', (_e, id: number) => {
    // Плана не станет — держать его чекпойнт незачем (порядок важен: после
    // удаления связь план→прогон уже не прочитать).
    releasePlanApproval(plans, agentRuns, id)
    plans.remove(id)
  })
  /** §10 хвост: карточка снята без решения. Освобождает удержанный чекпойнт. */
  ipcMain.handle('plans:release-approval', (_e, planId: number) => {
    releasePlanApproval(plans, agentRuns, planId)
  })

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

    // Правило 2 цикла: пауза одна — перед ответственным действием. Какие шаги
    // ответственные, знает тот же порог §4.2, что решал про карточку; здесь мы
    // берём его вердикт и называем эти шаги в продолжении поимённо.
    const verdict = planApprovalVerdict(plan.steps.map(step => ({
      title: step.title,
      detail: step.detail,
      spec: step.spec,
    })))
    const outcome = planDecisionOutsideRun(decision, feedback, {
      id: plan.id,
      title: plan.title,
      agentRunId: plan.agentRunId,
      ...(verdict.reason === 'responsible-action' ? { responsibleSteps: verdict.triggeredBy } : {}),
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
