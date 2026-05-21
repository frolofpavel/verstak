import { describe, it, expect } from 'vitest'
import { applySearchReplaceBlocks } from '../../electron/ai/tools'

describe('applySearchReplaceBlocks', () => {
  it('applies a single block', () => {
    const before = 'line1\nold\nline3\n'
    const diff = `<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE`
    expect(applySearchReplaceBlocks(before, diff)).toBe('line1\nnew\nline3\n')
  })

  it('applies multiple blocks sequentially', () => {
    const before = 'function a() { return 1 }\nfunction b() { return 2 }\n'
    const diff = `<<<<<<< SEARCH
function a() { return 1 }
=======
function a() { return 11 }
>>>>>>> REPLACE

<<<<<<< SEARCH
function b() { return 2 }
=======
function b() { return 22 }
>>>>>>> REPLACE`
    const result = applySearchReplaceBlocks(before, diff)
    expect(result).toContain('return 11')
    expect(result).toContain('return 22')
  })

  it('throws when SEARCH is not found', () => {
    expect(() => applySearchReplaceBlocks('foo bar', '<<<<<<< SEARCH\nbaz\n=======\nqux\n>>>>>>> REPLACE'))
      .toThrow(/не найден/)
  })

  it('throws when SEARCH is ambiguous', () => {
    const before = 'same\nsame\n'
    const diff = `<<<<<<< SEARCH
same
=======
other
>>>>>>> REPLACE`
    expect(() => applySearchReplaceBlocks(before, diff)).toThrow(/несколько раз/)
  })

  it('throws when no blocks present', () => {
    expect(() => applySearchReplaceBlocks('x', 'just a string'))
      .toThrow(/не найдено ни одного валидного/)
  })

  it('preserves indentation', () => {
    const before = '  if (x) {\n    return y\n  }\n'
    const diff = `<<<<<<< SEARCH
    return y
=======
    return z
>>>>>>> REPLACE`
    expect(applySearchReplaceBlocks(before, diff)).toBe('  if (x) {\n    return z\n  }\n')
  })

  it('whitespace fallback: matches when trailing spaces differ', () => {
    // Original file has trailing space on the line
    const before = 'const x = 1   \nconst y = 2\n'
    // AI generates patch WITHOUT trailing spaces
    const diff = `<<<<<<< SEARCH
const x = 1
const y = 2
=======
const x = 99
const y = 88
>>>>>>> REPLACE`
    const result = applySearchReplaceBlocks(before, diff)
    expect(result).toContain('const x = 99')
    expect(result).toContain('const y = 88')
  })

  it('handles multiline replacements', () => {
    const before = 'a\nb\nc\n'
    const diff = `<<<<<<< SEARCH
a
b
=======
A
B
B2
>>>>>>> REPLACE`
    expect(applySearchReplaceBlocks(before, diff)).toBe('A\nB\nB2\nc\n')
  })
})
