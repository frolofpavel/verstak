import { describe, expect, it, vi } from 'vitest'
import { replanPlanHandler } from '../../electron/ipc/tool-handlers/outcome'
import { validContract } from '../contracts/outcome-contract.test'

const spec = (key: string, dependsOn: string[] = [], writeScope = ['src/auth/login.ts'], risk = 'medium') => ({
  key,
  title: `Repair ${key}`,
  intent: `Repair authentication behavior for ${key}`,
  files: ['src/auth/login.ts'],
  symbols: ['login'],
  actions: ['Update authentication branch'],
  dependsOn,
  readScope: ['src/auth'],
  writeScope,
  acceptanceCriterionIds: ['auth-green'],
  verification: ['npm test -- auth'],
  expectedEvidence: ['command:npm test -- auth'],
  rollback: 'git revert',
  role: 'executor',
  execution: 'main',
  risk,
})

function ctx() {
  const plan = {
    id: 5,
    planRevision: 1,
    steps: [
      { id: 11, status: 'done', spec: spec('completed') },
      { id: 12, status: 'failed', spec: spec('failed') },
    ],
  }
  const pipeline = { id: 7, planId: 5, projectPath: '/project', taskContract: validContract }
  return {
    projectPath: '/project',
    sendId: 1,
    outcome: { pipelineId: 7, phase: 'replan' },
    sender: { send: vi.fn() },
    pipelineRuns: { get: vi.fn(() => pipeline), advance: vi.fn() },
    plans: {
      get: vi.fn(() => plan),
      replacePending: vi.fn((_id, _steps, meta) => ({ ...plan, planRevision: meta.planRevision })),
    },
    planOutcomes: { saveRevision: vi.fn(() => ({ inserted: true })) },
  }
}

const call = (steps: unknown[]) => ({
  id: 'rp-1',
  name: 'replan_plan',
  args: { reason: 'assumption invalidated', steps },
}) as never

describe('replan_plan', () => {
  it('preserves the completed revision snapshot and replaces only the remainder', async () => {
    const c = ctx()
    const result = await replanPlanHandler.handle(call([{ title: 'replacement', spec: spec('replacement') }]), c as never)
    expect(result.error).toBeUndefined()
    expect(c.planOutcomes.saveRevision).toHaveBeenCalledWith(5, 1, 'assumption invalidated', expect.anything())
    expect(c.plans.replacePending).toHaveBeenCalledWith(5, expect.anything(), expect.objectContaining({ planRevision: 2 }))
    expect(c.pipelineRuns.advance).toHaveBeenCalledWith(7, { step: 'execute' })
    expect(c.sender.send).toHaveBeenCalledWith('ai:event', expect.objectContaining({
      event: expect.objectContaining({ type: 'plan-replanned', preservedSteps: 1 }),
    }))
  })

  it('blocks a dependency cycle before persistence', async () => {
    const c = ctx()
    const result = await replanPlanHandler.handle(call([
      { spec: spec('a', ['b']) },
      { spec: spec('b', ['a']) },
    ]), c as never)
    expect(result.result).toContain('quality gate')
    expect(c.planOutcomes.saveRevision).not.toHaveBeenCalled()
    expect(c.plans.replacePending).not.toHaveBeenCalled()
  })

  it('requires approval for a high-risk write-scope expansion', async () => {
    const c = ctx()
    const result = await replanPlanHandler.handle(call([
      { spec: spec('expanded', [], ['src/security/new.ts'], 'high') },
    ]), c as never)
    expect(result.error).toContain('REPLAN_APPROVAL_REQUIRED')
    expect(c.plans.replacePending).not.toHaveBeenCalled()
  })
})
