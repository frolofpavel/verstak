import { describe, expect, it } from 'vitest'
import { scopesMayConflict } from '../../electron/ai/conflict-graph'

describe('Agent Job conflict graph', () => {
  it('два reader не конфликтуют, writer exact/parent/glob конфликтуют', () => {
    expect(scopesMayConflict([], [])).toBe(false)
    expect(scopesMayConflict(['src/a.ts'], ['src/a.ts'])).toBe(true)
    expect(scopesMayConflict(['src'], ['src/a.ts'])).toBe(true)
    expect(scopesMayConflict(['src/**/*.ts'], ['src/a.ts'])).toBe(true)
    expect(scopesMayConflict(['src/**'], ['tests/**'])).toBe(false)
  })

})
