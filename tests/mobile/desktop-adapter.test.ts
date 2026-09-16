import { describe, expect, it, vi } from 'vitest'
import { createMobileHandlers } from '../../electron/mobile-bridge/adapter'

describe('mobile desktop adapter', () => {
  it('creates chats and sends through injected desktop runner', async () => {
    const create = vi.fn(() => ({ id: 3, title: 'Mobile', projectPath: 'C:/project' }))
    const appendToSession = vi.fn()
    const startRun = vi.fn(async () => ({ runId: 'run-1' }))
    const handlers = createMobileHandlers({
      roots: { list: () => [{ rootId: 'r', name: 'Project', available: true }], projectPath: () => 'C:/project', resolve: vi.fn() },
      sessions: { list: vi.fn(() => []), create, get: vi.fn(() => ({ id: 3, projectPath: 'C:/project', kind: 'main' })) } as never,
      chats: { listBySession: vi.fn(() => []), appendToSession } as never,
      startRun,
      stopRun: vi.fn(async () => true),
    })
    expect(await handlers['chat.create']!({ rootId: 'r', title: 'Mobile' }, {} as never)).toMatchObject({ id: 3 })
    expect(await handlers['chat.send']!({ rootId: 'r', chatId: 3, text: 'Do it' }, {} as never)).toEqual({ runId: 'run-1' })
    expect(appendToSession).toHaveBeenCalledWith(3, 'C:/project', 'user', 'Do it')
    expect(startRun).toHaveBeenCalledWith({ chatId: 3, projectPath: 'C:/project', text: 'Do it' })
  })

  it('rejects a Computer Use attempt before durable append or desktop run dispatch', async () => {
    const appendToSession = vi.fn()
    const startRun = vi.fn(async () => ({ runId: 'run-should-not-start' }))
    const handlers = createMobileHandlers({
      roots: { list: () => [{ rootId: 'r', name: 'Project', available: true }], projectPath: () => 'C:/project', resolve: vi.fn() },
      sessions: { list: vi.fn(() => []), create: vi.fn(), get: vi.fn(() => ({ id: 3, projectPath: 'C:/project', kind: 'main' })) } as never,
      chats: { listBySession: vi.fn(() => []), appendToSession } as never,
      startRun,
      stopRun: vi.fn(async () => true),
    })
    const privateCommand = '/computer-use: введи MOBILE_PRIVATE в выбранном окне'

    await expect(handlers['chat.send']!(
      { rootId: 'r', chatId: 3, text: privateCommand },
      {} as never,
    )).rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')

    expect(appendToSession).not.toHaveBeenCalled()
    expect(startRun).not.toHaveBeenCalled()
    await expect(handlers['chat.send']!(
      { rootId: 'r', chatId: 3, text: privateCommand },
      {} as never,
    )).rejects.not.toThrow(privateCommand)
  })
})
