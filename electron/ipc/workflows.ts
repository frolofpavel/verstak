import { ipcMain } from 'electron'
import { WORKFLOWS, getWorkflow } from '../ai/workflows/registry'
import { buildWorkflowPrompt } from '../ai/workflows/workflow-runner'
import { buildUserWorkflowFromRun } from '../ai/workflows/from-run'
import type { WorkflowDefinition, WorkflowRunState } from '../ai/workflows/types'
import type { UserWorkflows } from '../storage/user-workflows'

/**
 * IPC для Agency Workflows.
 *
 * Задача 7A: workflow = сохранённый повторяемый прогон. К built-in каталогу
 * добавлены ПОЛЬЗОВАТЕЛЬСКИЕ workflow (user_workflows), сохранённые из прогона:
 *  - workflows:list         → каталог built-in + user (source/userId для UI и удаления).
 *  - workflows:start        → resolve built-in ИЛИ user (id `user:<n>`), промпт + план.
 *  - workflows:save-from-run→ прогон + его план → user_workflow (три глагола: СОХРАНИТЬ).
 *  - workflows:remove-user  → удалить пользовательский workflow.
 */

const USER_PREFIX = 'user:'

export interface WorkflowsIpcDeps {
  // Детерминированное создание плана (та же функция, что recordPlan/create_plan).
  createPlan: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) => { id: number }
  // Прогон по runId (для СОХРАНИТЬ: имя = заголовок прогона).
  getRun: (runId: string) => { title: string | null } | null
  // Шаги плана прогона (plans, связанные по agent_run_id) — источник шагов workflow.
  getPlanSteps: (projectPath: string, runId: string) => Array<{ title: string; detail?: string | null }>
  userWorkflows: UserWorkflows
  getProjectRoot: () => string | null
}

export function registerWorkflowsIpc(deps: WorkflowsIpcDeps): void {
  // user_workflow → WorkflowDefinition (для start/промпта одинаково с built-in).
  const resolveDef = (workflowId: string): WorkflowDefinition | undefined => {
    if (workflowId.startsWith(USER_PREFIX)) {
      const uid = Number(workflowId.slice(USER_PREFIX.length))
      const wf = Number.isFinite(uid) ? deps.userWorkflows.get(uid) : null
      if (!wf) return undefined
      return { id: workflowId, name: wf.name, description: wf.description ?? '', icon: wf.icon ?? undefined, steps: wf.steps }
    }
    return getWorkflow(workflowId)
  }

  ipcMain.handle('workflows:list', () => {
    const builtIn = WORKFLOWS.map(w => ({
      id: w.id, name: w.name, description: w.description, icon: w.icon ?? null,
      stepCount: w.steps.length, source: 'built-in' as const, userId: null as number | null,
    }))
    const root = deps.getProjectRoot()
    const user = root
      ? deps.userWorkflows.listByProject(root).map(w => ({
          id: `${USER_PREFIX}${w.id}`, name: w.name, description: w.description ?? '', icon: w.icon,
          stepCount: w.steps.length, source: 'user' as const, userId: w.id,
        }))
      : []
    // Пользовательские сверху (свежие/свои раньше готовых), потом built-in.
    return [...user, ...builtIn]
  })

  ipcMain.handle('workflows:start', (_e, workflowId: string, projectPath: string, brief: string) => {
    const def = resolveDef(workflowId)
    if (!def) {
      return { error: 'unknown-workflow', message: `Нет workflow "${workflowId}"` }
    }

    const prompt = buildWorkflowPrompt(def, brief ?? '')

    // Детерминированно создаём план из шагов workflow — чтобы он сразу появился
    // в WorkflowView, не дожидаясь, пока агент вызовет create_plan.
    const plan = deps.createPlan(
      projectPath,
      def.name,
      def.steps.map(s => ({ title: s.title, detail: s.instruction }))
    )

    const runState: WorkflowRunState = {
      workflowId: def.id,
      status: 'pending',
      currentStep: 0,
      startedAt: Date.now(),
      planId: plan.id,
      brief: brief ?? ''
    }

    return { prompt, planId: plan.id, runState }
  })

  // СОХРАНИТЬ: прогон + шаги его плана → пользовательский workflow. Пустой план или
  // прогон без заголовка → честный отказ (полу-фичи «пустой workflow» не заводим).
  ipcMain.handle('workflows:save-from-run', (_e, runId: string) => {
    const root = deps.getProjectRoot()
    if (!root) return { error: 'no-project', message: 'Нет активного проекта' }
    const run = deps.getRun(runId)
    if (!run) return { error: 'no-run', message: 'Прогон не найден' }
    const steps = deps.getPlanSteps(root, runId)
    const draft = buildUserWorkflowFromRun({ title: run.title }, steps)
    if ('error' in draft) {
      const msg = draft.error === 'no-steps'
        ? 'У этого прогона нет плана с шагами — сохранять как workflow нечего.'
        : 'У прогона нет заголовка.'
      return { error: draft.error, message: msg }
    }
    const saved = deps.userWorkflows.save(root, {
      name: draft.name, description: draft.description, briefTemplate: draft.briefTemplate, steps: draft.steps,
    })
    return { ok: true, id: saved.id, name: saved.name, stepCount: saved.steps.length }
  })

  ipcMain.handle('workflows:remove-user', (_e, id: number) => {
    deps.userWorkflows.remove(id)
    return { ok: true }
  })
}
