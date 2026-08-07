import { describe, it, expect } from 'vitest'
import { hasNonAbiFailures, decideTestGate } from '../scripts/gate-lib.cjs'
import { classifyRebuildOutcome } from '../scripts/safe-rebuild.cjs'

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

  // Задача 2 (07.08): статус 'locked' — .node залочен запущенным Electron, пересборка
  // физически не прошла. sqlite-падения = среда, не регрессия.
  it('locked (.node залочен) + только ABI-падения → НЕ блокирует (среда)', () => {
    const out = 'FAIL db.test\nNODE_MODULE_VERSION 143'
    const r = decideTestGate({ abiStatus: 'locked', vitestExit: 1, vitestOutput: out })
    expect(r.block).toBe(false)
    expect(r.reason).toMatch(/залочен|среда|npm run dev/i)  // человеку сказано словами, почему пропущено
  })
  it('locked + НЕ-ABI падение → блокирует (реальная регрессия под шумом)', () => {
    const out = 'FAIL db.test\nNODE_MODULE_VERSION 143\nAssertionError: real'
    expect(decideTestGate({ abiStatus: 'locked', vitestExit: 1, vitestOutput: out }).block).toBe(true)
  })
  // КОНТРОЛЬ (условие приёмки штаба): при ПРОВЕРЕННО успешной пересборке ('rebuilt')
  // ABI-падений быть не должно, поэтому ЛЮБОЕ падение — регрессия. Иначе починка
  // превратила бы гейт в вечно-снисходительный (хуже исходного).
  it('rebuilt (пересборка ПРОВЕРЕНА) + ABI-вид падения → всё равно блокирует', () => {
    const out = 'FAIL db.test\nNODE_MODULE_VERSION 143'
    expect(decideTestGate({ abiStatus: 'rebuilt', vitestExit: 1, vitestOutput: out }).block).toBe(true)
  })
})

// Задача 2 (07.08): safe-rebuild рапортовал 'rebuilt' по коду возврата npm, хотя на
// залоченном .node файл не заменялся — ложный зелёный ломал ровно тот инструмент, что
// отличает шум от регрессии. Классификатор исхода вынесен в пуре-функцию: статус берётся
// из ПРОВЕРКИ факта (загрузился ли модуль после), а не из кода возврата.
describe('classifyRebuildOutcome — честный статус пересборки (проверка факта, не кода возврата)', () => {
  it('проверка после пересборки прошла → rebuilt', () => {
    expect(classifyRebuildOutcome({ spawnError: false, afterOk: true, afterAbiMismatch: false, isBusy: false })).toBe('rebuilt')
  })
  it('npm вернул 0, но .node всё ещё ABI-mismatch (залочен) → locked, НЕ rebuilt', () => {
    expect(classifyRebuildOutcome({ spawnError: false, afterOk: false, afterAbiMismatch: true, isBusy: false })).toBe('locked')
  })
  it('npm упал по EBUSY/EPERM (лок) → locked', () => {
    expect(classifyRebuildOutcome({ spawnError: false, afterOk: false, afterAbiMismatch: false, isBusy: true })).toBe('locked')
  })
  it('не загрузилось и не лок → failed', () => {
    expect(classifyRebuildOutcome({ spawnError: false, afterOk: false, afterAbiMismatch: false, isBusy: false })).toBe('failed')
  })
  it('spawn самого npm упал → failed', () => {
    expect(classifyRebuildOutcome({ spawnError: true, afterOk: false, afterAbiMismatch: false, isBusy: false })).toBe('failed')
  })
})
