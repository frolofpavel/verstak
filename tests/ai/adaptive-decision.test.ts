import { describe, expect, it } from 'vitest'
import { decideAdaptiveAction, failureSignature } from '../../electron/ai/adaptive-decision'
import { nextPipelineStep } from '../../electron/ai/outcome-controller'
import type { StepOutcomeV1 } from '../../shared/contracts/outcome'

const outcome = (status: StepOutcomeV1['status'], over: Partial<StepOutcomeV1> = {}): StepOutcomeV1 => ({
  status,
  summary: status,
  observations: [],
  changedFiles: [],
  checks: [{ command: 'npm test', status: status === 'succeeded' ? 'passed' : 'failed', exitCode: status === 'succeeded' ? 0 : 1 }],
  evidence: [],
  assumptionFailures: [],
  recommendedAction: status === 'succeeded' ? 'continue' : 'replan',
  ...over,
})

describe('AdaptiveDecision 2.1.1', () => {
  it('continues only after a succeeded step with passed checks', () => {
    const decision = decideAdaptiveAction(outcome('succeeded'), { attempt: 1, maxAttempts: 3, repeatedFailureCount: 0 })
    expect(decision.action).toBe('continue')
    expect(nextPipelineStep(decision, 0)).toBe('verify')
    expect(nextPipelineStep(decision, 2)).toBe('execute')
  })

  it('bounds transient retries and replans a repeated failure', () => {
    expect(decideAdaptiveAction(outcome('failed'), {
      attempt: 1, maxAttempts: 3, repeatedFailureCount: 0, transientError: true,
    }).action).toBe('retry')
    expect(decideAdaptiveAction(outcome('failed'), {
      attempt: 2, maxAttempts: 3, repeatedFailureCount: 1,
    }).action).toBe('replan')
    expect(decideAdaptiveAction(outcome('failed'), {
      attempt: 3, maxAttempts: 3, repeatedFailureCount: 2,
    }).action).toBe('block')
  })

  it('blocks scope divergence and produces a stable bounded signature', () => {
    const failed = outcome('diverged', { changedFiles: ['outside.ts'] })
    const first = failureSignature(failed)
    const second = failureSignature({ ...failed })
    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{20}$/)
    const decision = decideAdaptiveAction(failed, {
      attempt: 1, maxAttempts: 3, repeatedFailureCount: 0, writeScopeViolated: true,
    })
    expect(decision.action).toBe('block')
    expect(decision.requiresApproval).toBe(true)
    expect(nextPipelineStep(decision, 1)).toBe('blocked')
  })
})
