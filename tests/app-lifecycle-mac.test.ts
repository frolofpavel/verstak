import { describe, expect, it } from 'vitest'
import { shouldHideWindowOnClose } from '../electron/app-lifecycle'

describe('macOS desktop lifecycle', () => {
  it('hides the last window instead of destroying the desktop session', () => {
    expect(shouldHideWindowOnClose('darwin', false)).toBe(true)
  })

  it('allows the window to close during an explicit application quit', () => {
    expect(shouldHideWindowOnClose('darwin', true)).toBe(false)
  })

  it('does not change Windows close behavior', () => {
    expect(shouldHideWindowOnClose('win32', false)).toBe(false)
  })
})
