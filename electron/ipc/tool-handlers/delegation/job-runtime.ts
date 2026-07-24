import { randomUUID } from 'node:crypto'
import type { AgentJobKind, AgentJobStatus, AgentJobV1 } from '../../../../shared/contracts/agent-job'
import type { StepOutcomeV1 } from '../../../../shared/contracts/outcome'
import type { ToolContext } from '../shared'
import type { AgentJobLease } from '../../../ai/agent-job-scheduler'
import { worktreeChangedFiles } from '../../../ai/git-worktree'

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map(item => item.trim()).filter(Boolean)
    : []
}

export interface DurableJobSpec {
  id?: string
  kind: AgentJobKind
  role: string
  goal: string
  providerId: string
  model: string
  callId: string
  groupId?: string | null
  dependsOn?: string[]
  readScope?: string[]
  writeScope?: string[]
  costCapCents?: number | null
}

export function scopesFromArgs(args: Record<string, unknown>): {
  readScope: string[]
  writeScope: string[]
} {
  return {
    readScope: strings(args.read_scope),
    writeScope: strings(args.write_scope),
  }
}

export function roleWriteScope(role: string | null | undefined, declared: unknown): string[] {
  const explicit = strings(declared)
  if (explicit.length > 0) return explicit
  return role === 'executor' ? ['**'] : []
}

export function startDurableJob(ctx: ToolContext, spec: DurableJobSpec): AgentJobV1 | null {
  if (!ctx.agentJobs) return null
  const resolvedAccount = ctx.resolveSubscriptionAccount?.(
    spec.providerId,
    ctx.parentChatId ?? undefined,
  ) ?? null
  const accountId = resolvedAccount && 'accountId' in resolvedAccount ? resolvedAccount.accountId : null
  const job = ctx.agentJobs.create({
    id: spec.id ?? randomUUID(),
    projectPath: ctx.projectPath,
    chatId: ctx.parentChatId ?? null,
    pipelineId: ctx.outcome?.pipelineId ?? null,
    planId: null,
    planStepId: ctx.outcome?.planStepId ?? null,
    parentJobId: ctx.parentJobId ?? null,
    groupId: spec.groupId ?? null,
    kind: spec.kind,
    role: spec.role,
    goal: spec.goal,
    dependsOn: spec.dependsOn ?? [],
    readScope: spec.readScope ?? [],
    writeScope: spec.writeScope ?? [],
    providerId: spec.providerId,
    model: spec.model,
    accountId,
    attempt: 1,
    maxAttempts: 2,
    callId: spec.callId,
    subSessionId: null,
    runId: null,
    worktreePath: null,
    costCapCents: spec.costCapCents ?? null,
  })
  ctx.agentJobs.promoteReady(ctx.projectPath)
  return ctx.agentJobs.get(job.id)
}

export function markDurableJobRunning(
  ctx: ToolContext,
  job: AgentJobV1 | null,
): AgentJobV1 | null {
  if (!job || !ctx.agentJobs) return job
  return ctx.agentJobs.transition(job.id, {
    status: 'running',
    guard: { scheduler: true },
  })
}

export async function acquireDurableJob(
  ctx: ToolContext,
  job: AgentJobV1 | null,
  signal: AbortSignal,
  abortExecution: () => void,
): Promise<AgentJobLease | null> {
  if (!job || !ctx.agentJobScheduler) return null
  return ctx.agentJobScheduler.acquire(job.id, signal, abortExecution)
}

export function linkDurableJob(
  ctx: ToolContext,
  job: AgentJobV1 | null,
  patch: Parameters<NonNullable<ToolContext['agentJobs']>['link']>[1],
): AgentJobV1 | null {
  if (!job || !ctx.agentJobs) return job
  return ctx.agentJobs.link(job.id, patch)
}

function statusToOutcome(status: AgentJobStatus): StepOutcomeV1['status'] {
  if (status === 'succeeded') return 'succeeded'
  if (status === 'blocked') return 'blocked'
  return 'failed'
}

export function finishDurableJob(
  ctx: ToolContext,
  job: AgentJobV1 | null,
  status: Extract<AgentJobStatus, 'succeeded' | 'failed' | 'blocked' | 'cancelled'>,
  summary: string,
  details: Partial<StepOutcomeV1> = {},
): AgentJobV1 | null {
  if (!job || !ctx.agentJobs) return job
  const current = ctx.agentJobs.get(job.id)
  if (!current || ['waiting-approval', 'interrupted', 'succeeded', 'failed', 'blocked', 'cancelled'].includes(current.status)) return current
  const changedFiles = details.changedFiles
    ?? (current.worktreePath ? worktreeChangedFiles(current.worktreePath) : (ctx.runFilesTouched?.() ?? []))
  const checks = details.checks ?? (ctx.runChecks?.() ?? []).map(check => ({
    command: check.command,
    status: check.exitCode === 0 ? 'passed' as const : 'failed' as const,
    exitCode: check.exitCode,
  }))
  const result: StepOutcomeV1 = {
    status: statusToOutcome(status),
    summary,
    observations: details.observations ?? [],
    changedFiles,
    checks,
    evidence: details.evidence ?? [
      ...(current.runId ? [`run:${current.runId}`] : []),
      ...(current.worktreePath ? [`worktree:${current.worktreePath}`] : []),
    ],
    assumptionFailures: details.assumptionFailures ?? [],
    recommendedAction: details.recommendedAction ?? (status === 'succeeded' ? 'continue' : 'retry'),
  }
  const finished = ctx.agentJobs.transition(job.id, {
    status,
    result: status === 'cancelled' ? null : result,
  })
  ctx.agentJobs.promoteReady(job.projectPath)
  ctx.sender.send('ai:event', {
    id: ctx.sendId,
    event: {
      type: 'agent-job-finished',
      jobId: job.id,
      parentCallId: ctx.parentCallId ?? null,
      status,
      summary,
    },
  })
  return finished
}
