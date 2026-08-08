import { describe, it, expect, vi } from 'vitest'
import { spawnTaskSessionHandler } from '../../electron/ipc/tool-handlers/spawn-task-session'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

// Задача 10: spawn_task_session эмитит событие видимой дочерней сессии + сеет seed.
function ctx(send: ReturnType<typeof vi.fn>, journal: ReturnType<typeof vi.fn>): ToolContext {
  return {
    sendId: 7, projectPath: '/proj',
    sender: { send },
    recordJournal: journal,
  } as unknown as ToolContext
}
const call = (args: Record<string, unknown>): ToolCall => ({ id: 'c1', name: 'spawn_task_session', args })

describe('spawnTaskSessionHandler (задача 10)', () => {
  it('эмитит spawn-task-session с seed = задача + возвращает spawned', async () => {
    const send = vi.fn(); const journal = vi.fn()
    const res = await spawnTaskSessionHandler.handle(call({ title: 'Отчёт Директа', task: 'собери отчёт' }), ctx(send, journal))
    expect(send).toHaveBeenCalledTimes(1)
    const [channel, payload] = send.mock.calls[0]
    expect(channel).toBe('ai:event')
    expect(payload.event).toMatchObject({ type: 'spawn-task-session', callId: 'c1', title: 'Отчёт Директа' })
    // C(а): seed = задача + факт бюджета (24 хода). Проверяем оба, без хрупкого точного равенства.
    expect(payload.event.seed).toContain('собери отчёт')
    expect(payload.event.seed).toContain('24 ходов')
    expect(res).toMatchObject({ id: 'c1', name: 'spawn_task_session', result: { spawned: true, title: 'Отчёт Директа' } })
    expect(journal).toHaveBeenCalled()
  })

  it('plan → спавн ЗАБЛОКИРОВАН гейтом, сессия не заводится (восьмой обход)', async () => {
    const send = vi.fn(); const journal = vi.fn()
    const planCtx = { sendId: 7, projectPath: '/proj', sender: { send }, recordJournal: journal, agentMode: 'plan' } as unknown as ToolContext
    const res = await spawnTaskSessionHandler.handle(call({ title: 'Отчёт', task: 'собери' }), planCtx)
    expect(res.error).toBeTruthy()
    expect(String(res.error)).toContain('планирования')
    expect(send).not.toHaveBeenCalled()
  })

  it('пустой title/task → ошибка, событие не эмитится', async () => {
    const send = vi.fn(); const journal = vi.fn()
    const res = await spawnTaskSessionHandler.handle(call({ title: '', task: 'x' }), ctx(send, journal))
    expect(res.error).toBeTruthy()
    expect(send).not.toHaveBeenCalled()
  })
})
