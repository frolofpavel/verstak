// Правило 2 цикла (§1 и §4.4 ТЗ): после approve выполнение идёт БЕЗ остановок
// между шагами, и единственная пауза — перед ОТВЕТСТВЕННЫМ действием.
//
// Почему это не «просто текст». Режим продолжения остаётся `accept-edits`
// сознательно: понизь его до `ask` — и переспрашивать начнёт КАЖДАЯ правка, то
// есть сломается правило 1 («одно утверждение на план, между шагами не
// останавливаемся»). Значит место паузы должно быть названо адресно, а не взято
// глобальным ужесточением прав. Кто именно ответственный, решает тот же порог
// §4.2, что решал про карточку, — второй список слов не заводится.
import { describe, it, expect } from 'vitest'
import { planDecisionOutsideRun } from '../../electron/ai/plan-await'

const base = { id: 7, title: 'Рассылка по клиентам', agentRunId: 'run-1' }

describe('пауза перед ответственным действием в утверждённом плане', () => {
  it('approve с ответственными шагами: они названы поимённо, режим прежний', () => {
    const outcome = planDecisionOutsideRun('approve', undefined, {
      ...base,
      responsibleSteps: ['Отправить письма клиентам', 'Опубликовать страницу'],
    })

    const text = outcome.continuation!.text
    expect(text).toContain('Отправить письма клиентам')
    expect(text).toContain('Опубликовать страницу')
    expect(text).toContain('без остановок')
    expect(text, 'отказ обязан пропускать шаг, а не валить весь план').toContain('пропусти шаг')
    expect(
      outcome.continuation!.agentMode,
      'понижение режима сломало бы правило «между шагами не переспрашиваем»',
    ).toBe('accept-edits')
  })

  it('approve без ответственных шагов: лишних инструкций нет', () => {
    const outcome = planDecisionOutsideRun('approve', undefined, base)
    expect(outcome.continuation!.text).not.toContain('остановись')
    expect(outcome.continuation!.agentMode).toBe('accept-edits')
  })

  it('пустой список ответственных шагов равен их отсутствию', () => {
    const outcome = planDecisionOutsideRun('approve', undefined, { ...base, responsibleSteps: [] })
    expect(outcome.continuation!.text).not.toContain('остановись')
  })

  it('решения «доработать» и «отклонить» пауза не касается', () => {
    const revise = planDecisionOutsideRun('revise', 'добавь проверку', { ...base, responsibleSteps: ['Отправить письма'] })
    expect(revise.continuation!.text).not.toContain('без остановок')
    expect(planDecisionOutsideRun('reject', undefined, { ...base, responsibleSteps: ['Отправить письма'] }).continuation).toBeNull()
  })
})
