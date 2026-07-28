// Блок D §4.4/§4.5: порядок исполнения и итог плана.
//
// ДЕФЕКТ, который лечим. Следующий шаг выбирался как `find(status !== 'done')`.
// Отсюда две вещи, прямо противоречащие ТЗ:
//   · провалившийся или пропущенный шаг выбирался СНОВА, и план упирался в него
//     навсегда — «остальные независимые шаги продолжаются» не работало;
//   · `dependsOn` на исполнение не влиял вовсе (его смотрел только quality-гейт
//     при создании плана) — шаг мог начаться раньше того, от чего зависит.
import { describe, it, expect } from 'vitest'
import { pickNextStep, dependenciesReady, planProgress, summarizePlan } from '../../electron/ai/plan-step-order'
import type { PlanStep } from '../../electron/storage/plans'

let seq = 0
const step = (patch: Partial<PlanStep> & { key?: string; deps?: string[] }): PlanStep => {
  const { key, deps, ...rest } = patch
  return {
    id: ++seq, planId: 1, idx: seq, title: `Шаг ${seq}`, detail: null,
    status: 'pending', result: null, runId: null, verificationStatus: null,
    changedFilesCount: null,
    spec: key ? ({ key, dependsOn: deps ?? [] } as never) : null,
    ...rest,
  } as PlanStep
}

describe('независимые шаги продолжаются, зависимые ждут', () => {
  it('провалившийся шаг НЕ блокирует независимый следующий', () => {
    const a = step({ title: 'A', status: 'failed', key: 'a' })
    const b = step({ title: 'B', key: 'b' })
    // Прежний find(status !== 'done') вернул бы A и упёрся бы в него навсегда.
    // failed — техническая неудача, её повтор осмыслен, поэтому A остаётся
    // кандидатом и берётся первым; ключевое — что план НЕ встал.
    expect(pickNextStep([a, b])?.title).toBe('A')
    // …а когда A отвергнут человеком, работа идёт дальше по независимому B.
    expect(pickNextStep([{ ...a, status: 'skipped' }, b])?.title).toBe('B')
  })

  it('шаг с невыполненной зависимостью НЕ берётся — берётся независимый', () => {
    const a = step({ title: 'A', key: 'a' })
    const b = step({ title: 'B', key: 'b', deps: ['a'] })
    const c = step({ title: 'C', key: 'c' })

    expect(pickNextStep([b, c, a])?.title, 'B зависит от A и не готов').toBe('C')
    expect(pickNextStep([b, { ...a, status: 'done' }])?.title, 'зависимость готова — B можно').toBe('B')
  })

  it('провалившаяся зависимость держит зависимый шаг в ожидании', () => {
    const a = step({ title: 'A', status: 'failed', key: 'a' })
    const b = step({ title: 'B', key: 'b', deps: ['a'] })
    expect(dependenciesReady(b, [a, b]), '«провалено» не равно «выполнено»').toBe(false)
  })

  it('отказ человека не переспрашивается: skipped в очередь не возвращается', () => {
    const a = step({ title: 'A', status: 'skipped', key: 'a' })
    expect(pickNextStep([a]), 'отказ превратился бы в бесконечный вопрос').toBeNull()
  })

  it('ссылка на несуществующий ключ не стопорит план намертво', () => {
    const b = step({ title: 'B', key: 'b', deps: ['нет-такого'] })
    expect(pickNextStep([b])?.title).toBe('B')
  })

  it('шаг без spec зависимостей не объявлял — идёт как есть (легаси-план)', () => {
    const a = step({ title: 'A' })
    expect(pickNextStep([a])?.title).toBe('A')
  })

  it('брать нечего — честный null, а не случайный шаг', () => {
    const done = step({ title: 'A', status: 'done' })
    const skipped = step({ title: 'B', status: 'skipped' })
    expect(pickNextStep([done, skipped])).toBeNull()
    expect(planProgress([done, skipped]).finished).toBe(true)
  })
})

describe('итог плана: что сделано, где результат, что осталось', () => {
  it('итог перечисляет сделанное с результатом и остаток', () => {
    const steps = [
      step({ title: 'Собрать лендинг', status: 'done', result: 'src/index.html' }),
      step({ title: 'Отправить письмо', status: 'skipped' }),
      step({ title: 'Проверить вёрстку', status: 'failed', result: 'не открылся предпросмотр' }),
      step({ title: 'Опубликовать' }),
    ]

    const text = summarizePlan('Лендинг', steps)

    expect(text).toContain('1 из 4 шагов готово')
    expect(text, 'где результат').toContain('src/index.html')
    expect(text).toContain('Пропущено по вашему решению')
    expect(text).toContain('Отправить письмо')
    expect(text).toContain('Не получилось')
    expect(text).toContain('не открылся предпросмотр')
    expect(text).toContain('Осталось')
    expect(text).toContain('Опубликовать')
  })

  it('шаг, ждущий зависимость, назван ожидающим — человеку видно, почему стоит', () => {
    const a = step({ title: 'A', key: 'a', status: 'failed' })
    const b = step({ title: 'B', key: 'b', deps: ['a'] })
    expect(summarizePlan('План', [a, b])).toContain('ждёт другие шаги')
  })

  it('полностью выполненный план говорит об этом прямо', () => {
    const steps = [step({ title: 'A', status: 'done' }), step({ title: 'B', status: 'done' })]
    expect(summarizePlan('План', steps)).toContain('План выполнен полностью')
  })

  it('пустых разделов в итоге нет', () => {
    const text = summarizePlan('План', [step({ title: 'A', status: 'done' })])
    expect(text).not.toContain('Не получилось')
    expect(text).not.toContain('Пропущено')
  })
})
