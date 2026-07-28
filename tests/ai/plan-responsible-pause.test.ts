// ВНИМАНИЕ, ГРАНИЦА (ревью 28.07): этот файл закрепляет ТЕКСТ продолжения, а НЕ
// паузу. Паузы перед ответственным действием в продукте НЕТ: текст обходится
// режимами auto/bypass, allow-правилом permissions, тумблером авто-подтверждения
// команд и обычным write_file в accept-edits; на пайплайн-оси вычисление
// ответственных шагов вообще мёртвый код (PlanConfirm выбрасывает continuation),
// а статус шага skipped не ставит ни одна строка кода. Настоящая пауза требует
// рантайм-гейта и НЕ построена — см. аудит, раздел ревью 28.07. Не принимать
// зелень этого файла за доказательство паузы.
//
// Что здесь действительно проверено: продолжение НАЗЫВАЕТ ответственные шаги и
// не понижает режим (понижение до ask сломало бы «между шагами не
// останавливаемся»).
//
// Режим продолжения остаётся `accept-edits` сознательно: понизь его до `ask` — и
// переспрашивать начнёт КАЖДАЯ правка, то есть сломается правило 1. Кто именно
// ответственный, решает тот же порог §4.2, что решал про карточку, — второй
// список слов не заводится.
import { describe, it, expect } from 'vitest'
import { planDecisionOutsideRun } from '../../electron/ai/plan-await'

const base = { id: 7, title: 'Рассылка по клиентам', agentRunId: 'run-1' }

describe('текст продолжения называет ответственные шаги (паузы в продукте НЕТ)', () => {
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
