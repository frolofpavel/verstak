import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'

// Пин на перенос registerRuntimeLogIpc из runtime-log.ts в runtime-log-ipc.ts (Этап 1а):
// канал 'runtime-logs:info' и форма ответа {dir, runtime, errors} обязаны остаться теми же —
// их читает вкладка логов в renderer через preload.
const registered = vi.hoisted(() => new Map<string, () => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: () => unknown) => {
      registered.set(channel, fn)
    }
  }
}))

describe('runtime-log-ipc — десктоп-контракт после расщепления', () => {
  it('регистрирует runtime-logs:info с прежней формой ответа', async () => {
    const { registerRuntimeLogIpc } = await import('../electron/runtime-log-ipc')
    registerRuntimeLogIpc()
    const handler = registered.get('runtime-logs:info')
    expect(handler).toBeTypeOf('function')
    const info = handler!() as { dir: string; runtime: string; errors: string }
    expect(info.runtime).toBe(join(info.dir, 'runtime.jsonl'))
    expect(info.errors).toBe(join(info.dir, 'errors.jsonl'))
  })
})
