// @vitest-environment jsdom
//
// Хвост §10, дефект 4: карточка согласования жила в ОДНОЙ глобальной ячейке.
//
// ДЕФЕКТ. `pendingPlan` был top-level полем стора. Второй план молча затирал
// первый: человек терял карточку, о которой ещё не принял решения, а её план
// оставался в draft с удержанным чекпойнтом. Хуже того, продолжение после
// решения уходило в АКТИВНЫЙ чат — то есть могло приехать в переписку, к
// которой план отношения не имеет.
//
// ЧТО ЗАКРЕПЛЕНО. Карточка — состояние чата и живёт в его bundle (PerChatState
// 4.4: состояние чата хранится ТОЛЬКО в `chats`). Две карточки в разных чатах
// сосуществуют; модалка показывает карточку АКТИВНОГО чата, поэтому решение и
// продолжение всегда остаются в своём чате.
import { seedActive } from '../store/_active-bundle'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { Chat } = await import('../../src/components/Chat')
const { PlanConfirm } = await import('../../src/components/PlanConfirm')

let mock: ApiMock

function mountChat() {
  return render(createElement(Chat, {
    onOpenSettings: vi.fn(),
    rightPanel: null as never,
    onSelectRightPanel: vi.fn(),
    isSettingsOpen: false,
    onOpenSideChat: vi.fn(),
    onOpenFilePreview: vi.fn(),
  }))
}

function startRun(sendId: number, chatId: number, projectPath = '/p') {
  act(() => {
    useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId, projectPath })
  })
}

function showCard(sendId: number, planId: number, title: string) {
  act(() => {
    mock.aiEvents.emit({
      id: sendId,
      event: { type: 'plan-approval', callId: `c${planId}`, planId, title, stepCount: 2 },
    })
  })
}

const cardOf = (chatId: number) => useProject.getState().chats[chatId]?.pendingPlan ?? null

beforeEach(() => {
  mock = makeApiMock(CHAT_API_DEFAULTS)
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7, chats: {},
    sendOwners: {}, chatSessions: [{ id: 7 }, { id: 9 }] as never, helpMode: false,
  }, false)
  seedActive(useProject, { messages: [], isStreaming: false }, 7)
  seedActive(useProject, { messages: [], isStreaming: false }, 9)
  useProject.setState({ activeChatId: 7 }, false)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('§10 хвост: карточка согласования принадлежит своему чату', () => {
  it('две карточки в разных чатах не затирают друг друга', () => {
    mountChat()
    startRun(101, 7)
    startRun(202, 9)
    showCard(101, 42, 'Лендинг')
    showCard(202, 77, 'Отчёт')

    expect(cardOf(7)?.planId, 'первую карточку затёрла вторая').toBe(42)
    expect(cardOf(9)?.planId).toBe(77)
  })

  it('карточка фонового чата не показывается вместо карточки активного', () => {
    mountChat()
    startRun(202, 9)
    showCard(202, 77, 'Отчёт')

    expect(cardOf(9)?.planId).toBe(77)
    expect(cardOf(7), 'чужая карточка приехала в активный чат').toBeNull()
  })

  it('модалка показывает план АКТИВНОГО чата — решение остаётся в своём чате', () => {
    mountChat()
    startRun(101, 7)
    startRun(202, 9)
    showCard(101, 42, 'Лендинг')
    showCard(202, 77, 'Отчёт')

    const { container } = render(createElement(PlanConfirm))
    expect(container.textContent).toContain('Лендинг')
    expect(container.textContent, 'показан план чужого чата').not.toContain('Отчёт')
  })
})
