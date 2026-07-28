// VSK-TASK-FLOW-A1, блок B §9: идемпотентность create_plan — РАНТАЙМОМ, не промптом.
//
// Дефект: модель, вызвавшая create_plan дважды в одном прогоне (перечитала
// контекст, «уточнила» формулировку), плодила дубликаты — в «Планах» появлялись
// два плана на одну задачу, и было неясно, какой исполняется. Промптом это не
// лечится: промпт можно проигнорировать, реестр — нет.
//
// Реестр живёт в runner-shared (sendId → planId) и чистится вместе с прогоном
// в unregisterChatRun. Ревизии он не мешает: доработка идёт отдельным
// инструментом replan_plan и через реестр не ходит.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'
import { __resetPlanForRunForTests, unregisterChatRun } from '../../electron/ai/runner-shared'
import { validContract } from '../contracts/outcome-contract.test'
import type { PlanStepSpecV1 } from '../../shared/contracts/outcome'

const spec: PlanStepSpecV1 = {
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

/** Контекст с ЖИВЫМ хранилищем планов: getPlan видит то, что записал recordPlan. */
function makeCtx(sendId: number) {
  const stored = new Map<number, { planRevision: number }>()
  let nextId = 100
  const pendingPlans = new Map<string, { sendId: number; resolve: (d: { decision: 'approve' | 'revise' | 'reject' }) => void }>()
  const set = pendingPlans.set.bind(pendingPlans)
  pendingPlans.set = ((key, value) => {
    const r = set(key, value)
    queueMicrotask(() => value.resolve({ decision: 'approve' }))
    return r
  }) as typeof pendingPlans.set

  const recordPlan = vi.fn(() => {
    const id = nextId++
    stored.set(id, { planRevision: 1 })
    return { id }
  })
  return {
    ctx: {
      projectPath: '/p',
      sendId,
      agentMode: 'auto',
      sender: { send: vi.fn() },
      recordPlan,
      getPlan: vi.fn((id: number) => stored.get(id) ?? null),
      recordJournal: vi.fn(),
      getSecretForDelegate: vi.fn(),
      pendingPlans,
      scopedKey: (s: number, callId: string) => `${s}:${callId}`,
      outcome: { pipelineId: 7, phase: 'plan' },
      pipelineRuns: {
        get: vi.fn(() => ({ id: 7, projectPath: '/p', taskContract: validContract, contractRevision: validContract.revision, planId: null })),
      },
    } as never,
    recordPlan,
    stored,
  }
}

const call = (id: string) => ({
  id,
  name: 'create_plan',
  args: { title: 'Auth plan', steps: [{ title: 'Исправить auth', detail: 'Конкретный auth fix и проверка.', spec }] },
}) as never

beforeEach(() => { __resetPlanForRunForTests() })

describe('create_plan — один прогон, один план', () => {
  it('повторный вызов в том же прогоне возвращает существующий planId и НЕ создаёт дубликат', async () => {
    const { ctx, recordPlan } = makeCtx(1)
    const first = await createPlanHandler.handle(call('c1'), ctx)
    expect(recordPlan).toHaveBeenCalledTimes(1)
    expect(first.error).toBeUndefined()

    const second = await createPlanHandler.handle(call('c2'), ctx)
    expect(recordPlan, 'дубликат плана создан').toHaveBeenCalledTimes(1)
    expect(String(second.result)).toContain('уже создан')
    expect(String(second.result)).toContain('planId=100')
    expect(second.error).toBeUndefined()
  })

  it('повторный вызов подсказывает модели правильный инструмент доработки', async () => {
    const { ctx } = makeCtx(2)
    await createPlanHandler.handle(call('c1'), ctx)
    const second = await createPlanHandler.handle(call('c2'), ctx)
    expect(String(second.result)).toContain('replan_plan')
  })

  it('другой прогон — свой план: реестр ключуется по sendId', async () => {
    const a = makeCtx(10)
    const b = makeCtx(11)
    await createPlanHandler.handle(call('c1'), a.ctx)
    await createPlanHandler.handle(call('c1'), b.ctx)
    expect(a.recordPlan).toHaveBeenCalledTimes(1)
    expect(b.recordPlan, 'соседний прогон не должен упереться в чужой план').toHaveBeenCalledTimes(1)
  })

  it('после завершения прогона реестр очищен — следующая задача получает свой план', async () => {
    const { ctx, recordPlan } = makeCtx(20)
    await createPlanHandler.handle(call('c1'), ctx)
    unregisterChatRun(20)
    await createPlanHandler.handle(call('c2'), ctx)
    expect(recordPlan, 'после конца прогона план должен создаваться заново').toHaveBeenCalledTimes(2)
  })

  it('план исчез из хранилища — повторный вызов создаёт новый, а не ссылается на призрак', async () => {
    const { ctx, recordPlan, stored } = makeCtx(30)
    await createPlanHandler.handle(call('c1'), ctx)
    stored.clear() // план удалили в UI посреди прогона
    await createPlanHandler.handle(call('c2'), ctx)
    expect(recordPlan).toHaveBeenCalledTimes(2)
  })

  it('невалидный повторный вызов получает СВОЮ ошибку, а не молчаливый успех', async () => {
    const { ctx } = makeCtx(40)
    await createPlanHandler.handle(call('c1'), ctx)
    const bad = await createPlanHandler.handle(
      { id: 'c2', name: 'create_plan', args: { title: 'Auth plan', steps: [] } } as never,
      ctx,
    )
    expect(bad.error, 'пустой список шагов обязан оставаться ошибкой').toContain('пустой список шагов')
  })
})
