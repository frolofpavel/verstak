import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createPlans } from '../../electron/storage/plans'
import type { PlanQualityV1, PlanStepSpecV1 } from '../../shared/contracts/outcome'

describe('plans execution-trace fields', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('new steps default trace fields to null', () => {
    const db = openDb(join(dir, 'test.db'))
    const plans = createPlans(db)
    const plan = plans.create('/proj', 'P', [{ title: 'step 1' }])
    expect(plan.steps[0].runId).toBeNull()
    expect(plan.steps[0].verificationStatus).toBeNull()
    expect(plan.steps[0].changedFilesCount).toBeNull()
    db.close()
  })

  it('updateStep persists runId / verificationStatus / changedFilesCount', () => {
    const db = openDb(join(dir, 'test.db'))
    const plans = createPlans(db)
    const plan = plans.create('/proj', 'P', [{ title: 'step 1' }])
    const stepId = plan.steps[0].id

    plans.updateStep(stepId, { runId: 'run-abc', verificationStatus: 'passed', changedFilesCount: 3 })

    const reloaded = plans.get(plan.id)
    const step = reloaded!.steps[0]
    expect(step.runId).toBe('run-abc')
    expect(step.verificationStatus).toBe('passed')
    expect(step.changedFilesCount).toBe(3)
    db.close()
  })

  it('updateStep leaves trace fields untouched when not in patch', () => {
    const db = openDb(join(dir, 'test.db'))
    const plans = createPlans(db)
    const plan = plans.create('/proj', 'P', [{ title: 'step 1' }])
    const stepId = plan.steps[0].id

    plans.updateStep(stepId, { runId: 'run-xyz' })
    plans.updateStep(stepId, { status: 'done' })

    const step = plans.get(plan.id)!.steps[0]
    expect(step.runId).toBe('run-xyz')
    expect(step.status).toBe('done')
    db.close()
  })

  it('structured Outcome plan roundtrips revisions, quality and step spec', () => {
    const db = openDb(join(dir, 'test.db'))
    const plans = createPlans(db)
    const spec: PlanStepSpecV1 = {
      key: 'auth-fix',
      title: 'Fix auth',
      intent: 'Fix session creation',
      files: ['src/auth.ts'],
      symbols: ['login'],
      actions: ['Change session branch'],
      dependsOn: [],
      readScope: ['src'],
      writeScope: ['src/auth.ts'],
      acceptanceCriterionIds: ['auth-green'],
      verification: ['npm test -- auth'],
      expectedEvidence: ['command:npm test -- auth'],
      rollback: 'git revert',
      role: 'executor',
      execution: 'main',
      risk: 'medium',
    }
    const quality: PlanQualityV1 = {
      score: 92,
      status: 'pass',
      hardErrors: [],
      warnings: [],
      checkedAt: 123,
    }
    const created = plans.create('/proj', 'Outcome', [{ title: 'Fix auth', spec }], {
      contractRevision: 3,
      planRevision: 2,
      quality,
    })
    const reloaded = plans.get(created.id)
    expect(reloaded?.contractRevision).toBe(3)
    expect(reloaded?.planRevision).toBe(2)
    expect(reloaded?.quality).toEqual(quality)
    expect(reloaded?.steps[0].spec).toEqual(spec)
    expect(reloaded).not.toHaveProperty('qualityJson')
    expect(reloaded?.steps[0]).not.toHaveProperty('specJson')
    db.close()
  })
})
