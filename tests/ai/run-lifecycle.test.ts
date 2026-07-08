import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRunStatus } from '../../electron/storage/agent-runs'
import {
  agentRunStatusToRunStatus,
  abortAgentRunForTimeout,
  buildRunWaitResult,
  DEFAULT_AGENT_RUN_TIMEOUT_MS,
  exitReasonToAgentRunStatus,
  exitReasonToRunStatus,
  isAgentRunTimeoutAbort,
  isTerminalAgentRunStatus,
  MAX_AGENT_RUN_TIMEOUT_MS,
  MIN_AGENT_RUN_TIMEOUT_MS,
  resolveAgentRunTimeoutPolicy,
  shouldFireRunTimeout,
  waitForRun,
} from '../../electron/ai/run-lifecycle'

function run(status: AgentRunStatus, endedAt: number | null = null): AgentRun {
  return {
    runId: 'r1',
    projectPath: '/p',
    chatId: 1,
    owner: 'main',
    title: 'Run',
    status,
    providerId: 'test',
    model: 'test-model',
    sendId: 1,
    generation: 0,
    agentsCount: 0,
    toolCount: 0,
    filesCount: 0,
    costCents: 0,
    error: status === 'failed' ? 'boom' : null,
    startedAt: 1,
    endedAt,
    turnIndex: 0,
    lastToolName: null,
    lastCheckpointId: null,
    agentMode: 'ask',
    updatedAt: 1,
    lastEventAt: null,
  }
}

describe('run lifecycle', () => {
  it('maps agent-run storage statuses to public run statuses', () => {
    expect(agentRunStatusToRunStatus('queued')).toBe('queued')
    expect(agentRunStatusToRunStatus('running')).toBe('running')
    expect(agentRunStatusToRunStatus('waiting_review')).toBe('waiting_review')
    expect(agentRunStatusToRunStatus('done')).toBe('completed')
    expect(agentRunStatusToRunStatus('failed')).toBe('failed')
    expect(agentRunStatusToRunStatus('stopped')).toBe('cancelled')
    expect(agentRunStatusToRunStatus('timed_out')).toBe('timed_out')
    expect(agentRunStatusToRunStatus('suspended')).toBe('suspended')
    expect(agentRunStatusToRunStatus('interrupted')).toBe('interrupted')
  })

  it('keeps exit-reason mapping aligned for storage and public status', () => {
    expect(exitReasonToAgentRunStatus('completed')).toBe('done')
    expect(exitReasonToRunStatus('completed')).toBe('completed')
    expect(exitReasonToAgentRunStatus('aborted')).toBe('stopped')
    expect(exitReasonToRunStatus('aborted')).toBe('cancelled')
    expect(exitReasonToAgentRunStatus('timeout')).toBe('timed_out')
    expect(exitReasonToRunStatus('timeout')).toBe('timed_out')
    expect(exitReasonToAgentRunStatus('crashed')).toBe('failed')
    expect(exitReasonToRunStatus('crashed')).toBe('failed')
    expect(exitReasonToAgentRunStatus('max-turns')).toBe('done')
    expect(exitReasonToRunStatus('loop-detected')).toBe('completed')
  })

  it('marks only ended storage states as terminal for wait', () => {
    expect(isTerminalAgentRunStatus('queued')).toBe(false)
    expect(isTerminalAgentRunStatus('running')).toBe(false)
    expect(isTerminalAgentRunStatus('waiting_review')).toBe(false)
    expect(isTerminalAgentRunStatus('done')).toBe(true)
    expect(isTerminalAgentRunStatus('failed')).toBe(true)
    expect(isTerminalAgentRunStatus('stopped')).toBe(true)
    expect(isTerminalAgentRunStatus('timed_out')).toBe(true)
    expect(isTerminalAgentRunStatus('suspended')).toBe(true)
    expect(isTerminalAgentRunStatus('interrupted')).toBe(true)
  })

  it('builds machine-readable wait result without exposing extra run fields', () => {
    expect(buildRunWaitResult(run('failed', 50))).toEqual({
      runId: 'r1',
      status: 'failed',
      agentRunStatus: 'failed',
      endedAt: 50,
      error: 'boom',
    })
  })

  it('waitForRun resolves immediately for finished runs', async () => {
    await expect(waitForRun({ get: () => run('done', 100) }, 'r1', { timeoutMs: 1 })).resolves.toEqual({
      runId: 'r1',
      status: 'completed',
      agentRunStatus: 'done',
      endedAt: 100,
      error: null,
    })
  })

  it('waitForRun polls until the run reaches a terminal state', async () => {
    let current = run('running')
    const result = await waitForRun(
      { get: () => current },
      'r1',
      {
        timeoutMs: 100,
        pollMs: 10,
        sleep: async () => { current = run('done', 20) },
      }
    )
    expect(result.status).toBe('completed')
    expect(result.endedAt).toBe(20)
  })

  it('waitForRun rejects unknown runs', async () => {
    await expect(waitForRun({ get: () => null }, 'missing', { timeoutMs: 1 }))
      .rejects.toThrow('run not found')
  })

  it('waitForRun rejects on timeout', async () => {
    let t = 0
    await expect(waitForRun(
      { get: () => run('running') },
      'r1',
      {
        timeoutMs: 25,
        pollMs: 10,
        now: () => t,
        sleep: async (ms) => { t += ms },
      }
    )).rejects.toThrow('timeout')
  })

  it('resolves configurable agent-run timeout policy with clamp bounds', () => {
    expect(resolveAgentRunTimeoutPolicy(null, null)).toEqual({
      timeoutMs: DEFAULT_AGENT_RUN_TIMEOUT_MS,
      source: 'default',
      clamped: false,
    })
    expect(resolveAgentRunTimeoutPolicy('120000', '60000')).toEqual({
      timeoutMs: 120_000,
      source: 'setting',
      clamped: false,
    })
    expect(resolveAgentRunTimeoutPolicy(null, '1000')).toEqual({
      timeoutMs: MIN_AGENT_RUN_TIMEOUT_MS,
      source: 'env',
      clamped: true,
    })
    expect(resolveAgentRunTimeoutPolicy(String(MAX_AGENT_RUN_TIMEOUT_MS + 1), null)).toEqual({
      timeoutMs: MAX_AGENT_RUN_TIMEOUT_MS,
      source: 'setting',
      clamped: true,
    })
  })

  it('does not fire the timeout watchdog once the run has settled (M2 false-toast race)', () => {
    // Нормальный случай: не оборван и не завершён → таймаут легитимен.
    expect(shouldFireRunTimeout(false, null)).toBe(true)
    expect(shouldFireRunTimeout(false, undefined)).toBe(true)
    // Уже оборван (Stop / прошлый таймаут) → не дублируем.
    expect(shouldFireRunTimeout(true, null)).toBe(false)
    // Прогон уже успешно завершился (endedAt проставлен finish() до clearTimeout)
    // → watchdog не должен слать ложный timeout-тост на успешный прогон.
    expect(shouldFireRunTimeout(false, 123_456)).toBe(false)
    expect(shouldFireRunTimeout(true, 123_456)).toBe(false)
  })

  it('marks timeout aborts through AbortSignal.reason', () => {
    const timeoutCtrl = new AbortController()
    abortAgentRunForTimeout(timeoutCtrl, 1000)
    expect(isAgentRunTimeoutAbort(timeoutCtrl.signal)).toBe(true)

    const stopCtrl = new AbortController()
    stopCtrl.abort()
    expect(isAgentRunTimeoutAbort(stopCtrl.signal)).toBe(false)
  })
})
