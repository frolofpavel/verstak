import { describe, expect, it } from 'vitest'
import { formatStepLine } from '../../electron/ai/step-log'

// V2-5 (agent-runtime-v2.md §4). Событий у прогона хватало и раньше; не хватало
// одной СОПОСТАВИМОЙ строки на шаг — по разноформатным журналам две версии
// рантайма между собой не сравнить, а именно это и нужно, чтобы увидеть, где
// агент буксует. Порядок и состав полей — из постановки буквально:
// шаг · цель · действие · результат · решение · прогресс.

const call = (name: string, args: unknown, error?: string) => ({ name, args, error })

describe('formatStepLine — единый формат строки шага', () => {
  it('все шесть полей на месте и в порядке постановки', () => {
    const line = formatStepLine({
      step: 3, budget: 16, goal: 'расширить контракт formatPrice',
      calls: [call('write_file', { path: 'price.mjs' })],
      decision: 'продолжаю', progressed: true, newFacts: 1,
    })
    const fields = line.split(' · ').map(f => f.split(':')[0])
    expect(fields).toEqual(['шаг 3/16', 'цель', 'действие', 'результат', 'решение', 'прогресс'])
  })

  it('действие несёт предмет вызова — путь или команду, а не одно имя', () => {
    const line = formatStepLine({
      step: 1, calls: [call('run_command', { command: 'npm run test:fast' })], decision: 'продолжаю',
    })
    expect(line).toContain('run_command(npm run test:fast)')
  })

  it('длинный список действий сворачивается, но количество не теряется', () => {
    const line = formatStepLine({
      step: 1, decision: 'продолжаю',
      calls: [1, 2, 3, 4, 5].map(i => call('read_file', { path: `f${i}.ts` })),
    })
    expect(line).toContain('+2')
  })

  it('результат различает успех, полный провал и частичный', () => {
    const ok = formatStepLine({ step: 1, calls: [call('read_file', { path: 'a.ts' })], decision: 'продолжаю' })
    expect(ok).toContain('результат: ok')

    const failed = formatStepLine({ step: 1, calls: [call('read_file', { path: 'нет.ts' }, 'файл не найден')], decision: 'продолжаю' })
    expect(failed).toContain('результат: ошибка: файл не найден')

    const partial = formatStepLine({
      step: 1, decision: 'продолжаю',
      calls: [call('read_file', { path: 'a.ts' }), call('read_file', { path: 'нет.ts' }, 'файл не найден')],
    })
    expect(partial).toContain('результат: частично: 1 из 2')
  })

  it('прогресс — обязательное поле, и «нет» называет длину буксования', () => {
    // Без этого поля строка остаётся перечислением вызовов: видно, ЧТО агент
    // делал, и не видно, продвинулся ли он. Ради него V2-5 и заводится.
    const moving = formatStepLine({ step: 2, calls: [call('read_file', { path: 'a.ts' })], decision: 'продолжаю', progressed: true, newFacts: 2 })
    expect(moving).toContain('прогресс: да (+2)')

    const stuck = formatStepLine({ step: 9, calls: [call('read_file', { path: 'a.ts' })], decision: 'прошу сменить подход (repeat-call)', progressed: false, staleTurns: 3 })
    expect(stuck).toContain('прогресс: нет (3 подряд)')
    expect(stuck).toContain('решение: прошу сменить подход (repeat-call)')
  })

  it('ход без инструментов остаётся шагом, а не пропадает из журнала', () => {
    const line = formatStepLine({ step: 5, calls: [], decision: 'требую доказательство: файлы изменены, проверок нет' })
    expect(line).toContain('действие: без инструментов')
    expect(line).toContain('результат: текст')
  })

  it('строка ОДНА: переводов строки в ней нет даже при многострочной цели', () => {
    const line = formatStepLine({
      step: 1, goal: 'первая строка\nвторая строка\nтретья', calls: [call('read_file', { path: 'a.ts' })], decision: 'продолжаю',
    })
    expect(line).not.toContain('\n')
  })

  it('пустые поля не роняют формат — вместо дыры честное значение', () => {
    const line = formatStepLine({ step: 1 })
    expect(line).toContain('цель: не задана')
    expect(line).toContain('решение: продолжаю')
    expect(line.split(' · ')).toHaveLength(6)
  })
})
