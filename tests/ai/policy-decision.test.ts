import { describe, expect, it } from 'vitest'
import {
  evaluatePolicyDecision,
  policyDecisionMode,
  reconcilePolicyDecision,
  serializeDecisionTrace,
} from '../../electron/ai/policy-decision'
import type { DecisionContextV1 } from '../../shared/contracts/policy-decision'

function context(overrides: Partial<DecisionContextV1> = {}): DecisionContextV1 {
  return {
    schemaVersion: 1,
    policyVersion: 's2-a1-v1',
    timestamp: 1_700_000_000_000,
    agentId: 'agent:chat-7',
    ownerId: 'owner:local',
    taskId: 'task:chat-7',
    jobId: 'job-a',
    runId: 'run-a',
    capability: { id: 'skill:build', version: 'abc123', trust: 'T3' },
    mode: 'auto',
    tool: 'run_command',
    operation: 'execute',
    normalizedTarget: { kind: 'command', digest: 'sha256:fixed', scope: 'project' },
    dataClass: 'project-local',
    envelope: { costCents: null, runtimeMs: null },
    effectful: true,
    ...overrides,
  }
}

describe('S2-A1 policy decision facade', () => {
  it('defaults to shadow: emits the candidate but keeps legacy execution', () => {
    expect(policyDecisionMode('')).toBe('shadow')
    const result = evaluatePolicyDecision({ context: context({ capability: null }), args: { command: 'npm test' } })
    expect(result.decision).toBe('allow')
    expect(result.candidate).toBe('require_confirmation')
    expect(result.trace.rolloutMode).toBe('shadow')
  })

  it('shadow compares a stricter candidate without changing existing execution', () => {
    const result = evaluatePolicyDecision({
      context: context({ capability: null }),
      args: { command: 'npm test' },
      featureMode: 'shadow',
    })

    expect(result.legacy.decision).toBe('auto-accept')
    expect(result.candidate).toBe('require_confirmation')
    expect(result.decision).toBe('allow')
    expect(result.trace.comparison).toBe('tightening')
    expect(result.trace.reasonCodes).toContain('unknown-capability')
  })

  it('enforce never autoaccepts an effectful action with unknown identity or capability', () => {
    for (const patch of [
      { agentId: null },
      { ownerId: null },
      { capability: null },
      { capability: { id: 'skill:x', version: null, trust: 'T4' as const } },
    ]) {
      const result = evaluatePolicyDecision({
        context: context(patch as Partial<DecisionContextV1>),
        args: { command: 'npm test' },
        featureMode: 'enforce',
      })
      expect(result.decision).toBe('require_confirmation')
    }
  })

  it('a candidate regression can never weaken deny or confirmation', () => {
    expect(reconcilePolicyDecision('deny', 'allow')).toEqual({
      decision: 'deny',
      comparison: 'weakening-blocked',
    })
    expect(reconcilePolicyDecision('require_confirmation', 'allow')).toEqual({
      decision: 'require_confirmation',
      comparison: 'weakening-blocked',
    })
  })

  it('preserves the existing trust gate even when trace identity is unavailable', () => {
    const result = evaluatePolicyDecision({
      context: context({ capability: null }),
      args: { command: 'npm test' },
      capabilityTrust: 'T1',
      featureMode: 'shadow',
    })
    expect(result.legacy.decision).toBe('confirm')
    expect(result.decision).toBe('require_confirmation')
  })

  it('trace contains stable lineage but never raw command arguments or secrets', () => {
    const secret = 'TOP-SECRET-ARGUMENT'
    const result = evaluatePolicyDecision({
      context: context({ jobId: 'job-17', runId: 'run-92' }),
      args: { command: `npm test -- --token=${secret}` },
      featureMode: 'enforce',
    })
    const serialized = JSON.stringify(result.trace)

    expect(result.trace.context.jobId).toBe('job-17')
    expect(result.trace.context.runId).toBe('run-92')
    expect(result.trace.context.normalizedTarget.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('npm test')
    expect(serialized).not.toContain('"args"')
    expect(serialized).not.toContain('"command":')
  })

  it('concurrent job/run lineage stays isolated in separate traces', () => {
    const a = evaluatePolicyDecision({ context: context({ jobId: 'job-a', runId: 'run-a' }), args: { command: 'npm test' }, featureMode: 'enforce' })
    const b = evaluatePolicyDecision({ context: context({ jobId: 'job-b', runId: 'run-b' }), args: { command: 'npm test' }, featureMode: 'enforce' })

    expect(a.trace.traceId).not.toBe(b.trace.traceId)
    expect(a.trace.context).toMatchObject({ jobId: 'job-a', runId: 'run-a' })
    expect(b.trace.context).toMatchObject({ jobId: 'job-b', runId: 'run-b' })
  })

  it('persists parseable structured trace inside the existing 500-char stores', () => {
    const result = evaluatePolicyDecision({
      context: context({
        agentId: `agent:${'a'.repeat(120)}`,
        taskId: `task:${'t'.repeat(120)}`,
        jobId: `job:${'j'.repeat(120)}`,
        runId: `run:${'r'.repeat(120)}`,
      }),
      args: { command: 'npm test' },
      featureMode: 'shadow',
    })
    const stored = serializeDecisionTrace(result.trace)
    expect(stored.length).toBeLessThanOrEqual(500)
    expect(() => JSON.parse(stored)).not.toThrow()
    expect(JSON.parse(stored)).toMatchObject({ v: 1, id: result.trace.traceId, pv: 's2-a1-v1' })
  })
})
