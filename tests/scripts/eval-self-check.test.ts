import { describe, expect, it } from 'vitest'
// @ts-expect-error Eval modules are executable JavaScript.
import { analyzeSelfCheck, describeSelfCheck } from '../../scripts/eval/self-check.mjs'
// @ts-expect-error Eval report builder is an executable JavaScript module.
import { buildArenaSummary, renderArenaMarkdown } from '../../scripts/eval/arena-report.mjs'

// Метрика «проверил ли себя агент» (V2 §5): после ПОСЛЕДНЕЙ принятой записи в файлы
// в трейсе обязаны быть проверочные действия — run_command с тестом/тайпчеком/сборкой,
// check_diagnostics или attest_verification. Без этой метрики эффект главной правки
// V2-3 (completion gate) нечем показать; baseline снимается уже с ней.
// Правило репозитория: рядом с «проверка ЕСТЬ» стоят контрольные кейсы, где её НЕТ.

function trace(toolCalls: Array<{ turn: number; name: string; args?: Record<string, unknown> }>) {
  return { toolCalls, turnsUsed: 5, toolCallsCount: toolCalls.length }
}

describe('analyzeSelfCheck — проверил ли себя агент после записей', () => {
  it('запись, затем run_command с тестом → checked с уликой-командой', () => {
    const result = analyzeSelfCheck(
      trace([
        { turn: 0, name: 'read_file', args: { path: 'a.mjs' } },
        { turn: 1, name: 'write_file', args: { path: 'a.mjs' } },
        { turn: 2, name: 'run_command', args: { command: 'npm run test:fast' } },
      ]),
    )
    expect(result.status).toBe('checked')
    expect(result.evidence).toEqual(['run_command: npm run test:fast'])
  })

  it('КОНТРОЛЬ: запись БЕЗ последующей проверки → unchecked', () => {
    const result = analyzeSelfCheck(
      trace([
        { turn: 0, name: 'run_command', args: { command: 'npm run test:fast' } },
        { turn: 1, name: 'write_file', args: { path: 'a.mjs' } },
      ]),
    )
    expect(result.status).toBe('unchecked')
    expect(result.evidence).toEqual([])
  })

  it('проверка ДО последней записи не считается: write → test → write → unchecked', () => {
    const result = analyzeSelfCheck(
      trace([
        { turn: 0, name: 'apply_patch', args: { path: 'a.mjs' } },
        { turn: 1, name: 'run_command', args: { command: 'npx vitest run' } },
        { turn: 2, name: 'write_file', args: { path: 'b.mjs' } },
      ]),
    )
    expect(result.status).toBe('unchecked')
  })

  it('run_command с НЕпроверочной командой после записи → unchecked', () => {
    const result = analyzeSelfCheck(
      trace([
        { turn: 0, name: 'write_file', args: { path: 'a.mjs' } },
        { turn: 1, name: 'run_command', args: { command: 'dir' } },
      ]),
    )
    expect(result.status).toBe('unchecked')
  })

  it('тайпчек и сборка тоже считаются проверкой (tsc / npm run type / npm run build)', () => {
    for (const command of ['npm run type', 'tsc --noEmit', 'npm run build', 'node test.mjs']) {
      const result = analyzeSelfCheck(
        trace([
          { turn: 0, name: 'write_file', args: { path: 'a.mjs' } },
          { turn: 1, name: 'run_command', args: { command } },
        ]),
      )
      expect(result.status, command).toBe('checked')
    }
  })

  it('check_diagnostics / attest_verification / review_before_commit — проверка (V2-инструменты и гейт)', () => {
    for (const name of ['check_diagnostics', 'attest_verification', 'review_before_commit']) {
      const result = analyzeSelfCheck(
        trace([
          { turn: 0, name: 'write_file', args: { path: 'a.mjs' } },
          { turn: 1, name },
        ]),
      )
      expect(result.status, name).toBe('checked')
      expect(result.evidence).toEqual([name])
    }
  })

  it('прогон без записей — метрике нечего мерить: no-writes', () => {
    const result = analyzeSelfCheck(
      trace([
        { turn: 0, name: 'read_file', args: { path: 'a.mjs' } },
        { turn: 1, name: 'run_command', args: { command: 'npm run test:fast' } },
      ]),
    )
    expect(result.status).toBe('no-writes')
  })

  it('трейса нет (раннер не отдал JSON) → no-trace, а не ложное unchecked', () => {
    expect(analyzeSelfCheck(null).status).toBe('no-trace')
    expect(analyzeSelfCheck({}).status).toBe('no-trace')
  })

  it('describeSelfCheck даёт короткую строку для колонки отчёта', () => {
    expect(describeSelfCheck({ status: 'checked', evidence: ['run_command: npm test'] })).toBe('yes')
    expect(describeSelfCheck({ status: 'unchecked', evidence: [] })).toBe('NO')
    expect(describeSelfCheck({ status: 'no-writes', evidence: [] })).toBe('no-writes')
    expect(describeSelfCheck({ status: 'no-trace', evidence: [] })).toBe('unknown')
  })
})

describe('Arena-отчёт несёт метрику self-check рядом с существующими', () => {
  function row(overrides: Record<string, unknown>) {
    return {
      runnerId: 'verstak',
      runnerLabel: 'Verstak',
      runnerVersion: 'verstak-x',
      model: 'same/model',
      fixtureId: 'bugfix',
      repeat: 1,
      result: 'pass',
      failureMode: '',
      verifyPass: true,
      changedFiles: [],
      unrelatedFilesTouched: false,
      durationMs: 10,
      estimatedCost: null,
      interventions: 0,
      comparable: true,
      comparabilityReason: '',
      traceSecretLeak: false,
      exitCode: 0,
      agentTurns: 4,
      agentToolCalls: 7,
      agentErrors: false,
      selfCheck: 'checked',
      selfCheckEvidence: ['run_command: npm run test:fast'],
      ...overrides,
    }
  }

  it('сводка считает self-check rate только по прогонам, где записи были', () => {
    const rows = [
      row({ repeat: 1, selfCheck: 'checked' }),
      row({ repeat: 2, selfCheck: 'unchecked' }),
      row({ repeat: 3, selfCheck: 'no-writes' }),
    ]
    const [summary] = buildArenaSummary(rows, 3)
    expect(summary.selfCheckedRuns).toBe(1)
    expect(summary.selfCheckEligibleRuns).toBe(2)
    expect(summary.selfCheckRate).toBe(0.5)
  })

  it('КОНТРОЛЬ: без прогонов с записями rate не выдумывается (null)', () => {
    const [summary] = buildArenaSummary([row({ selfCheck: 'no-trace' })], 1)
    expect(summary.selfCheckEligibleRuns).toBe(0)
    expect(summary.selfCheckRate).toBeNull()
  })

  it('markdown-таблица запусков содержит колонки шагов/вызовов/ошибок/self-check', () => {
    const payload = {
      meta: {
        verstakCommit: 'c'.repeat(40),
        runDate: '2026-08-09T00:00:00.000Z',
        suite: 'core',
        repeat: 1,
        reproduceCommand: 'npm run eval:arena',
      },
      rows: [row({})],
      summary: buildArenaSummary([row({})], 1),
    }
    const markdown = renderArenaMarkdown(payload)
    expect(markdown).toContain('| turns | calls | errors | self-check |')
    expect(markdown).toMatch(/\| 4 \| 7 \| no \| yes \|/)
  })
})
