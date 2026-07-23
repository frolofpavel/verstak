import { ipcMain } from 'electron'
import type {
  PipelineRuns,
  PipelineMode,
  PipelineBrief,
  PipelineStep,
  PipelineRun,
} from '../storage/pipeline-runs'

/**
 * IPC Pipeline Brief→Proof (спек, шаг D2). Тонкая обвязка поверх storage-фасада
 * createPipelineRuns — без бизнес-логики, только проброс + projectRoot для start.
 * Bridge в preload.ts + типы в api.d.ts.
 */
export interface PipelineDeps {
  pipeline: PipelineRuns
  getProjectRoot: () => string | null
}

export function registerPipelineIpc(deps: PipelineDeps): void {
  const { pipeline, getProjectRoot } = deps

  // pipeline:start — создать прогон для активного проекта. step='plan' (бриф
  // собран в визарде до старта). null если проект не открыт.
  ipcMain.handle(
    'pipeline:start',
    (
      _e,
      opts: { mode: PipelineMode; brief: PipelineBrief; chatId?: number | null; workflowId?: string | null },
    ): PipelineRun | null => {
      const projectPath = getProjectRoot()
      if (!projectPath) return null
      return pipeline.create({
        projectPath,
        mode: opts.mode,
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
    (_e, projectPath: string): PipelineRun | null => pipeline.getActive(projectPath),
  )

  // pipeline:cancel — отменить прогон (step='cancelled').
  ipcMain.handle('pipeline:cancel', (_e, id: number): void => {
    pipeline.cancel(id)
  })
}
