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

  it('whitespace fallback: applies patch on \\r\\n file with trailing spaces in SEARCH', () => {
    // File uses \r\n line endings + trailing spaces on some lines
    const before = 'function foo() {\r\n  return 1;  \r\n}\r\n'
    // AI generates patch with \n and without trailing spaces
    const diff = `<<<<<<< SEARCH
function foo() {
  return 1;
}
=======
function foo() {
  return 42;
}
>>>>>>> REPLACE`
    const result = applySearchReplaceBlocks(before, diff)
    expect(result).toContain('return 42')
    expect(result).not.toContain('return 1')
  })

  it('whitespace fallback: throws when normalized search matches multiple times', () => {
    // Both lines become the same after trailing-space strip
    const before = 'x = 1   \nx = 1\n'
    const diff = `<<<<<<< SEARCH
x = 1
=======
x = 99
>>>>>>> REPLACE`
    expect(() => applySearchReplaceBlocks(before, diff)).toThrow(/несколько раз/)
  })

  // #5: whitespace-fallback раньше переписывал ВЕСЬ файл из normResult → нетронутые
  // строки теряли \r (CRLF→LF) и trailing whitespace. На CRLF-проекте (норма здесь)
  // любой patch с LF-SEARCH срабатывал по fallback и корраптил весь файл.
  it('whitespace fallback НЕ трогает нетронутые строки (CRLF + trailing ws сохранены)', () => {
    const before = 'header   \r\nfunction foo() {\r\n  return 1;\r\n}\r\nfooter   \r\n'
    const diff = '<<<<<<< SEARCH\nfunction foo() {\n  return 1;\n}\n=======\nfunction foo() {\n  return 42;\n}\n>>>>>>> REPLACE'
    const after = applySearchReplaceBlocks(before, diff)
    expect(after).toContain('return 42')
    expect(after).toContain('header   \r\n')  // \r и trailing-пробелы нетронутой строки сохранены
    expect(after).toContain('footer   \r\n')
    expect(after).not.toContain('return 1;')
  })

  // Ревью 23.06 #7 (vs OpenClaw/Hermes — они теряют байты): защищаем нашу силу
  // position-map'а на ДЛИННЫХ строках (>2000 симв) — gigantская нетронутая строка
  // в CRLF-проекте должна сохранить и \r, и trailing ws, и весь контент целиком.
  it('whitespace fallback: длинные строки (>2000) сохраняют CRLF + контент целиком', () => {
    const longHeader = 'H'.repeat(2500)
    const longFooter = 'F'.repeat(2500)
    const before = `${longHeader}   \r\nfunction foo() {\r\n  return 1;\r\n}\r\n${longFooter}   \r\n`
    const diff = '<<<<<<< SEARCH\nfunction foo() {\n  return 1;\n}\n=======\nfunction foo() {\n  return 42;\n}\n>>>>>>> REPLACE'
    const after = applySearchReplaceBlocks(before, diff)
    expect(after).toContain('return 42')
    expect(after).toContain(`${longHeader}   \r\n`) // длинная строка целиком + CRLF + trailing ws
    expect(after).toContain(`${longFooter}   \r\n`)
    expect(after.length).toBeGreaterThan(5000)       // строки не усохли
  })
})
