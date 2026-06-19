import { describe, it, expect } from 'vitest'
import { toProjectAbsPath } from '../../src/lib/project-path'

describe('toProjectAbsPath', () => {
  it('windows-корень: `\\`-сепаратор, обрезает ./', () => {
    expect(toProjectAbsPath('C:\\proj', './src/a.ts')).toBe('C:\\proj\\src\\a.ts')
    expect(toProjectAbsPath('C:\\proj', 'src/a.ts')).toBe('C:\\proj\\src\\a.ts')
  })

  it('posix-корень: `/`-сепаратор', () => {
    expect(toProjectAbsPath('/home/proj', './src/a.ts')).toBe('/home/proj/src/a.ts')
    expect(toProjectAbsPath('/home/proj', '.\\src\\a.ts')).toBe('/home/proj/src/a.ts')
  })
})
