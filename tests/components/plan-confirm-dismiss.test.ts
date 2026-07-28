// @vitest-environment jsdom
//
// Хвост §10, дефект 3: промах мышью был необратим.
//
// ДЕФЕКТ. Клик по фону модалки согласования трактовался как `reject`, а reject —
// это `cancelled` + удаление чекпойнта прогона (`releaseCheckpoint`). То есть
// один промах мимо окна убивал продолжение навсегда: вернуться к плану было уже
// нельзя, история прогона удалена.
//
// ЧТО ЗАКРЕПЛЕНО. Отказ — только явная кнопка. Фон решения не принимает.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'

const { useProject } = await import('../../src/store/projectStore')
const { PlanConfirm } = await import('../../src/components/PlanConfirm')

const resolveApproval = vi.fn(async () => ({ planStatus: 'cancelled' as const, continuation: null }))
const getPlan = vi.fn(async () => ({
  id: 42, title: 'Лендинг', status: 'draft', createdAt: 0, completedAt: null,
  contractRevision: null, planRevision: 1, quality: null, chatId: 7,
  sourceMessageId: null, agentRunId: 'run-1', steps: [],
}))

function mount() {
  return render(createElement(PlanConfirm))
}

const card = () => useProject.getState().chats[7]?.pendingPlan ?? null

beforeEach(() => {
  resolveApproval.mockClear()
  vi.stubGlobal('window', Object.assign(globalThis.window, {
    api: { plans: { get: getPlan, resolveApproval } },
  }))
  useProject.setState({ path: '/p', activeChatId: 7, activePipeline: null }, false)
  useProject.getState().setPendingPlan({ callId: 'c1', planId: 42, title: 'Лендинг', stepCount: 3, sendId: 101 })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('§10 хвост: карточку согласования нельзя отклонить промахом', () => {
  it('клик по фону НЕ принимает решение и не убирает карточку', async () => {
    const { container } = mount()
    const backdrop = container.querySelector('.gg-modal-backdrop')!
    await act(async () => { backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(resolveApproval, 'фон отправлял reject — план отменялся и чекпойнт удалялся').not.toHaveBeenCalled()
    expect(card(), 'карточка исчезла от промаха мышью').not.toBeNull()
  })

  it('кнопка «Отклонить» решение принимает — отказ остался достижим', async () => {
    const { container } = mount()
    const reject = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Отклонить')!
    await act(async () => { reject.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(resolveApproval).toHaveBeenCalledWith(42, 'reject', undefined)
    expect(card()).toBeNull()
  })
})
