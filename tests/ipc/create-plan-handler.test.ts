import { describe, expect, it, vi } from 'vitest'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'
import { validContract } from '../contracts/outcome-contract.test'
import type { PlanStepSpecV1 } from '../../shared/contracts/outcome'

const validSpec: PlanStepSpecV1 = {
  key: 'auth-fix',
  title: 'Исправить auth',
  intent: 'Исправить создание сессии в функции login',
  files: ['src/auth/login.ts'],
  symbols: ['login'],
  actions: ['Изменить ветку сохранения сессии'],
  dependsOn: [],
  readScope: ['src/auth'],
  writeScope: ['src/auth/login.ts'],
  acceptanceCriterionIds: ['auth-green'],
  verification: ['npm test -- auth'],
  expectedEvidence: ['command:npm test -- auth'],
  rollback: 'git revert',
  role: 'executor',
  execution: 'main',
  risk: 'medium',
}

function makeCtx(contract = validContract, previousPlan: { id: number; revision: number } | null = null) {
  const pendingPlans = new Map<string, { sendId: number; resolve: (decision: { decision: 'approve' | 'revise' | 'reject' }) => void }>()
  const set = pendingPlans.set.bind(pendingPlans)
  pendingPlans.set = ((key, value) => {
    const result = set(key, value)
    queueMicrotask(() => value.resolve({ decision: 'approve' }))
    return result
  }) as typeof pendingPlans.set
  return {
    projectPath: '/p',
    sendId: 1,
    agentMode: 'auto',
    sender: { send: vi.fn() },
    recordPlan: vi.fn(() => ({ id: 42 })),
    getPlan: vi.fn((id: number) => previousPlan?.id === id ? { planRevision: previousPlan.revision } : null),
    recordJournal: vi.fn(),
    getSecretForDelegate: vi.fn(),
    pendingPlans,
    scopedKey: (sendId: number, callId: string) => `${sendId}:${callId}`,
    outcome: { pipelineId: 7, phase: 'plan' },
    pipelineRuns: {
      get: vi.fn(() => ({ id: 7, projectPath: '/p', taskContract: contract, contractRevision: contract.revision, planId: previousPlan?.id ?? null })),
    },
  }
}

function call(spec = validSpec) {
  return {
    id: 'p1',
    name: 'create_plan',
    args: {
      title: 'Auth plan',
      steps: [{ title: 'Исправить auth', detail: 'Конкретный auth fix и проверка.', spec }],
    },
  } as never
}

describe('Outcome create_plan hard gate', () => {
  it('валидирует quality до persistence и сохраняет полный spec', async () => {
    const ctx = makeCtx()
    const result = await createPlanHandler.handle(call(), ctx as never)
    expect(result.error).toBeUndefined()
    expect(ctx.recordPlan).toHaveBeenCalledWith('/p', 'Auth plan', [
      expect.objectContaining({ spec: expect.objectContaining({ key: 'auth-fix', writeScope: ['src/auth/login.ts'] }) }),
    ], expect.objectContaining({ contractRevision: 1, planRevision: 1, quality: expect.objectContaining({ status: 'pass' }) }))
    expect(ctx.sender.send).toHaveBeenCalledWith('ai:event', expect.objectContaining({
      event: expect.objectContaining({ type: 'plan-approval', planId: 42 }),
    }))
  })

  it('unknown dependency = revise, persist/approval равны нулю', async () => {
    const ctx = makeCtx()
    const result = await createPlanHandler.handle(call({ ...validSpec, dependsOn: ['missing'] }), ctx as never)
    expect(result.result).toContain('deterministic gate')
    expect(ctx.recordPlan).not.toHaveBeenCalled()
    expect(ctx.sender.send).not.toHaveBeenCalled()
  })

  it('blocking questions = revise до persistence', async () => {
    const ctx = makeCtx({ ...validContract, blockingQuestions: ['Какой flow?'] })
    const result = await createPlanHandler.handle(call(), ctx as never)
    expect(result.result).toContain('blocking questions')
    expect(ctx.recordPlan).not.toHaveBeenCalled()
  })

  it('revise creates a new incremented plan revision', async () => {
    const ctx = makeCtx(validContract, { id: 9, revision: 2 })
    await createPlanHandler.handle(call(), ctx as never)
    expect(ctx.recordPlan).toHaveBeenCalledWith(
      '/p',
      'Auth plan',
      expect.any(Array),
      expect.objectContaining({ planRevision: 3 }),
    )
  })
})
