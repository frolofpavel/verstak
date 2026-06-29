import { describe, it, expect } from 'vitest'
import { memoryInvalidateHandler } from '../../electron/ipc/tool-handlers/memory'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'

// memory_invalidate (ось 4 #2) — реконсиляция: агент помечает устаревший факт.
const baseCtx = (invalidate: (id: string, sb?: string | null) => boolean) => ({
  projectPath: '/p', sender: { send: () => {} }, invalidateMemory: invalidate,
} as unknown as ToolContext)

describe('memoryInvalidateHandler', () => {
  it('id + superseded_by → зовёт invalidateMemory, успех', async () => {
    let got: [string, string | null | undefined] | null = null
    const ctx = baseCtx((id, sb) => { got = [id, sb]; return true })
    const res = await memoryInvalidateHandler.handle({ id: 'c', name: 'memory_invalidate', args: { id: 'mem-1', superseded_by: 'mem-2' } }, ctx)
    expect(got).toEqual(['mem-1', 'mem-2'])
    expect(res.error).toBeUndefined()
    expect(res.result).toMatch(/устаревш/i)
  })

  it('пустой id → ошибка, invalidate не зовётся', async () => {
    let called = false
    const ctx = baseCtx(() => { called = true; return true })
    const res = await memoryInvalidateHandler.handle({ id: 'c', name: 'memory_invalidate', args: { id: ' ' } }, ctx)
    expect(res.error).toMatch(/обязател/i)
    expect(called).toBe(false)
  })

  it('invalidateMemory вернул false (не найдено/уже устаревшее) → ошибка', async () => {
    const ctx = baseCtx(() => false)
    const res = await memoryInvalidateHandler.handle({ id: 'c', name: 'memory_invalidate', args: { id: 'mem-x' } }, ctx)
    expect(res.error).toMatch(/не найден|устаревш/i)
  })

  it('нет ctx.invalidateMemory → честная ошибка (недоступен)', async () => {
    const res = await memoryInvalidateHandler.handle({ id: 'c', name: 'memory_invalidate', args: { id: 'm' } }, { projectPath: '/p', sender: { send: () => {} } } as unknown as ToolContext)
    expect(res.error).toMatch(/недоступен/i)
  })
})
