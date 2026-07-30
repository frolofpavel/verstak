// §2.3 A3 · сторона renderer: восстановленная карточка ложится в СВОЙ чат.
//
// Сквозной пин на IPC (tests/ipc/plan-card-restore-ipc.test.ts) доказывает, что
// карточки доезжают из БД. Здесь доказывается вторая половина: они попадают
// туда, где человек их увидит, и НЕ смешиваются между чатами.
//
// Это то самое место, где дефект 4 §10 (чинен 28.07) вернулся бы незаметно:
// карточка жила в одной глобальной ячейке, вторая затирала первую, и
// продолжение уезжало в чужой чат. Поэтому проверка на ДВУХ чатах — на одном
// пин был бы зелёным и у реализации с общей ячейкой.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const pendingCards = vi.fn(async () => [] as Array<{ planId: number; chatId: number; title: string; stepCount: number; resumable: boolean }>)
const windowStub = {
  api: {
    plans: { pendingCards },
    chats: { listWindow: vi.fn(async () => ({ messages: [], totalCount: 0, hasMoreBefore: false })), append: vi.fn(async () => {}) },
    agentRuns: { list: vi.fn(async () => []) },
  },
}
vi.stubGlobal('window', windowStub)

const { useProject } = await import('../../src/store/projectStore')
const { freshSnapshot } = await import('../../src/store/session-snapshot')

const PROJECT = 'C:/proj'

beforeEach(() => {
  vi.stubGlobal('window', windowStub)
  pendingCards.mockReset()
  pendingCards.mockResolvedValue([])
  useProject.setState({
    path: PROJECT,
    activeChatId: 10,
    chats: {
      10: { ...freshSnapshot(), chatId: 10 },
      20: { ...freshSnapshot(), chatId: 20 },
    },
  }, false)
})

const card = (planId: number, chatId: number, resumable = true) => ({
  planId, chatId, title: `План ${planId}`, stepCount: 3, resumable,
})

describe('§2.3 renderer · карточка возвращается в свой чат', () => {
  it('восстановленная карточка появляется в bundle своего чата', async () => {
    pendingCards.mockResolvedValue([card(1, 10)])

    await useProject.getState().restorePlanCards(PROJECT)

    const p = useProject.getState().chats[10].pendingPlan
    expect(p, 'карточка не вернулась — одобрить план нечем').toBeTruthy()
    expect(p).toMatchObject({ planId: 1, stepCount: 3, resumable: true })
  })

  // ЗАЩИТА ОТ ДЕФЕКТА 4 §10 — на двух чатах, иначе пин не измеряет.
  it('две карточки в разных чатах: каждая в своём, ни одна не затёрта', async () => {
    pendingCards.mockResolvedValue([card(1, 10), card(2, 20)])

    await useProject.getState().restorePlanCards(PROJECT)

    const s = useProject.getState()
    expect(s.chats[10].pendingPlan?.planId, 'в чат 10 попала чужая карточка').toBe(1)
    expect(s.chats[20].pendingPlan?.planId, 'карточка второго чата затёрла первую').toBe(2)
  })

  it('непродолжаемая карточка помечена — кнопкам согласования взяться неоткуда', async () => {
    pendingCards.mockResolvedValue([card(1, 10, false)])

    await useProject.getState().restorePlanCards(PROJECT)

    expect(useProject.getState().chats[10].pendingPlan?.resumable).toBe(false)
  })

  // КОНТРОЛЬ: живая карточка важнее восстановленной — иначе восстановление
  // затирало бы то, что человек прямо сейчас видит.
  it('контроль: живая карточка чата не подменяется восстановленной', async () => {
    useProject.getState().setChatPendingPlan(10, { callId: 'live', planId: 99, title: 'Живой', stepCount: 1 })
    pendingCards.mockResolvedValue([card(1, 10)])

    await useProject.getState().restorePlanCards(PROJECT)

    expect(useProject.getState().chats[10].pendingPlan?.planId, 'восстановление затёрло живую карточку').toBe(99)
  })

  // КОНТРОЛЬ: смена проекта во время загрузки не должна раскладывать чужие карточки.
  it('контроль: ответ для другого проекта игнорируется', async () => {
    pendingCards.mockImplementation(async () => {
      useProject.setState({ path: 'C:/other' }, false)
      return [card(1, 10)]
    })

    await useProject.getState().restorePlanCards(PROJECT)

    expect(useProject.getState().chats[10].pendingPlan, 'карточка легла в чат чужого проекта').toBeNull()
  })

  it('контроль: пустой ответ ничего не ломает', async () => {
    pendingCards.mockResolvedValue([])
    await useProject.getState().restorePlanCards(PROJECT)
    expect(useProject.getState().chats[10].pendingPlan).toBeNull()
  })
})
