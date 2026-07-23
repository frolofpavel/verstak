import { describe, it, expect, vi } from 'vitest'
import { resolvePlanGate } from '../../electron/ai/plan-gate'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'

describe('plan-gate: resolvePlanGate', () => {
  it('approve → выполнение (accept-edits) + сообщение «одобрил, приступай»', () => {
    const r = resolvePlanGate('approve', undefined, 'Рефактор auth')
    expect(r.newMode).toBe('accept-edits')
    expect(r.result).toContain('ОДОБРИЛ')
    expect(r.result).toContain('Рефактор auth')
    expect(r.result).toContain('выполнению')
  })

  it('revise → режим НЕ меняется + замечания переданы модели', () => {
    const r = resolvePlanGate('revise', 'добавь шаг с тестами', 'План X')
    expect(r.newMode).toBeNull()
    expect(r.result).toContain('ДОРАБОТАТЬ')
    expect(r.result).toContain('добавь шаг с тестами')
    expect(r.result).toContain('НЕ начинай выполнение')
  })

  it('reject → режим НЕ меняется + явный запрет выполнения', () => {
    const r = resolvePlanGate('reject', 'не тот подход', 'План Y')
    expect(r.newMode).toBeNull()
    expect(r.result).toContain('ОТКЛОНИЛ')
    expect(r.result).toContain('не тот подход')
    expect(r.result).toContain('Не выполняй')
  })

  it('revise/reject без feedback — корректное сообщение без хвоста «:»', () => {
    expect(resolvePlanGate('revise', undefined, 'П').result).not.toContain(': .')
    expect(resolvePlanGate('reject', '   ', 'П').result).toContain('ОТКЛОНИЛ план «П».')
  })
})

// Интеграция: createPlanHandler в plan-режиме блокирует-и-ждёт, approve → setAgentMode.
describe('plan-gate: createPlanHandler (block-and-wait)', () => {
  function makeCtx(over: Record<string, unknown> = {}) {
    return {
      agentMode: 'plan',
      pendingPlans: new Map(),
      setAgentMode: vi.fn(),
      getSecretForDelegate: (k: string) => (k === 'plan_approval_gate' ? 'true' : null),
      recordPlan: () => ({ id: 7 }),
      recordJournal: () => {},
      sender: { send: vi.fn() },
      sendId: 1,
      scopedKey: (s: number, c: string) => `${s}::${c}`,
      projectPath: '/p',
      ...over,
    } as never
  }
  const call = {
    id: 'c1',
    name: 'create_plan',
    args: {
      title: 'Рефактор',
      steps: [{
        title: 'Исправить auth',
        detail: 'В src/auth/login.ts исправить создание сессии. Критерий готовности: npm test -- auth проходит.',
      }],
    },
  } as never

  it('approve → setAgentMode(accept-edits) (одобренный план выполняется в прогоне)', async () => {
    const ctx = makeCtx()
    const p = createPlanHandler.handle(call, ctx)
    // Promise-executor поставил pending синхронно — резолвим approve.
    const pending = [...(ctx as { pendingPlans: Map<string, { resolve: (d: unknown) => void }> }).pendingPlans.values()][0]
    expect(pending).toBeTruthy()
    pending.resolve({ decision: 'approve' })
    const res = await p as { result: string }
    expect((ctx as { setAgentMode: ReturnType<typeof vi.fn> }).setAgentMode).toHaveBeenCalledWith('accept-edits')
    expect(res.result).toContain('ОДОБРИЛ')
  })

  it('reject → setAgentMode НЕ вызван (выполнение не включается)', async () => {
    const ctx = makeCtx()
    const p = createPlanHandler.handle(call, ctx)
    const pending = [...(ctx as { pendingPlans: Map<string, { resolve: (d: unknown) => void }> }).pendingPlans.values()][0]
    pending.resolve({ decision: 'reject', feedback: 'нет' })
    await p
    expect((ctx as { setAgentMode: ReturnType<typeof vi.fn> }).setAgentMode).not.toHaveBeenCalled()
  })

  it('гейт ВЫКЛ (plan_approval_gate≠true) → НЕ блокирует, обычный план', async () => {
    const ctx = makeCtx({ getSecretForDelegate: () => null })
    const res = await createPlanHandler.handle(call, ctx) as { result: string }
    expect((ctx as { pendingPlans: Map<string, unknown> }).pendingPlans.size).toBe(0)
    expect(res.result).toContain('Plan #7')
  })
})
