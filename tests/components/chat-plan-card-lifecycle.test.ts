// @vitest-environment jsdom
//
// Регрессия §10: карточка согласования не должна исчезать вместе с прогоном.
//
// ДЕФЕКТ. До §10 ожидание жило ВНУТРИ прогона, поэтому `done`/`error` по тому же
// sendId означали одно: гейт сдренен в main как reject, карточка стала ghost'ом —
// и renderer её снимал. После §10 всё наоборот: прогон завершается штатно СРАЗУ
// после показа карточки, `done` приходит через секунды, и та же строка снимала
// карточку ДО решения человека. Кнопка «Одобрить» становилась недостижимой:
// продолжение по чекпойнту, ради которого §10 и делалась, запустить было нечем.
//
// Дефект нашёлся при разведке под §5 и к §5 не относится — это недоделка §10.
//
// Жизненный цикл карточки в renderer до этого файла не был покрыт ничем, поэтому
// ловить дефект было нечем. Сетка закрывает оба места снятия: основной путь и
// путь фонового чата на другом проекте (карточка показывается глобально, а
// `done` приходил в другую ветку дисперчера).
import { seedActive } from '../store/_active-bundle'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { Chat } = await import('../../src/components/Chat')

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

/** Прогон в чате: owner регистрируется так же, как это делает send(). */
function startRun(sendId: number, chatId: number, projectPath = '/p') {
  act(() => {
    useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId, projectPath })
    useProject.getState().setStreaming(true)
  })
}

function showCard(sendId: number, planId = 42) {
  act(() => {
    mock.aiEvents.emit({
      id: sendId,
      event: { type: 'plan-approval', callId: 'c1', planId, title: 'Лендинг', stepCount: 3 },
    })
  })
}

// §10 хвост (дефект 4): карточка переехала в bundle своего чата — читаем её
// оттуда. Утверждения файла не изменились: смотрим на ту же карточку того же
// прогона, просто через её новое (и единственное) хранилище.
const card = (chatId = 7) => useProject.getState().chats[chatId]?.pendingPlan ?? null

beforeEach(() => {
  mock = makeApiMock(CHAT_API_DEFAULTS)
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7,
    sendOwners: {}, chatSessions: [{ id: 7 }, { id: 9 }] as never, helpMode: false,
  }, false)
  seedActive(useProject, { messages: [], isStreaming: false })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('карточка согласования переживает завершение своего прогона', () => {
  it('plan-approval поднимает карточку', () => {
    mountChat()
    startRun(101, 7)
    showCard(101)
    expect(card()?.planId).toBe(42)
    expect(card()?.sendId).toBe(101)
  })

  // ГЛАВНЫЙ ПИН. Под §10 done — нормальное состояние ожидания, а не признак ghost'а.
  it('done по тому же прогону НЕ снимает карточку — человек ещё не решил', () => {
    mountChat()
    startRun(101, 7)
    showCard(101)
    act(() => { mock.aiEvents.emit({ id: 101, event: { type: 'done' } }) })
    expect(card(), 'карточка исчезла до решения человека — approve стал недостижим').not.toBeNull()
    expect(card()?.planId).toBe(42)
  })

  it('error по тому же прогону тоже не снимает карточку', () => {
    mountChat()
    startRun(102, 7)
    showCard(102)
    act(() => { mock.aiEvents.emit({ id: 102, event: { type: 'error', message: 'сеть' } }) })
    expect(card()).not.toBeNull()
  })

  // Второе место снятия: карточка фонового чата на другом проекте — его `done`
  // уходил в отдельную ветку дисперчера, где стояло своё снятие. После §10-хвоста
  // карточка лежит в bundle СВОЕГО чата (дефект 4), поэтому и читаем её оттуда;
  // проверяемое поведение прежнее — чужое завершение её не трогает.
  it('фоновый чат на другом проекте: done не снимает его карточку', () => {
    mountChat()
    startRun(203, 9, '/other')
    showCard(203, 77)
    expect(card(9)?.planId).toBe(77)
    act(() => { mock.aiEvents.emit({ id: 203, event: { type: 'done' } }) })
    expect(card(9), 'карточка фонового плана снята чужим завершением').not.toBeNull()
  })

  // Снимает карточку только решение человека — это делает PlanConfirm.
  it('чужой прогон карточку не трогает', () => {
    mountChat()
    startRun(101, 7)
    showCard(101)
    startRun(555, 7)
    act(() => { mock.aiEvents.emit({ id: 555, event: { type: 'done' } }) })
    expect(card()?.sendId).toBe(101)
  })

  it('setPendingPlan(null) — единственный способ убрать карточку', () => {
    mountChat()
    startRun(101, 7)
    showCard(101)
    act(() => { useProject.getState().setPendingPlan(null) })
    expect(card()).toBeNull()
  })
})
