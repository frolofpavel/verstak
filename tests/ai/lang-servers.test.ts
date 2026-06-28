import { describe, it, expect } from 'vitest'
import {
  resolveLangServer,
  isLspDiagnosableFile,
  isLspNavigableFile,
  extractErrorDiagnostics,
  formatLspDiagnosticHint,
} from '../../electron/ai/lang-servers'

// T1.1 — мультиязычный LSP в петле: не-TS файлы (Python/Go/Rust) после правки
// диагностируются языковым сервером, ошибки инжектятся в следующий ход. Здесь —
// чистое ядро: реестр серверов + извлечение ошибок из publishDiagnostics + хинт.
describe('resolveLangServer', () => {
  it('Python → pyright (--stdio, languageId python)', () => {
    const c = resolveLangServer('src/app.py')
    expect(c?.languageId).toBe('python')
    expect(c?.command).toContain('pyright')
    expect(c?.args).toContain('--stdio')
  })
  it('Go → gopls, Rust → rust-analyzer', () => {
    expect(resolveLangServer('main.go')?.languageId).toBe('go')
    expect(resolveLangServer('lib.rs')?.languageId).toBe('rust')
  })
  it('TS/TSX → null для ДИАГНОСТИК (покрыто tsc-петлёй, не дублируем)', () => {
    expect(resolveLangServer('a.ts')).toBeNull()
    expect(resolveLangServer('a.tsx')).toBeNull()
  })
  it('TS/JS → typescript-language-server ТОЛЬКО при navigation=true', () => {
    expect(resolveLangServer('a.ts', { navigation: true })?.command).toBe('typescript-language-server')
    // languageId по расширению (важно для JSX-парсинга)
    expect(resolveLangServer('a.ts', { navigation: true })?.languageId).toBe('typescript')
    expect(resolveLangServer('a.tsx', { navigation: true })?.languageId).toBe('typescriptreact')
    expect(resolveLangServer('a.jsx', { navigation: true })?.languageId).toBe('javascriptreact')
    expect(resolveLangServer('a.mjs', { navigation: true })?.languageId).toBe('javascript')
  })
  it('navigation НЕ перебивает реестр диагностик (py остаётся pyright)', () => {
    expect(resolveLangServer('a.py', { navigation: true })?.command).toBe('pyright-langserver')
  })
  it('неизвестное расширение → null (даже при navigation)', () => {
    expect(resolveLangServer('readme.md')).toBeNull()
    expect(resolveLangServer('readme.md', { navigation: true })).toBeNull()
  })
})

describe('isLspDiagnosableFile', () => {
  it('py → true, ts → false, md → false', () => {
    expect(isLspDiagnosableFile('a.py')).toBe(true)
    expect(isLspDiagnosableFile('a.ts')).toBe(false)
    expect(isLspDiagnosableFile('a.md')).toBe(false)
  })
})

describe('isLspNavigableFile (включает TS/JS — гейт хендлера навигации)', () => {
  it('TS/JS/py навигабельны, md — нет', () => {
    expect(isLspNavigableFile('a.ts')).toBe(true)
    expect(isLspNavigableFile('a.tsx')).toBe(true)
    expect(isLspNavigableFile('a.js')).toBe(true)
    expect(isLspNavigableFile('a.py')).toBe(true)
    expect(isLspNavigableFile('a.md')).toBe(false)
  })
})

describe('extractErrorDiagnostics', () => {
  it('берёт только severity=1 (ошибки), отбрасывает warnings', () => {
    const params = {
      uri: 'file:///a.py',
      diagnostics: [
        { severity: 1, message: 'undefined name x', range: { start: { line: 4, character: 2 } }, source: 'pyright' },
        { severity: 2, message: 'unused import', range: { start: { line: 0, character: 0 } } },
      ],
    }
    const r = extractErrorDiagnostics(params)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ line: 4, character: 2, message: 'undefined name x', source: 'pyright' })
  })
  it('нет diagnostics / не объект → []', () => {
    expect(extractErrorDiagnostics({ uri: 'x' })).toEqual([])
    expect(extractErrorDiagnostics(null)).toEqual([])
    expect(extractErrorDiagnostics('nope')).toEqual([])
  })
  it('severity отсутствует → считаем ошибкой (LSP-дефолт)', () => {
    const r = extractErrorDiagnostics({ diagnostics: [{ message: 'bad', range: { start: { line: 1, character: 0 } } }] })
    expect(r).toHaveLength(1)
  })
})

describe('formatLspDiagnosticHint', () => {
  it('пусто → null', () => {
    expect(formatLspDiagnosticHint('a.py', [])).toBeNull()
  })
  it('форматирует 1-based строку/колонку + источник + «почини»', () => {
    const hint = formatLspDiagnosticHint('src/app.py', [
      { line: 4, character: 2, severity: 1, message: 'undefined name x', source: 'pyright' },
    ])
    expect(hint).toContain('src/app.py:5:3')
    expect(hint).toContain('undefined name x')
    expect(hint).toMatch(/почини/i)
  })
})
