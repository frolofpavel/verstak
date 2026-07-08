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
  'timed_out',
  'suspended',
  'interrupted',
])

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_WAIT_POLL_MS = 250
export const AGENT_RUN_TIMEOUT_SETTING_KEY = 'agent_run_timeout_ms'
export const AGENT_RUN_TIMEOUT_ENV_KEY = 'VERSTAK_AGENT_RUN_TIMEOUT_MS'
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 30 * 60 * 1000
export const MIN_AGENT_RUN_TIMEOUT_MS = 30 * 1000
export const MAX_AGENT_RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000
const AGENT_RUN_TIMEOUT_ABORT_NAME = 'AgentRunTimeoutError'

export interface AgentRunTimeoutPolicy {
  timeoutMs: number
  source: 'setting' | 'env' | 'default'
  clamped: boolean
}

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
    case 'timed_out': return 'timed_out'
    case 'suspended': return 'suspended'
    case 'interrupted': return 'interrupted'
    default: return 'failed'
  }
}

export function exitReasonToRunStatus(reason: ExitReason): RunStatus {
  switch (reason) {
    case 'completed': return 'completed'
    case 'aborted': return 'cancelled'
    case 'timeout': return 'timed_out'
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
    case 'timeout': return 'timed_out'
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

function parseTimeoutCandidate(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}

export function resolveAgentRunTimeoutPolicy(
  settingValue: string | null | undefined,
  envValue: string | null | undefined = process.env[AGENT_RUN_TIMEOUT_ENV_KEY]
): AgentRunTimeoutPolicy {
  const setting = parseTimeoutCandidate(settingValue)
  const env = parseTimeoutCandidate(envValue)
  const source = setting != null ? 'setting' : env != null ? 'env' : 'default'
  const raw = setting ?? env ?? DEFAULT_AGENT_RUN_TIMEOUT_MS
  const timeoutMs = Math.min(MAX_AGENT_RUN_TIMEOUT_MS, Math.max(MIN_AGENT_RUN_TIMEOUT_MS, raw))
  return { timeoutMs, source, clamped: timeoutMs !== raw }
}

export function createAgentRunTimeoutError(timeoutMs: number): Error {
  const err = new Error(`Agent run timed out after ${timeoutMs}ms`)
  err.name = AGENT_RUN_TIMEOUT_ABORT_NAME
  return err
}

export function abortAgentRunForTimeout(ctrl: AbortController, timeoutMs: number): void {
  ctrl.abort(createAgentRunTimeoutError(timeoutMs))
}

export function isAgentRunTimeoutAbort(signal: AbortSignal): boolean {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason
  return reason instanceof Error && reason.name === AGENT_RUN_TIMEOUT_ABORT_NAME
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
