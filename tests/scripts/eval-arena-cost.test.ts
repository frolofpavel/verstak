// D1 (пакет 2.5.0, 10.08): Arena перестаёт быть слепой к цене успеха.
//
// (1) Ось цены: рост при ТОМ ЖЕ успехе = регрессия (costRegressions), с
// зеркальными контролями — та же цена не регрессия, изменившийся успех не
// сравнивается по оси цены. (2) Класс фикстур с автопродолжением живёт без
// прибитого --max-turns: maxTurns == null → аргумент не передаётся вовсе
// (контроль: с числом — передаётся). Перевод фикстур в класс — отдельное
// движение при новом замере; здесь меняется только измеритель.
import { describe, expect, it } from 'vitest'
// @ts-expect-error Eval report builder is an executable JavaScript module.
import { costRegressions, COST_REGRESSION_THRESHOLD } from '../../scripts/eval/arena-report.mjs'
// @ts-expect-error Eval runner is an executable JavaScript module.
import { buildVerstakCliArgs } from '../../scripts/eval/runners/verstak.mjs'

function row(patch: Record<string, unknown>) {
  return {
    runnerId: 'verstak', fixtureId: 'fx-1', result: 'pass', comparable: true,
    estimatedCost: null, tokensTotal: null, agentToolCalls: null,
    ...patch,
  }
}

describe('D1: costRegressions — рост цены при том же успехе', () => {
  it('РЕГРЕССИЯ: успех тот же, стоимость выросла больше порога', () => {
    const baseline = [row({ estimatedCost: 0.10 }), row({ estimatedCost: 0.10 })]
    const current = [row({ estimatedCost: 0.15 }), row({ estimatedCost: 0.15 })]
    const regs = costRegressions(current, baseline)
    expect(regs.length).toBe(1)
    expect(regs[0]).toMatchObject({ runnerId: 'verstak', fixtureId: 'fx-1', metric: 'estimatedCost' })
    expect(regs[0].growth).toBeGreaterThan(COST_REGRESSION_THRESHOLD)
  })

  it('КОНТРОЛЬ: та же цена — регрессии нет', () => {
    const rows = [row({ estimatedCost: 0.10 })]
    expect(costRegressions(rows, rows)).toEqual([])
  })

  it('успех ИЗМЕНИЛСЯ → ось цены молчит (это другой размен, не регрессия цены)', () => {
    const baseline = [row({ result: 'fail', estimatedCost: 0.10 })]
    const current = [row({ result: 'pass', estimatedCost: 0.50 })]
    expect(costRegressions(current, baseline)).toEqual([])
  })

  it('нет стоимости → фолбэк на токены; метрики разных видов не сравниваются', () => {
    const baseline = [row({ tokensTotal: 1000 })]
    const current = [row({ tokensTotal: 1300 })]
    const regs = costRegressions(current, baseline)
    expect(regs.length).toBe(1)
    expect(regs[0].metric).toBe('tokensTotal')
    // База мерила токены, текущий — стоимость: сравнивать нечего, тишина честнее подмены.
    expect(costRegressions([row({ estimatedCost: 0.5 })], [row({ tokensTotal: 1000 })])).toEqual([])
  })

  it('несравнимые строки (comparable=false) в ось цены не входят', () => {
    const baseline = [row({ estimatedCost: 0.10 })]
    const current = [row({ estimatedCost: 0.50, comparable: false })]
    expect(costRegressions(current, baseline)).toEqual([])
  })
})

describe('D1: класс автопродолжения — без прибитого --max-turns', () => {
  const base = {
    cliPath: '/cli.mjs', root: '/w', model: 'm', provider: 'deepseek',
    fixture: { recipe: 'bugfix', task: 'почини' },
  }

  it('maxTurns == null → --max-turns НЕ передаётся (бюджетом правит рантайм)', () => {
    const args = buildVerstakCliArgs({ ...base, maxTurns: null })
    expect(args).not.toContain('--max-turns')
  })

  it('КОНТРОЛЬ: числовой maxTurns передаётся как раньше', () => {
    const args = buildVerstakCliArgs({ ...base, maxTurns: 7 })
    const i = args.indexOf('--max-turns')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('7')
  })
})
