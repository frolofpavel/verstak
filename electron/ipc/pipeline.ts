import { app, dialog, ipcMain } from 'electron'
import { join } from 'path'
import type {
  PipelineRuns,
  PipelineMode,
  PipelineBrief,
  PipelineStep,
  PipelineRun,
  OutcomeEffortLevel,
} from '../storage/pipeline-runs'
import type { PlanOutcomes } from '../storage/plan-outcomes'
import type { Plans } from '../storage/plans'
import { nextPipelineStep } from '../ai/outcome-controller'
import { buildOutcomePassport, writeOutcomePassportFile } from '../ai/outcome-passport'
import { scanText } from '../ai/secret-scanner'
import type { AgentJobs } from '../storage/agent-jobs'
import type { AgentRuns } from '../storage/agent-runs'
import type { Verifications } from '../storage/verifications'

/**
 * IPC Pipeline Brief→Proof (спек, шаг D2). Тонкая обвязка поверх storage-фасада
 * createPipelineRuns — без бизнес-логики, только проброс + projectRoot для start.
 * Bridge в preload.ts + типы в api.d.ts.
 */
export interface PipelineDeps {
  pipeline: PipelineRuns
  planOutcomes: PlanOutcomes
  plans: Plans
  getProjectRoot: () => string | null
  agentJobs?: AgentJobs
  agentRuns?: AgentRuns
  verifications?: Verifications
}

export function registerPipelineIpc(deps: PipelineDeps): void {
  const { pipeline, planOutcomes, plans, getProjectRoot } = deps
  const reconcileLatestOutcome = (run: PipelineRun | null): PipelineRun | null => {
    if (!run?.planId || (run.step !== 'execute' && run.step !== 'blocked')) return run
    const latest = planOutcomes.list(run.planId).at(-1)
    if (!latest?.decision) return run
    const plan = plans.get(run.planId)
    const step = plan?.steps.find(item => item.id === latest.stepId)
    if (!plan || !step) return run
    plans.updateStep(step.id, {
      status: latest.status === 'succeeded' ? 'done' : 'failed',
      result: latest.outcome.summary,
      runId: latest.runId,
      verificationStatus: latest.outcome.checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
      changedFilesCount: latest.outcome.changedFiles.length,
    })
    const remaining = plans.get(plan.id)?.steps.filter(item => item.status !== 'done').length ?? 0
    return pipeline.advance(run.id, {
      step: nextPipelineStep(latest.decision, remaining),
      agentRunId: latest.runId,
    })
  }

  // pipeline:start — создать прогон для активного проекта. step='plan' (бриф
  // собран в визарде до старта). null если проект не открыт.
  ipcMain.handle(
    'pipeline:start',
    (
      _e,
      opts: {
        mode: PipelineMode
        effortLevel?: OutcomeEffortLevel
        brief: PipelineBrief
        chatId?: number | null
        workflowId?: string | null
      },
    ): PipelineRun | null => {
      const projectPath = getProjectRoot()
      if (!projectPath) return null
      return pipeline.create({
        projectPath,
        mode: opts.mode,
        effortLevel: opts.effortLevel,
        brief: opts.brief,
        chatId: opts.chatId ?? null,
        workflowId: opts.workflowId ?? null,
        step: 'refine',
      })
    },
  )

  // pipeline:advance — продвинуть шаг / привязать planId / runId.
  ipcMain.handle(
    'pipeline:advance',
    (
      _e,
      id: number,
      patch: { step?: PipelineStep; planId?: number | null; agentRunId?: string | null; chatId?: number | null },
    ): PipelineRun | null => pipeline.advance(id, patch),
  )

  // pipeline:getActive — активный (НЕтерминальный) прогон проекта для баннера.
  ipcMain.handle(
    'pipeline:getActive',
    (_e, projectPath: string): PipelineRun | null => reconcileLatestOutcome(pipeline.getActive(projectPath)),
  )
  ipcMain.handle('pipeline:list', (_e, projectPath: string, limit?: number) =>
    projectPath ? pipeline.list(projectPath, limit) : [])

  // pipeline:cancel — отменить прогон (step='cancelled').
  ipcMain.handle('pipeline:cancel', (_e, id: number): void => {
    pipeline.cancel(id)
  })
  ipcMain.handle('pipeline:list-step-outcomes', (_e, planId: number) =>
    planOutcomes.list(planId))
  ipcMain.handle('pipeline:list-revisions', (_e, planId: number) =>
    planOutcomes.revisions(planId))
  ipcMain.handle('pipeline:metrics', (_e, projectPath: string) =>
    pipeline.metrics(projectPath))
  ipcMain.handle('pipeline:export-passport', async (_e, pipelineId: number) => {
    try {
      const run = pipeline.get(pipelineId)
      const projectPath = getProjectRoot()
      if (!run || !projectPath || run.projectPath !== projectPath) {
        return { ok: false, error: 'Прогон не найден в активном проекте.' }
      }
      const plan = run.planId ? plans.get(run.planId) : null
      const jobs = deps.agentJobs?.listProject(projectPath).filter(job => job.pipelineId === run.id) ?? []
      const verification = run.agentRunId
        ? deps.verifications?.latestByRunId(projectPath, run.agentRunId) ?? null
        : deps.verifications?.latest(projectPath, run.chatId) ?? null
      const agentRun = run.agentRunId ? deps.agentRuns?.get(run.agentRunId) ?? null : null
      const markdown = buildOutcomePassport({
        pipeline: run,
        plan,
        jobs,
        verification,
        route: agentRun ? {
          providerId: agentRun.providerId ?? 'unknown',
          model: agentRun.model ?? 'unknown',
          accountId: agentRun.accountId,
        } : null,
        metrics: pipeline.metrics(projectPath),
      })
      const result = await dialog.showSaveDialog({
        title: 'Сохранить паспорт результата',
        defaultPath: join(app.getPath('downloads'), `verstak-result-${run.id}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
      writeOutcomePassportFile(result.filePath, markdown)
      return { ok: true, path: result.filePath }
    } catch (cause) {
      return { ok: false, error: scanText(cause instanceof Error ? cause.message : String(cause)).redacted }
    }
  })
}
