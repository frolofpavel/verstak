import { describe, expect, it } from 'vitest'
import { desktopPlatformCapabilities } from '../../electron/desktop-platform'

describe('desktop platform boundaries', () => {
  it('Mac M0 keeps the shared desktop core but disables Windows-only surfaces', () => {
    expect(desktopPlatformCapabilities('darwin')).toEqual({
      autoUpdate: false,
      browserEmployee: false,
      computerUse: false,
    })
  })

  it('Windows keeps the existing capability set unchanged', () => {
    expect(desktopPlatformCapabilities('win32')).toEqual({
      autoUpdate: true,
      browserEmployee: true,
      computerUse: true,
    })
  })
})
