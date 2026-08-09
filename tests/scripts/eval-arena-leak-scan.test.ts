import { describe, expect, it } from 'vitest'
// @ts-expect-error Eval contracts is an executable JavaScript module.
import { scanRunnerOutputForSecretLeak } from '../../scripts/eval/contracts.mjs'

// Дефект живого baseline 09.08: имя workspace-каталога содержит fixture.id, и
// 'task-refinement' порождает подстроку 'sk-task-refinement-…' (>16 допустимых
// символов) — детектор секретов резал все три повтора фикстуры как «утечку»,
// хотя это был ЕГО СОБСТВЕННЫЙ путь. Путь workspace — известный не-секрет и
// вырезается до скана; настоящие ключи в выводе остаются видимыми.

describe('scanRunnerOutputForSecretLeak — свой workspace-путь не считается утечкой', () => {
  it('путь model-gym-arena-…-task-refinement-… НЕ утечка (репро baseline 09.08)', () => {
    const raw = 'workspace: C:\\Temp\\model-gym-arena-verstak-task-refinement-a1b2c3\\README.md ok'
    expect(scanRunnerOutputForSecretLeak(raw)).toBe(false)
  })

  it('путь в JSON-строке с экранированными слэшами тоже не утечка', () => {
    const raw = '{"projectPath":"C:\\\\Temp\\\\model-gym-arena-verstak-task-refinement-a1b2c3"}'
    expect(scanRunnerOutputForSecretLeak(raw)).toBe(false)
  })

  it('КОНТРОЛЬ: настоящий api-ключ в выводе остаётся утечкой', () => {
    expect(scanRunnerOutputForSecretLeak('oops sk-abcdefghijklmnop1234 leaked')).toBe(true)
  })

  it('КОНТРОЛЬ: ключ рядом с workspace-путём не маскируется вырезанием пути', () => {
    const raw = 'C:\\Temp\\model-gym-arena-verstak-task-refinement-a1b2c3 Bearer abcdefghijklmnopqrstuv'
    expect(scanRunnerOutputForSecretLeak(raw)).toBe(true)
  })
})
