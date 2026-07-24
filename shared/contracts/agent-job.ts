import type { StepOutcomeV1 } from './outcome'

export type AgentJobStatus =
  | 'queued'
  | 'ready'
  | 'running'
  | 'waiting-approval'
  | 'interrupted'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export type AgentJobKind =
  | 'delegate'
  | 'parallel-member'
  | 'orchestrate-member'
  | 'swarm-member'
  | 'swarm-arbiter'
  | 'outcome-step'

export interface AgentJobV1 {
  schemaVersion: 1
  id: string
  projectPath: string
  chatId: number | null
  pipelineId: number | null
  planId: number | null
  planStepId: number | null
  parentJobId: string | null
  groupId: string | null
  kind: AgentJobKind
  role: string
  goal: string
  status: AgentJobStatus
  dependsOn: string[]
  readScope: string[]
  writeScope: string[]
  providerId: string
  model: string
  accountId: number | null
  attempt: number
  maxAttempts: number
  callId: string | null
  subSessionId: number | null
  runId: string | null
  worktreePath: string | null
  costCapCents: number | null
  /** Производная agent_run_usage по runId; отдельным счётчиком не хранится. */
  costUsedCents: number
  interruptionReason: string | null
  waitingReason: string | null
  result: StepOutcomeV1 | null
  outcomeRowId: number | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface AgentJobTransitionGuard {
  dependenciesSucceeded?: boolean
  scheduler?: boolean
  userApprovedResume?: boolean
}

export interface AgentJobTransitionDecision {
  allowed: boolean
  code?: 'terminal' | 'invalid-transition' | 'dependencies-pending' | 'scheduler-required' | 'writer-resume-approval-required'
  reason?: string
}

export const TERMINAL_AGENT_JOB_STATUSES = new Set<AgentJobStatus>([
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
])

const ALLOWED_TRANSITIONS: Readonly<Record<AgentJobStatus, readonly AgentJobStatus[]>> = {
  queued: ['ready', 'blocked', 'cancelled'],
  ready: ['running', 'queued', 'cancelled', 'blocked'],
  running: ['succeeded', 'failed', 'blocked', 'waiting-approval', 'interrupted', 'cancelled'],
  'waiting-approval': ['ready', 'cancelled', 'blocked'],
  interrupted: ['ready', 'cancelled', 'blocked'],
  succeeded: [],
  failed: [],
  blocked: [],
  cancelled: [],
}

export function isAgentJobWriter(job: Pick<AgentJobV1, 'writeScope'>): boolean {
  return job.writeScope.length > 0
}

export function decideAgentJobTransition(
  job: Pick<AgentJobV1, 'status' | 'writeScope'>,
  next: AgentJobStatus,
  guard: AgentJobTransitionGuard = {},
): AgentJobTransitionDecision {
  if (TERMINAL_AGENT_JOB_STATUSES.has(job.status)) {
    return { allowed: false, code: 'terminal', reason: `terminal job ${job.status} нельзя запустить повторно` }
  }
  if (!ALLOWED_TRANSITIONS[job.status].includes(next)) {
    return { allowed: false, code: 'invalid-transition', reason: `переход ${job.status} → ${next} запрещён` }
  }
  if (job.status === 'queued' && next === 'ready' && guard.dependenciesSucceeded !== true) {
    return { allowed: false, code: 'dependencies-pending', reason: 'не все зависимости завершились успешно' }
  }
  if (job.status === 'ready' && next === 'running' && guard.scheduler !== true) {
    return { allowed: false, code: 'scheduler-required', reason: 'job может запустить только scheduler' }
  }
  if (job.status === 'interrupted' && next === 'ready' && isAgentJobWriter(job) && guard.userApprovedResume !== true) {
    return {
      allowed: false,
      code: 'writer-resume-approval-required',
      reason: 'writer после crash требует явного подтверждения пользователя',
    }
  }
  return { allowed: true }
}

export class AgentJobTransitionError extends Error {
  constructor(
    readonly code: NonNullable<AgentJobTransitionDecision['code']>,
    message: string,
  ) {
    super(message)
    this.name = 'AgentJobTransitionError'
  }
}

export function assertAgentJobTransition(
  job: Pick<AgentJobV1, 'status' | 'writeScope'>,
  next: AgentJobStatus,
  guard: AgentJobTransitionGuard = {},
): void {
  const decision = decideAgentJobTransition(job, next, guard)
  if (!decision.allowed) {
    throw new AgentJobTransitionError(decision.code ?? 'invalid-transition', decision.reason ?? 'Переход Agent Job запрещён')
  }
}
