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

// Интеграция: §10 — гейт показывает карточку и НЕ ждёт внутри прогона.
//
// Прежний контракт этого блока («блокирует-и-ждёт, approve → setAgentMode
// изнутри») переписан сознательно: решение по §10 вынесло ожидание наружу
// прогона. Оба старых кейса резолвили промис из pendingPlans — промиса больше
// нет, ждать нечего. Кейсы ниже держат НОВЫЙ контракт того же места.
describe('plan-gate: createPlanHandler (ожидание снаружи прогона)', () => {
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
      runId: 'run-1',
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

  // Главное свойство переноса: хендлер возвращается САМ. Ничего не резолвим —
  // если await вернётся, значит прогон снова ждёт человека внутри себя.
  it('карточка показана, но хендлер возвращается сам — прогон не ждёт человека', async () => {
    const ctx = makeCtx()
    const res = await createPlanHandler.handle(call, ctx) as { result: string }
    const events = (ctx as { sender: { send: ReturnType<typeof vi.fn> } }).sender.send.mock.calls
      .map(c => (c[1] as { event: { type: string } }).event)
    expect(events.some(e => e.type === 'plan-approval'), 'карточка обязана появиться').toBe(true)
    expect(res.result).toContain('согласование')
    expect(res.result).toContain('не выполняй')
    expect((ctx as { pendingPlans: Map<string, unknown> }).pendingPlans.size, 'ожидание внутри прогона не заводится').toBe(0)
  })

  // Рантайм, а не просьба в тексте: пока решение не принято, прогон работает в
  // режиме plan, где mode-policy блокирует любую запись.
  it('на время ожидания режим прогона ПОНИЖЕН до plan', async () => {
    const ctx = makeCtx({ agentMode: 'plan' })
    await createPlanHandler.handle(call, ctx)
    expect((ctx as { setAgentMode: ReturnType<typeof vi.fn> }).setAgentMode).toHaveBeenCalledWith('plan')
    expect((ctx as { setAgentMode: ReturnType<typeof vi.fn> }).setAgentMode)
      .not.toHaveBeenCalledWith('accept-edits')
  })

  it('план запоминает прогон — по нему пойдёт продолжение после approve', async () => {
    const recordPlan = vi.fn(() => ({ id: 7 }))
    const ctx = makeCtx({ recordPlan, runId: 'run-42' })
    await createPlanHandler.handle(call, ctx)
    expect(recordPlan).toHaveBeenCalledWith('/p', 'Рефактор', expect.any(Array),
      expect.objectContaining({ agentRunId: 'run-42' }))
  })

  it('гейт ВЫКЛ (plan_approval_gate≠true) → НЕ блокирует, обычный план', async () => {
    const ctx = makeCtx({ getSecretForDelegate: () => null })
    const res = await createPlanHandler.handle(call, ctx) as { result: string }
    expect((ctx as { pendingPlans: Map<string, unknown> }).pendingPlans.size).toBe(0)
    expect(res.result).toContain('Plan #7')
  })
})
