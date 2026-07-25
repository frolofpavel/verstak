// 2.1.10-F: управление идущим прогоном (стоп/приостановка/append-context) и резолв
// pending-подтверждений вынесены из registerAiIpc в ipc/ai-resolve.ts.
//
// Резолверы раньше были тремя копиями одного алгоритма прямо в хендлерах и напрямую не
// проверялись. Ключевой инвариант — скоуп по sendId: параллельные ai:send не имеют права
// резолвить чужие подтверждения (иначе подтверждение записи в одном чате разблокирует
// запись в другом). Плюс обратная совместимость: старый рендерер шлёт callId без sendId.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const ipcMain = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } }

const { registerAiResolveIpc } = await import('../../electron/ipc/ai-resolve')
const { pendingWrites, pendingCommands, pendingPlans, suspendedSends, scopedKey } = await import('../../electron/ai/runner-shared')
const { registerConversationSupplements, unregisterConversationSupplements } = await import('../../electron/ai/runner-supplements')

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

describe('ai-resolve — IPC управления прогоном', () => {
  let aborted: number[]

  beforeEach(() => {
    handlers.clear()
    pendingWrites.clear()
    pendingCommands.clear()
    pendingPlans.clear()
    suspendedSends.clear()
    aborted = []
    registerAiResolveIpc(ipcMain as never, (sendId: number) => { aborted.push(sendId); return true })
  })

  it('регистрирует ровно свои каналы', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'ai:append-context', 'ai:resolve-command', 'ai:resolve-plan', 'ai:resolve-write', 'ai:stop', 'ai:suspend',
    ])
  })

  it('resolve-write со ЗНАЕМЫМ sendId бьёт строго по своему скоупу', () => {
    const mine = vi.fn()
    const foreign = vi.fn()
    pendingWrites.set(scopedKey(1, 'call-a'), { sendId: 1, resolve: mine })
    pendingWrites.set(scopedKey(2, 'call-a'), { sendId: 2, resolve: foreign })
    call('ai:resolve-write', 'call-a', true, 1)
    expect(mine).toHaveBeenCalledWith(true)
    expect(foreign, 'подтверждение соседнего прогона трогать нельзя').not.toHaveBeenCalled()
    expect(pendingWrites.has(scopedKey(1, 'call-a'))).toBe(false)
    expect(pendingWrites.has(scopedKey(2, 'call-a')), 'чужая запись остаётся ждать').toBe(true)
  })

  it('resolve-write БЕЗ sendId — обратная совместимость: скан по суффиксу callId', () => {
    const resolve = vi.fn()
    pendingWrites.set(scopedKey(7, 'call-b'), { sendId: 7, resolve })
    call('ai:resolve-write', 'call-b', false)
    expect(resolve).toHaveBeenCalledWith(false)
    expect(pendingWrites.size).toBe(0)
  })

  it('несуществующий callId никого не резолвит и не падает', () => {
    const resolve = vi.fn()
    pendingWrites.set(scopedKey(1, 'call-a'), { sendId: 1, resolve })
    expect(() => call('ai:resolve-write', 'call-missing', true, 1)).not.toThrow()
    expect(resolve).not.toHaveBeenCalled()
    expect(pendingWrites.size).toBe(1)
  })

  it('resolve-command работает по тому же скоупу, но по своему реестру', () => {
    const cmd = vi.fn()
    const write = vi.fn()
    pendingCommands.set(scopedKey(3, 'c1'), { sendId: 3, resolve: cmd })
    pendingWrites.set(scopedKey(3, 'c1'), { sendId: 3, resolve: write })
    call('ai:resolve-command', 'c1', true, 3)
    expect(cmd).toHaveBeenCalledWith(true)
    expect(write, 'реестры не должны пересекаться').not.toHaveBeenCalled()
  })

  it('resolve-plan доставляет решение и комментарий целиком', () => {
    const resolve = vi.fn()
    pendingPlans.set(scopedKey(4, 'p1'), { sendId: 4, resolve })
    call('ai:resolve-plan', 'p1', 'revise', 'добавь шаг с тестами', 4)
    expect(resolve).toHaveBeenCalledWith({ decision: 'revise', feedback: 'добавь шаг с тестами' })
    expect(pendingPlans.size).toBe(0)
  })

  it('ai:stop прерывает переданный прогон', () => {
    expect(call('ai:stop', 42)).toBe(true)
    expect(aborted).toEqual([42])
    expect(suspendedSends.has(42), 'обычный стоп не помечает прогон приостановленным').toBe(false)
  })

  it('ai:suspend помечает прогон приостановленным ДО abort — иначе finally запишет stopped', () => {
    let markedAtAbort = false
    handlers.clear()
    registerAiResolveIpc(ipcMain as never, (sendId: number) => { markedAtAbort = suspendedSends.has(sendId); return true })
    call('ai:suspend', 9)
    expect(markedAtAbort, 'пометка обязана быть видна уже в момент прерывания').toBe(true)
    expect(suspendedSends.has(9)).toBe(true)
  })

  it('ai:append-context: пустой текст и неположительный sendId отбиваются как invalid', () => {
    expect(call('ai:append-context', 1, '   ')).toEqual({ ok: false, fallback: 'invalid' })
    expect(call('ai:append-context', 0, 'текст')).toEqual({ ok: false, fallback: 'invalid' })
  })

  it('ai:append-context: нет активного прогона — unavailable, есть — принято', () => {
    expect(call('ai:append-context', 5, 'учти вот это')).toEqual({ ok: false, fallback: 'unavailable' })
    const push = vi.fn()
    registerConversationSupplements(5, push)
    try {
      const res = call('ai:append-context', 5, 'учти вот это') as { ok: boolean; mode?: string }
      expect(res.ok).toBe(true)
      expect(res.mode).toBe('deferred')
      expect(push, 'текст обязан доехать до активного прогона').toHaveBeenCalledWith('учти вот это')
    } finally {
      unregisterConversationSupplements(5)
    }
  })
})
