import { describe, it, expect } from 'vitest'
import { parseLocations, findSymbolPosition, findSymbolPositions } from '../../electron/ai/lsp-nav'

// Tier-2 #1 — LSP-навигация: чистое ядро (парсинг LSP-ответа Location/LocationLink +
// поиск позиции символа в файле). Сетевой запрос (definition/references) — в runtime.
describe('parseLocations', () => {
  it('null/undefined → []', () => {
    expect(parseLocations(null)).toEqual([])
    expect(parseLocations(undefined)).toEqual([])
  })
  it('одиночный Location → один элемент', () => {
    const r = parseLocations({ uri: 'file:///home/u/proj/src/a.py', range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } } })
    expect(r).toHaveLength(1)
    expect(r[0].line).toBe(4)
    expect(r[0].character).toBe(2)
    expect(r[0].file).toContain('a.py')
  })
  it('массив Location → все', () => {
    const r = parseLocations([
      { uri: 'file:///home/u/a.py', range: { start: { line: 1, character: 0 } } },
      { uri: 'file:///home/u/b.py', range: { start: { line: 9, character: 4 } } },
    ])
    expect(r).toHaveLength(2)
    expect(r[1].line).toBe(9)
  })
  it('LocationLink (targetUri/targetRange) → нормализуется', () => {
    const r = parseLocations([{ targetUri: 'file:///home/u/c.py', targetRange: { start: { line: 7, character: 1 } } }])
    expect(r).toHaveLength(1)
    expect(r[0].line).toBe(7)
    expect(r[0].file).toContain('c.py')
  })
  it('LocationLink: targetSelectionRange приоритетнее targetRange (имя, не блок с doc-комментом)', () => {
    const r = parseLocations([{ targetUri: 'file:///home/u/d.go', targetRange: { start: { line: 9, character: 0 } }, targetSelectionRange: { start: { line: 10, character: 5 } } }])
    expect(r[0].line).toBe(10) // имя на стр.10, а не блок-с-комментом на стр.9
    expect(r[0].character).toBe(5)
  })
  it('мусор/без range — пропускается', () => {
    expect(parseLocations([{ uri: 'file:///x' }, null, 'nope', { range: { start: { line: 1 } } }])).toEqual([])
  })
})

describe('findSymbolPosition', () => {
  const code = 'import os\n\ndef compute(x):\n    return compute_inner(x)\n'
  it('находит первое словограничное вхождение (строка/колонка 0-based)', () => {
    const p = findSymbolPosition(code, 'compute')
    expect(p).toEqual({ line: 2, character: 4 }) // "def compute" на строке 2, col 4
  })
  it('словограница: compute НЕ матчит внутри compute_inner', () => {
    const p = findSymbolPosition('x = compute_inner()\ncompute()\n', 'compute')
    expect(p).toEqual({ line: 1, character: 0 }) // не строка 0 (там compute_inner)
  })
  it('не найден → null', () => {
    expect(findSymbolPosition(code, 'nonexistent')).toBeNull()
  })
  it('спецсимволы в имени экранируются (не ломают regex)', () => {
    expect(() => findSymbolPosition('a.b.c\n', 'b.c')).not.toThrow()
  })
})

describe('findSymbolPositions (перебор кандидатов: первое вхождение может быть в комментарии)', () => {
  it('возвращает ВСЕ вхождения сверху вниз', () => {
    const code = '# foo здесь\nfoo()\ndef foo(): pass\n'
    const ps = findSymbolPositions(code, 'foo')
    expect(ps.length).toBeGreaterThanOrEqual(3) // комментарий + usage + def
    expect(ps[0]).toEqual({ line: 0, character: 2 }) // первое — в комментарии (его сервер пропустит)
  })
  it('несколько вхождений в одной строке', () => {
    expect(findSymbolPositions('x = a + a', 'a')).toEqual([{ line: 0, character: 4 }, { line: 0, character: 8 }])
  })
  it('словограница соблюдается (a не матчит в abc)', () => {
    expect(findSymbolPositions('abc a', 'a')).toEqual([{ line: 0, character: 4 }])
  })
})
