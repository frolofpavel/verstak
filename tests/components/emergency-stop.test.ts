import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { settleEmergencyStop } from '../../src/lib/emergency-stop'

describe('Shift+Esc emergency Stop ACK boundary', () => {
  it('не очищает renderer до main/helper ACK', async () => {
    let acknowledge!: (value: boolean) => void
    const stop = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve }))
    const resetRenderer = vi.fn()

    const pending = settleEmergencyStop(stop, resetRenderer)
    await Promise.resolve()

    expect(stop).toHaveBeenCalledWith(0)
    expect(resetRenderer).not.toHaveBeenCalled()
    acknowledge(true)
    await expect(pending).resolves.toBe(true)
    expect(resetRenderer).toHaveBeenCalledOnce()
  })

  it.each([
    ['negative ACK', async () => false],
    ['IPC reject', async () => { throw new Error('stop failed') }],
  ])('%s оставляет UI fail-closed в streaming/stopping', async (_case, stop) => {
    const resetRenderer = vi.fn()
    await expect(settleEmergencyStop(stop, resetRenderer)).resolves.toBe(false)
    expect(resetRenderer).not.toHaveBeenCalled()
  })

  it('production key handler использует ACK helper вместо fire-and-forget cleanup', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')
    expect(source).toContain('settleEmergencyStop(')
    expect(source).not.toMatch(/void window\.api\.ai\.stop\(0\)[\s\S]{0,160}setStreaming\(false\)/u)
  })
})
