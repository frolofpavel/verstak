import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createPlanOutcomes } from '../../electron/storage/plan-outcomes'
import { createPlans } from '../../electron/storage/plans'
import type { PlanStepSpecV1 } from '../../shared/contracts/outcome'

describe('plan outcomes storage 2.1.1', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-outcomes-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('finalizes one run attempt idempotently and keeps revision snapshots', () => {
    const db = openDb(join(dir, 'test.db'))
    const store = createPlanOutcomes(db)
    const input = {
      planId: 1,
      stepId: 2,
      planRevision: 1,
      runId: 'run-1',
      attempt: 1,
      status: 'failed' as const,
      outcome: {
        status: 'failed' as const,
        summary: 'test failed',
        observations: [],
        changedFiles: [],
        checks: [{ command: 'npm test', status: 'failed' as const, exitCode: 1 }],
        evidence: [],
        assumptionFailures: [],
        recommendedAction: 'replan' as const,
      },
      failureSignature: 'abc',
      decision: { action: 'replan' as const, reason: 'failed', failureSignature: 'abc', requiresApproval: false },
    }
    expect(store.finalize(input).inserted).toBe(true)
    expect(store.finalize(input).inserted).toBe(false)
    expect(store.list(1)).toHaveLength(1)
    expect(store.countFailureSignature(1, 'abc')).toBe(1)
    expect(store.saveRevision(1, 1, 'failure', { completed: [2] }).inserted).toBe(true)
    expect(store.saveRevision(1, 1, 'duplicate', {}).inserted).toBe(false)
    expect(store.revisions(1)[0].snapshot).toEqual({ completed: [2] })
    db.close()
  })

  it('replan preserves completed steps and replaces only the pending remainder', () => {
    const db = openDb(join(dir, 'test.db'))
    const plans = createPlans(db)
    const makeSpec = (key: string): PlanStepSpecV1 => ({
      key, title: key, intent: key, files: [`src/${key}.ts`], symbols: [],
      actions: ['edit'], dependsOn: [], readScope: ['src'], writeScope: [`src/${key}.ts`],
      acceptanceCriterionIds: ['ok'], verification: ['npm test'], expectedEvidence: ['tests'],
      rollback: 'revert', role: 'executor', execution: 'main', risk: 'medium',
    })
    const plan = plans.create('/project', 'Adaptive', [
      { title: 'done', spec: makeSpec('done') },
      { title: 'old pending', spec: makeSpec('old') },
    ], { contractRevision: 1, planRevision: 1 })
    const completedId = plan.steps[0].id
    plans.updateStep(completedId, { status: 'done', result: 'kept' })
    const updated = plans.replacePending(plan.id, [
      { title: 'new pending', spec: makeSpec('new') },
    ], {
      planRevision: 2,
      quality: { score: 90, status: 'pass', hardErrors: [], warnings: [], checkedAt: 1 },
    })
    expect(updated.planRevision).toBe(2)
    expect(updated.steps).toHaveLength(2)
    expect(updated.steps[0]).toMatchObject({ id: completedId, status: 'done', result: 'kept' })
    expect(updated.steps[1]).toMatchObject({ title: 'new pending', status: 'pending' })
    expect(updated.steps.some(step => step.title === 'old pending')).toBe(false)
    db.close()
  })
})
