import type { ExitReason } from './session-journal'
import type { AgentRun, AgentRuns, AgentRunStatus } from '../storage/agent-runs'

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'suspended'
  | 'interrupted'

export interface RunWaitOptions {
  timeoutMs?: number
  pollMs?: number
}

export interface RunWaitResult {
  runId: string
  status: RunStatus
  agentRunStatus: AgentRunStatus
  endedAt: number | null
  error: string | null
}

interface InternalRunWaitOptions extends RunWaitOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const TERMINAL_AGENT_RUN_STATUSES = new Set<AgentRunStatus>([
  'done',
  'failed',
  'stopped',
  'suspended',
  'interrupted',
])

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_WAIT_POLL_MS = 250

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_AGENT_RUN_STATUSES.has(status)
}

export function agentRunStatusToRunStatus(status: AgentRunStatus): RunStatus {
  switch (status) {
    case 'done': return 'completed'
    case 'stopped': return 'cancelled'
    case 'failed': return 'failed'
    case 'queued': return 'queued'
    case 'running': return 'running'
    case 'waiting_review': return 'waiting_review'
    case 'suspended': return 'suspended'
    case 'interrupted': return 'interrupted'
    default: return 'failed'
  }
}

export function exitReasonToRunStatus(reason: ExitReason): RunStatus {
  switch (reason) {
    case 'completed': return 'completed'
    case 'aborted': return 'cancelled'
    case 'error':
    case 'crashed': return 'failed'
    case 'max-turns':
    case 'loop-detected': return 'completed'
    default: return 'failed'
  }
}

export function exitReasonToAgentRunStatus(reason: ExitReason): AgentRunStatus {
  switch (reason) {
    case 'completed': return 'done'
    case 'aborted': return 'stopped'
    case 'error':
    case 'crashed': return 'failed'
    case 'max-turns':
    case 'loop-detected': return 'done'
    default: return 'done'
  }
}

export function buildRunWaitResult(run: AgentRun): RunWaitResult {
  return {
    runId: run.runId,
    status: agentRunStatusToRunStatus(run.status),
    agentRunStatus: run.status,
    endedAt: run.endedAt,
    error: run.error,
  }
}

export async function waitForRun(
  agentRuns: Pick<AgentRuns, 'get'>,
  runId: string,
  opts: InternalRunWaitOptions = {}
): Promise<RunWaitResult> {
  if (!runId) throw new Error('ai:wait requires runId')
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const timeoutMs = Math.max(0, opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
  const pollMs = Math.max(10, opts.pollMs ?? DEFAULT_WAIT_POLL_MS)
  const startedAt = now()

  while (true) {
    const run = agentRuns.get(runId)
    if (!run) throw new Error(`ai:wait run not found: ${runId}`)
    if (run.endedAt != null || isTerminalAgentRunStatus(run.status)) {
      return buildRunWaitResult(run)
    }
    const elapsed = now() - startedAt
    if (elapsed >= timeoutMs) {
      throw new Error(`ai:wait timeout after ${timeoutMs}ms for run ${runId}`)
    }
    await sleep(Math.min(pollMs, timeoutMs - elapsed))
  }
}
