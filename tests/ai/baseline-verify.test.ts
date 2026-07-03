import { describe, it, expect } from 'vitest'
import { extractErrorSignatures, diffAgainstBaseline, BaselineStore } from '../../electron/ai/baseline-verify'

/** Этап 4, Блок F — baseline-aware verification: pre-existing red не блокирует,
 *  новые ошибки блокируют, идентичный вывод проходит. */

const TSC_ONE = `src/a.ts(10,5): error TS2339: Property 'foo' does not exist on type 'Bar'.`
const TSC_TWO = `src/a.ts(10,5): error TS2339: Property 'foo' does not exist on type 'Bar'.
src/b.ts(3,1): error TS2554: Expected 1 arguments, but got 0.`
const CLEAN = `✅ Нет ошибок TypeScript.`

describe('extractErrorSignatures', () => {
  it('парсит tsc-ошибки, игнорирует success', () => {
    expect(extractErrorSignatures(CLEAN)).toEqual([])
    expect(extractErrorSignatures(TSC_ONE)).toHaveLength(1)
    expect(extractErrorSignatures(TSC_TWO)).toHaveLength(2)
  })

  it('сигнатура стабильна к сдвигу строки (line/col отброшены)', () => {
    const a = `src/a.ts(10,5): error TS2339: Property 'foo' does not exist.`
    const b = `src/a.ts(42,9): error TS2339: Property 'foo' does not exist.`
    expect(extractErrorSignatures(a)).toEqual(extractErrorSignatures(b))
  })

  it('парсит формат check_diagnostics (path:line:col — TSxxxx)', () => {
    const d = `src/a.ts:10:5 — TS2339: Property 'foo' does not exist.`
    expect(extractErrorSignatures(d)).toHaveLength(1)
  })

  it('парсит vitest FAIL строки', () => {
    const v = `FAIL tests/x.test.ts > does thing\n× another case`
    expect(extractErrorSignatures(v).length).toBeGreaterThanOrEqual(2)
  })
})

describe('diffAgainstBaseline', () => {
  it('идентичный вывод → нет новых ошибок, не блокирует', () => {
    const d = diffAgainstBaseline(TSC_ONE, TSC_ONE)
    expect(d.newErrors).toEqual([])
    expect(d.blocked).toBe(false)
    expect(d.preExisting).toHaveLength(1)
  })

  it('pre-existing red не блокирует (было красное, осталось то же)', () => {
    const d = diffAgainstBaseline(TSC_TWO, TSC_TWO)
    expect(d.blocked).toBe(false)
    expect(d.newErrors).toEqual([])
  })

  it('новая ошибка блокирует', () => {
    const d = diffAgainstBaseline(TSC_ONE, TSC_TWO)
    expect(d.blocked).toBe(true)
    expect(d.newErrors).toHaveLength(1)
  })

  it('чистый baseline + новая ошибка → блок', () => {
    const d = diffAgainstBaseline(CLEAN, TSC_ONE)
    expect(d.blocked).toBe(true)
    expect(d.newErrors).toHaveLength(1)
  })

  it('починка pre-existing → resolved, не блокирует', () => {
    const d = diffAgainstBaseline(TSC_TWO, TSC_ONE)
    expect(d.blocked).toBe(false)
    expect(d.resolved).toHaveLength(1)
  })
})

describe('BaselineStore', () => {
  it('snapshot → compare по run+command', () => {
    const s = new BaselineStore()
    expect(s.has('run1', 'npm run type')).toBe(false)
    s.snapshot('run1', 'npm run type', TSC_ONE)
    expect(s.has('run1', 'npm run type')).toBe(true)
    const d = s.compare('run1', 'npm run type', TSC_TWO)
    expect(d).not.toBeNull()
    expect(d!.blocked).toBe(true)
  })

  it('compare без baseline → null', () => {
    const s = new BaselineStore()
    expect(s.compare('nope', 'npm run type', TSC_ONE)).toBeNull()
  })

  it('clear убирает снапшоты прогона', () => {
    const s = new BaselineStore()
    s.snapshot('run1', 'npm run type', TSC_ONE)
    s.clear('run1')
    expect(s.has('run1', 'npm run type')).toBe(false)
  })
})
