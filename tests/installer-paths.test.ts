import { describe, expect, it } from 'vitest'
import { defaultInstallDir } from '../electron/installer/paths'

describe('installer paths', () => {
  it('defaultInstallDir points to LocalAppData Programs Verstak on Windows', () => {
    const prev = process.env.LOCALAPPDATA
    process.env.LOCALAPPDATA = 'C:\\Users\\Test\\AppData\\Local'
    expect(defaultInstallDir()).toBe('C:\\Users\\Test\\AppData\\Local\\Programs\\Verstak')
    process.env.LOCALAPPDATA = prev
  })
})