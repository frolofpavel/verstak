import { describe, expect, it, vi } from 'vitest'
import { reportStepOutcomeHandler } from '../../electron/ipc/tool-handlers/outcome'

const spec = {
  key: 'step-1', title: 'Step', intent: 'Implement', files: [], symbols: [],
  actions: ['edit'], dependsOn: [], readScope: ['src'], writeScope: ['src/a.ts'],
  acceptanceCriterionIds: ['ok'], verification: ['npm test'], expectedEvidence: ['test'],
  rollback: 'revert', role: 'executor', execution: 'main', risk: 'medium',
}

function makeCtx(over: Record<string, unknown> = {}) {
  const step = { id: 11, planId: 5, status: 'running', spec }
  const plan = { id: 5, planRevision: 1, steps: [step] }
  const pipeline = { id: 7, planId: 5, projectPath: '/project' }
  const plans = {
    get: vi.fn(() => plan),
    updateStep: vi.fn((_id, patch) => { Object.assign(step, patch) }),
  }
  const pipelineRuns = { get: vi.fn(() => pipeline), advance: vi.fn() }
  const planOutcomes = {
    countFailureSignature: vi.fn(() => 0),
    finalize: vi.fn(input => ({ inserted: true, outcome: input })),
  }
  return {
    projectPath: '/project',
    sendId: 1,
    runId: 'run-1',
    outcome: { pipelineId: 7, phase: 'execute-step', planStepId: 11, attempt: 1 },
    runFilesTouched: () => ['src/a.ts'],
    runChecks: () => [{ command: 'npm test', exitCode: 0 }],
    sender: { send: vi.fn() },
    plans,
    pipelineRuns,
    planOutcomes,
    ...over,
  }
}

const call = (over: Record<string, unknown> = {}) => ({
  id: 'out-1',
  name: 'report_step_outcome',
  args: {
    status: 'succeeded',
    summary: 'done',
    observations: [],
    changedFiles: ['src/a.ts'],
    checks: [{ command: 'npm test', status: 'passed', exitCode: 0 }],
    evidence: ['command:npm test'],
    assumptionFailures: [],
    recommendedAction: 'continue',
    ...over,
  },
}) as never

describe('report_step_outcome production gate', () => {
  it('finalizes a verified step and advances the last step to verify', async () => {
    const ctx = makeCtx()
    const result = await reportStepOutcomeHandler.handle(call(), ctx as never)
    expect(result.error).toBeUndefined()
    expect(ctx.plans.updateStep).toHaveBeenCalledWith(11, expect.objectContaining({ status: 'done', verificationStatus: 'passed' }))
    expect(ctx.pipelineRuns.advance).toHaveBeenCalledWith(7, expect.objectContaining({ step: 'verify', agentRunId: 'run-1' }))
  })

  it('downgrades hidden or out-of-scope writes and blocks the pipeline', async () => {
    const ctx = makeCtx({ runFilesTouched: () => ['src/a.ts', 'src/hidden.ts'] })
    await reportStepOutcomeHandler.handle(call(), ctx as never)
    expect(ctx.plans.updateStep).toHaveBeenCalledWith(11, expect.objectContaining({ status: 'failed' }))
    expect(ctx.pipelineRuns.advance).toHaveBeenCalledWith(7, expect.objectContaining({ step: 'blocked' }))
  })

  it('does not trust a claimed green check when the actual command failed', async () => {
    const ctx = makeCtx({ runChecks: () => [{ command: 'npm test', exitCode: 1 }] })
    await reportStepOutcomeHandler.handle(call(), ctx as never)
    expect(ctx.plans.updateStep).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 'failed',
      verificationStatus: 'failed',
    }))
  })

  it('moves the same run into replan phase after a non-transient failure', async () => {
    const ctx = makeCtx()
    await reportStepOutcomeHandler.handle(call({
      status: 'failed',
      checks: [{ command: 'npm test', status: 'failed', exitCode: 1 }],
      recommendedAction: 'replan',
    }), ctx as never)
    expect(ctx.outcome.phase).toBe('replan')
    expect(ctx.pipelineRuns.advance).toHaveBeenCalledWith(7, expect.objectContaining({ step: 'execute' }))
  })
})
