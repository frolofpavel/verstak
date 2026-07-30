// §2.3 A3 · карточка согласования переживает перезапуск.
//
// ЧТО БЫЛО СЛОМАНО. Карточка жила только в памяти renderer — её рождало живое
// событие прогона. Закрыл приложение посреди согласования → карточки нет, а план
// остался `draft` с удержанным чекпойнтом, и одобрить его НЕЧЕМ: кнопка была
// единственной дорогой к продолжению. При выключенном тумблере редкость; при
// включении по умолчанию (§2.1) стало бы массовым — поэтому восстановление идёт
// ПЕРЕД включением, а не после.
//
// ГЛАВНЫЙ ПИН ЗДЕСЬ — НЕ «карточка вернулась», А «карточка вернулась В СВОЙ
// ЧАТ». 28.07 чинили дефект 4 §10: карточка жила в одной глобальной ячейке,
// вторая затирала первую, и продолжение уезжало в чужой чат. Восстановление —
// ровно то место, где этот дефект вернулся бы незаметно, поэтому проверка идёт
// НА ДВУХ чатах: на одном она ничего не измеряет.
import { describe, it, expect } from 'vitest'
import { restorablePlanCards, restorablePlanCardsForChat, type RestorablePlan } from '../../electron/ai/plan-restore'

const plan = (over: Partial<RestorablePlan> = {}): RestorablePlan => ({
  id: 1,
  title: 'План',
  status: 'draft',
  chatId: 10,
  agentRunId: 'run-1',
  stepCount: 3,
  ...over,
})

/** Живы все чекпойнты, кроме перечисленных. */
const alive = (...dead: string[]) => (runId: string) => !dead.includes(runId)

describe('§2.3 · какие планы возвращают карточку', () => {
  it('draft + чат + прогон + живой чекпойнт → карточка восстановлена и продолжаема', () => {
    const [card] = restorablePlanCards([plan()], alive())

    expect(card, 'карточка не восстановлена — одобрить план нечем').toBeTruthy()
    expect(card).toMatchObject({ planId: 1, chatId: 10, stepCount: 3, resumable: true })
  })

  // Мёртвый чекпойнт: карточка нужна, кнопка продолжения — нет.
  it('чекпойнт вычищен → карточка есть, но НЕ продолжаема', () => {
    const [card] = restorablePlanCards([plan({ agentRunId: 'run-gone' })], alive('run-gone'))

    expect(card, 'план исчез с экрана вместе с чекпойнтом').toBeTruthy()
    expect(card.resumable, 'живая кнопка, которая ничего не сделает — хуже честного отказа').toBe(false)
  })

  it('решение уже принято (running/done/cancelled) → карточки нет', () => {
    for (const status of ['running', 'done', 'cancelled']) {
      expect(restorablePlanCards([plan({ status })], alive()), status).toEqual([])
    }
  })

  it('план без прогона продолжать нечем — карточки нет', () => {
    expect(restorablePlanCards([plan({ agentRunId: null })], alive())).toEqual([])
  })

  it('план без чата возвращать некуда — карточки нет', () => {
    expect(restorablePlanCards([plan({ chatId: null })], alive())).toEqual([])
  })
})

// ЗАЩИТА ОТ ВОЗВРАТА ДЕФЕКТА 4 §10 (чинен 28.07). Проверяется на ДВУХ чатах:
// на одном пин был бы зелёным и у реализации с единственной глобальной ячейкой.
describe('§2.3 · карточка принадлежит СВОЕМУ чату, а не глобальной ячейке', () => {
  const two = [
    plan({ id: 1, chatId: 10, agentRunId: 'run-a', title: 'План чата A' }),
    plan({ id: 2, chatId: 20, agentRunId: 'run-b', title: 'План чата B' }),
  ]

  it('две карточки в разных чатах сосуществуют — вторая не затирает первую', () => {
    const cards = restorablePlanCards(two, alive())

    expect(cards).toHaveLength(2)
    expect(cards.map(c => c.chatId).sort()).toEqual([10, 20])
    expect(cards.find(c => c.chatId === 10)?.planId).toBe(1)
    expect(cards.find(c => c.chatId === 20)?.planId).toBe(2)
  })

  it('выборка для чата отдаёт ТОЛЬКО его карточку — продолжение не уедет в чужой чат', () => {
    const forA = restorablePlanCardsForChat(two, alive(), 10)
    const forB = restorablePlanCardsForChat(two, alive(), 20)

    expect(forA.map(c => c.planId), 'в чат A попала чужая карточка').toEqual([1])
    expect(forB.map(c => c.planId), 'в чат B попала чужая карточка').toEqual([2])
  })

  it('чат без своего плана не получает чужую карточку', () => {
    expect(restorablePlanCardsForChat(two, alive(), 30)).toEqual([])
  })

  // КОНТРОЛЬ: разделение по чатам не должно съедать карточки вовсе.
  it('контроль: у каждого из двух чатов карточка есть', () => {
    expect(restorablePlanCardsForChat(two, alive(), 10)).toHaveLength(1)
    expect(restorablePlanCardsForChat(two, alive(), 20)).toHaveLength(1)
  })

  it('мёртвый чекпойнт одного чата не делает непродолжаемым план другого', () => {
    const cards = restorablePlanCards(two, alive('run-a'))

    expect(cards.find(c => c.chatId === 10)?.resumable).toBe(false)
    expect(cards.find(c => c.chatId === 20)?.resumable, 'чужой мёртвый чекпойнт погасил живой план').toBe(true)
  })
})
