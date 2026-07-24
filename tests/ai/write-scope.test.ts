import { describe, expect, it } from 'vitest'
import { decideWriteScope } from '../../electron/ai/write-scope'

describe('Agent Job write scope', () => {
  it('разрешает exact, каталог и glob', () => {
    expect(decideWriteScope('src/a.ts', ['src/a.ts']).allowed).toBe(true)
    expect(decideWriteScope('src/deep/a.ts', ['src']).allowed).toBe(true)
    expect(decideWriteScope('tests/a.test.ts', ['tests/**/*.ts']).allowed).toBe(true)
  })

  it('блокирует read-only, соседний путь, traversal и absolute даже в bypass-контуре', () => {
    expect(decideWriteScope('src/a.ts', []).allowed).toBe(false)
    expect(decideWriteScope('electron/a.ts', ['src/**']).allowed).toBe(false)
    expect(decideWriteScope('../outside.ts', ['**']).allowed).toBe(false)
    expect(decideWriteScope('C:\\outside.ts', ['**']).allowed).toBe(false)
  })
})
