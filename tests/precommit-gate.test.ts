import { describe, it, expect } from 'vitest'
import { hasNonAbiFailures, decideTestGate } from '../scripts/gate-lib.cjs'

// Pre-commit гейт «гарантия вместо обещания»: блокирует коммит при реальных
// падениях, но НЕ при ABI-шуме (открыт `npm run dev` → NODE_MODULE_VERSION).
describe('hasNonAbiFailures', () => {
  it('только NODE_MODULE_VERSION-падения → false (ABI-шум)', () => {
    const out = ` FAIL tests/storage/db.test.ts\nNODE_MODULE_VERSION 143. This version of Node.js requires\nNODE_MODULE_VERSION 137.`
    expect(hasNonAbiFailures(out)).toBe(false)
  })
  it('вторичный каскад db.close на undefined (тоже ABI) → false', () => {
    const out = ` FAIL tests/storage/x.test.ts\nTypeError: Cannot read properties of undefined (reading 'close')`
    expect(hasNonAbiFailures(out)).toBe(false)
  })
  it('реальный AssertionError → true', () => {
    const out = ` FAIL tests/ai/foo.test.ts\nAssertionError: expected 1 to be 2`
    expect(hasNonAbiFailures(out)).toBe(true)
  })
  it('чистый вывод → false', () => {
    expect(hasNonAbiFailures('Tests  10 passed (10)')).toBe(false)
  })
  it('многострочная better-sqlite3 ABI-ошибка → false (Error: на одной строке, NODE_MODULE_VERSION на другой)', () => {
    const out = ` FAIL tests/storage/agent-runs.test.ts\nError: The module '\\\\?\\C:\\...\\better_sqlite3.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 143. This version of Node.js requires\nNODE_MODULE_VERSION 137.`
    expect(hasNonAbiFailures(out)).toBe(false)
  })
})

describe('decideTestGate', () => {
  it('exit 0 → не блокирует', () => {
    expect(decideTestGate({ abiStatus: 'ok', vitestExit: 0, vitestOutput: '' }).block).toBe(false)
  })
  it('ABI в норме + падения → блокирует (реальная регрессия)', () => {
    expect(decideTestGate({ abiStatus: 'ok', vitestExit: 1, vitestOutput: 'AssertionError: x' }).block).toBe(true)
  })
  it('ABI-лок + только ABI-падения → НЕ блокирует (шум)', () => {
    const out = 'FAIL db.test\nNODE_MODULE_VERSION 143'
    expect(decideTestGate({ abiStatus: 'failed', vitestExit: 1, vitestOutput: out }).block).toBe(false)
  })
  it('ABI-лок + есть НЕ-ABI падение → блокирует (регрессия под шумом)', () => {
    const out = 'FAIL db.test\nNODE_MODULE_VERSION 143\nFAIL ai/foo\nAssertionError: real'
    expect(decideTestGate({ abiStatus: 'failed', vitestExit: 1, vitestOutput: out }).block).toBe(true)
  })
})
