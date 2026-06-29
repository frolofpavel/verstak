import { describe, it, expect } from 'vitest'
import { formatAutoDebugResult } from '../../electron/ipc/tool-handlers/command'

// run_until_green (ось 3 E) — цикл fix-until-green для ПРОИЗВОЛЬНОЙ команды.
describe('formatAutoDebugResult', () => {
  it('exit 0 → passed, без директивы чинить', () => {
    const r = formatAutoDebugResult(0, 1, 5)
    expect(r.passed).toBe(true)
    expect(r.exhausted).toBe(false)
    expect(r.directive).toMatch(/зелёна|пройдена/i)
  })

  it('exit≠0 до лимита → чини и повтори с attempt+1', () => {
    const r = formatAutoDebugResult(1, 2, 5)
    expect(r.passed).toBe(false)
    expect(r.exhausted).toBe(false)
    expect(r.directive).toContain('attempt: 3') // следующая попытка
    expect(r.directive).toMatch(/почини/i)
  })

  it('exit≠0 НА лимите → exhausted, честно «не починил», не «готово»', () => {
    const r = formatAutoDebugResult(1, 5, 5)
    expect(r.passed).toBe(false)
    expect(r.exhausted).toBe(true)
    expect(r.directive).toMatch(/лимит исчерпан/i)
    expect(r.directive).toMatch(/НЕ говори|честно/i)
    expect(r.directive).not.toContain('attempt: 6') // не предлагает следующую
  })
})
