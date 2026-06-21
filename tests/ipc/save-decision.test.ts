import { describe, it, expect, vi } from 'vitest'
import { saveDecisionHandler } from '../../electron/ipc/tool-handlers/memory'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

function mkCtx(saveDecision: unknown): ToolContext {
  return {
    sender: { send: () => {} },
    sendId: 1,
    projectPath: 'C:/proj',
    saveDecision,
  } as unknown as ToolContext
}
const call = (args: Record<string, unknown>): ToolCall =>
  ({ id: 'c1', name: 'save_decision', args }) as unknown as ToolCall

describe('save_decision handler — Decision Memory', () => {
  it('маппит args → NewDecisionRecord и зовёт ctx.saveDecision', async () => {
    const spy = vi.fn((pp: string, rec: Record<string, unknown>) => ({ id: 42, projectPath: pp, ...rec, createdAt: 1, updatedAt: 1 }))
    const res = await saveDecisionHandler.handle(call({
      title: 'Брать клиента X',
      decision: 'Берём на пилот',
      user_request: 'стоит ли брать X?',
      why: 'окупается за 2 месяца',
      key_arguments: ['маржа', 'кейс'],
      risks: ['срыв сроков'],
      next_actions: ['КП завтра'],
      confidence: 'high',
      revisit_days: 30,
    }), mkCtx(spy))
    expect(spy).toHaveBeenCalledTimes(1)
    const [pp, rec] = spy.mock.calls[0] as [string, Record<string, unknown>]
    expect(pp).toBe('C:/proj')
    expect(rec.title).toBe('Брать клиента X')
    expect(rec.finalDecision).toBe('Берём на пилот')
    expect(rec.userRequest).toBe('стоит ли брать X?')
    expect(rec.why).toBe('окупается за 2 месяца')
    expect(rec.keyArguments).toEqual(['маржа', 'кейс'])
    expect(rec.risks).toEqual(['срыв сроков'])
    expect(rec.nextActions).toEqual(['КП завтра'])
    expect(rec.confidence).toBe('high')
    expect(rec.revisitDate as number).toBeGreaterThan(Date.now()) // now + 30 дней
    expect(res.result).toMatch(/#42/)
    expect(res.error).toBeUndefined()
  })

  it('требует title и decision', async () => {
    const spy = vi.fn()
    const res = await saveDecisionHandler.handle(call({ title: '', decision: 'x' }), mkCtx(spy))
    expect(spy).not.toHaveBeenCalled()
    expect(res.error).toMatch(/обязательн/i)
  })

  it('невалидный confidence → null; нет revisit_days → revisitDate null; нет массивов → []', async () => {
    const spy = vi.fn((pp: string, rec: Record<string, unknown>) => ({ id: 1, projectPath: pp, ...rec, createdAt: 1, updatedAt: 1 }))
    await saveDecisionHandler.handle(call({ title: 't', decision: 'd', confidence: 'maybe' }), mkCtx(spy))
    const rec = spy.mock.calls[0][1] as Record<string, unknown>
    expect(rec.confidence).toBeNull()
    expect(rec.revisitDate).toBeNull()
    expect(rec.objections).toEqual([])
    expect(rec.keyArguments).toEqual([])
  })
})
