import { ipcMain } from 'electron'
import type { AgentJobs } from '../storage/agent-jobs'
import type { UndoStack } from '../storage/undo'
import type { AgentJobScheduler } from '../ai/agent-job-scheduler'
import { applyAgentJobVariant, rejectAgentJobVariant } from '../ai/job-variant'

export function registerAgentJobsIpc(agentJobs: AgentJobs, undoStack: UndoStack, scheduler: AgentJobScheduler): void {
  ipcMain.handle('agent-jobs:list', (_event, projectPath: string) =>
    projectPath ? agentJobs.listProject(projectPath) : [])

  ipcMain.handle('agent-jobs:get', (_event, jobId: string) => {
    const job = agentJobs.get(jobId)
    return {
      job,
      children: job ? agentJobs.children(job.id) : [],
    }
  })

  ipcMain.handle('agent-jobs:cancel', (_event, jobId: string) =>
    jobId ? scheduler.cancelJob(jobId) : 0)

  ipcMain.handle('agent-jobs:approve-resume', (_event, jobId: string) => {
    const job = agentJobs.get(jobId)
    if (!job || job.status !== 'interrupted') return null
    return agentJobs.transition(jobId, {
      status: 'ready',
      guard: { userApprovedResume: true },
      waitingReason: null,
      interruptionReason: null,
    })
  })

  ipcMain.handle('agent-jobs:choose-variant', async (_event, jobId: string) => {
    const job = agentJobs.get(jobId)
    if (!job || job.status !== 'succeeded' || !job.worktreePath) {
      return { ok: false, error: 'У job нет готового изолированного варианта.' }
    }
    const result = await applyAgentJobVariant(job, undoStack)
    if (result.ok) agentJobs.link(job.id, { worktreePath: result.cleanupOk ? null : job.worktreePath })
    return result
  })

  ipcMain.handle('agent-jobs:reject-variant', (_event, jobId: string) => {
    const job = agentJobs.get(jobId)
    if (!job) return { ok: true, removed: false }
    const result = rejectAgentJobVariant(job)
    if (result.removed) agentJobs.link(job.id, { worktreePath: null })
    return result
  })
}
