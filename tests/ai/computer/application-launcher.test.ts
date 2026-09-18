import { describe, expect, it, vi } from 'vitest'
import { launchComputerApplication } from '../../../electron/ai/computer/application-launcher'

describe('Computer Use allowlisted application launcher', () => {
  it.each([
    ['notepad' as const, 'notepad.exe'],
    ['calculator' as const, 'calc.exe'],
  ])('maps %s to one fixed executable without user-controlled argv', async (app, executable) => {
    const unref = vi.fn()
    const spawn = vi.fn(() => ({
      unref,
      once(event: string, listener: (...args: unknown[]) => void) {
        if (event === 'spawn') queueMicrotask(listener)
        return this
      },
    }))

    await launchComputerApplication(app, spawn as never)

    expect(spawn).toHaveBeenCalledWith(executable, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    expect(unref).toHaveBeenCalledOnce()
  })
})
