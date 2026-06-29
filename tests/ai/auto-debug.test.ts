import { describe, it, expect } from 'vitest'
import { formatAutoDebugResult, runUntilGreenHandler } from '../../electron/ipc/tool-handlers/command'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'

// run_until_green (ось 3 E) — цикл fix-until-green для ПРОИЗВОЛЬНОЙ команды.
describe('formatAutoDebugResult', () => {
  it('exit 0 → passed, без директивы чинить', () => {
    const r = formatAutoDebugResult(0, 1, 5)
    expect(r.passed).toBe(true)
    expect(r.exhausted).toBe(false)
    expect(r.directive).toMatch(/зелёна|пройдена/i)
  })

  it('exit≠0 до лимита → чини и повтори (директива без agent-attempt)', () => {
    const r = formatAutoDebugResult(1, 2, 5)
    expect(r.passed).toBe(false)
    expect(r.exhausted).toBe(false)
    expect(r.directive).toMatch(/почини/i)
    expect(r.directive).toMatch(/2\/5/) // показывает прогресс
  })

  it('exit≠0 НА лимите → exhausted, честно «не починил», не «готово»', () => {
    const r = formatAutoDebugResult(1, 5, 5)
    expect(r.passed).toBe(false)
    expect(r.exhausted).toBe(true)
    expect(r.directive).toMatch(/лимит исчерпан/i)
    expect(r.directive).toMatch(/НЕ говори|честно/i)
  })
})

describe('runUntilGreenHandler — серверный счётчик (агент не обходит лимит)', () => {
  // Мок ctx: команда разрешена, режим auto (auto-accept), команда всегда падает.
  const ctx = {
    sendId: 777,
    agentMode: 'auto',
    getSecretForDelegate: () => null,
    sender: { send: () => {} },
    recordRunEvent: () => {},
    tools: {
      classifyCommand: () => ({ allowed: true }),
      runCommand: async () => ({ stdout: '', stderr: 'boom', exitCode: 1 }),
    },
  } as unknown as ToolContext

  it('5 вызовов с одной командой (агент не шлёт attempt) → на 5-м exhausted', async () => {
    const call = (i: number) => ({ id: `c${i}`, name: 'run_until_green', args: { command: 'npm run lint' } })
    let last: { exhausted?: boolean } = {}
    for (let i = 1; i <= 5; i++) {
      const res = await runUntilGreenHandler.handle(call(i), ctx)
      last = res.result as { exhausted?: boolean }
      if (i < 5) expect(last.exhausted).toBe(false)
    }
    expect(last.exhausted).toBe(true) // серверный счётчик дошёл до лимита, агент не обошёл
  })
})
