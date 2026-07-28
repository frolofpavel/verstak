// Хвост §10, дефект 5 (сторона интерфейса): карточку убирают не только кнопкой.
//
// ДЕФЕКТ. Stop, Shift+Esc и закрытие проекта снимали карточку согласования и на
// этом останавливались: в БД оставался чекпойнт прогона, удержанный ради
// продолжения, которого уже не будет. Освобождал его ровно один путь —
// `plans:resolve-approval`, то есть нажатие кнопки в модалке.
//
// ЧТО ЗАКРЕПЛЕНО. Снятие карточки без решения освобождает чекпойнт (через
// `plans:release-approval`), при этом СТАТУС плана не выдумывается: решения не
// было, план остаётся в «Планах» как есть.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const releaseApproval = vi.fn(async (_planId: number) => {})
const windowStub = {
  api: {
    plans: { releaseApproval },
    chats: { listWindow: vi.fn(async () => ({ messages: [], totalCount: 0, hasMoreBefore: false })) },
    settings: { setKey: vi.fn(async () => {}), getKey: vi.fn(async () => null) },
  },
}
vi.stubGlobal('window', windowStub)

const { useProject } = await import('../../src/store/projectStore')
const { freshSnapshot } = await import('../../src/store/session-snapshot')

const card = (planId: number) => ({ callId: `c${planId}`, planId, title: `План ${planId}`, stepCount: 2, sendId: planId })

function seedCards() {
  useProject.setState({
    path: '/p', activeChatId: 7,
    chats: {
      7: { ...freshSnapshot(), chatId: 7, pendingPlan: card(42) },
      9: { ...freshSnapshot(), chatId: 9, pendingPlan: card(77) },
    },
  }, false)
}

beforeEach(() => {
  // vitest-конфиг проекта восстанавливает глобалы между кейсами — стаб ставим
  // заново, иначе стор второго теста уходит в окружение без window.
  vi.stubGlobal('window', windowStub)
  releaseApproval.mockClear()
  seedCards()
})

describe('§10 хвост: снятие карточки без решения освобождает чекпойнт', () => {
  it('dismissPendingPlan освобождает чекпойнт своего плана и убирает карточку', () => {
    useProject.getState().dismissPendingPlan(7)

    expect(releaseApproval).toHaveBeenCalledWith(42)
    expect(useProject.getState().chats[7].pendingPlan).toBeNull()
    expect(useProject.getState().chats[9].pendingPlan?.planId, 'сосед не пострадал').toBe(77)
  })

  it('закрытие проекта освобождает чекпойнты ВСЕХ висящих карточек', () => {
    useProject.getState().closeProject()

    expect(releaseApproval.mock.calls.map(c => c[0]).sort()).toEqual([42, 77])
    expect(useProject.getState().chats).toEqual({})
  })

  it('Stop снимает карточку ИМЕННО своего прогона, соседнюю не трогает', () => {
    useProject.getState().dismissPendingPlanForSend(42)
    expect(releaseApproval).toHaveBeenCalledTimes(1)
    expect(releaseApproval).toHaveBeenCalledWith(42)
    expect(useProject.getState().chats[9].pendingPlan?.planId).toBe(77)
  })

  it('карточки нет — освобождать нечего, лишнего вызова не делаем', () => {
    useProject.setState({ chats: { 7: { ...freshSnapshot(), chatId: 7 } } }, false)
    useProject.getState().dismissPendingPlan(7)
    expect(releaseApproval).not.toHaveBeenCalled()
  })
})

// Stop живёт в Chat.tsx, а его send()/stop() под jsdom не доводятся до конца
// (граница characterization чата). Поэтому два оставшихся выхода стережём на
// исходнике: мутация «вернуть setPendingPlan(null)» даёт красный.
describe('§10 хвост: выходы Stop и Shift+Esc идут через освобождение', () => {
  it('Stop в Chat.tsx снимает карточку через dismissPendingPlanForSend', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/Chat.tsx'), 'utf8')
    expect(source).toContain('dismissPendingPlanForSend(id)')
    expect(source, 'голое снятие карточки оставляло чекпойнт в БД навсегда')
      .not.toContain('cur.setPendingPlan(null)')
  })

  it('Shift+Esc в App.tsx снимает карточки через dismissAllPendingPlans', () => {
    const source = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')
    expect(source).toContain('dismissAllPendingPlans()')
    expect(source).not.toContain('setPendingPlan(null)')
  })
})
