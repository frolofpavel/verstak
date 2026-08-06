// @vitest-environment jsdom
//
// Задача 10 (оркестратор), ФРОНТ: карточка-след дочерней сессии в диспетчере
// ai.onEvent (ХРУПКАЯ ЗОНА §3.1) + её рендер и клик в родителе.
//
// Проверяется на СМОНТИРОВАННОМ Chat — то есть на реальной подписке, которая
// ставится один раз за жизнь экрана. Обработка 'spawn-task-session' добавлена
// ранней веткой с return (как plan-approval/materials-read); статус карточки
// вешается и на done/error, и — НЕСУЩЕЕ — на run-finalized (смерть mid-stream).
import { seedActive } from '../store/_active-bundle'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
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

beforeEach(() => {
  mock = makeApiMock({
    ...CHAT_API_DEFAULTS,
    chatSessions: {
      ...CHAT_API_DEFAULTS.chatSessions,
      create: async (_p: string, opts: { title?: string }) => ({ id: 42, title: opts.title ?? 'child', parentChatId: 7, kind: 'main' }),
    },
    ai: { sendWithOverrides: async () => 500 },
  })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7,
    sendOwners: {}, chatSessions: [{ id: 7 }] as never, helpMode: false,
  }, false)
  seedActive(useProject, { messages: [], isStreaming: false }, 7)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('оркестратор: диспетчер spawn-task-session (хрупкая зона)', () => {
  it('подписка ставится ровно один раз — новые ветки её не пересоздали', () => {
    mountChat()
    expect(mock.aiEvents.subscribeCount).toBe(1)
    expect(mock.aiEvents.handlers).toHaveLength(1)
  })

  it('spawn-task-session родительского прогона → spawnChildSession(parentChatId=owner, title, seed)', () => {
    mountChat()
    const spy = vi.fn(async () => 42)
    useProject.setState({ spawnChildSession: spy as never }, false)
    // Owner события — родительский прогон (чат 7).
    act(() => { useProject.getState().registerSendOwner(300, { kind: 'chat', chatId: 7, projectPath: '/p' }) })
    act(() => {
      mock.aiEvents.emit({ id: 300, event: { type: 'spawn-task-session', callId: 'c1', title: 'Аудит', seed: 'сделай аудит' } })
    })
    expect(spy).toHaveBeenCalledWith({ parentChatId: 7, title: 'Аудит', seed: 'сделай аудит' })
    expect(mock.aiEvents.lostEvents).toBe(0)
  })

  it('done дочернего прогона → карточка-след «готово»', () => {
    mountChat()
    // Карточка-след в родителе (7), child = 42, его прогон = sendId 500.
    seedActive(useProject, {
      messages: [{ role: 'assistant', content: 'ответ' }],
      spawnCards: [{ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 }],
    }, 7)
    act(() => { useProject.getState().registerSendOwner(500, { kind: 'chat', chatId: 42, projectPath: '/p' }) })
    act(() => { mock.aiEvents.emit({ id: 500, event: { type: 'done' } }) })
    expect(useProject.getState().chats[7].spawnCards[0].status).toBe('done')
  })

  it('НЕСУЩЕЕ: run-finalized оборвавшегося ребёнка → «оборвался», карточка не застряла', () => {
    mountChat()
    seedActive(useProject, {
      messages: [{ role: 'assistant', content: 'ответ' }],
      spawnCards: [{ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 }],
    }, 7)
    // Ребёнок умер mid-stream: ни done, ни error. Приходит только run-finalized (id=sendId).
    act(() => { mock.aiEvents.emit({ id: 500, event: { type: 'run-finalized', runId: 'rZ', projectPath: '/p' } as never }) })
    expect(useProject.getState().chats[7].spawnCards[0].status).toBe('terminated')
  })

  it('КОНТРОЛЬ: без сигнала финализации та же карточка ОСТАЁТСЯ «выполняется»', () => {
    mountChat()
    seedActive(useProject, {
      messages: [{ role: 'assistant', content: 'ответ' }],
      spawnCards: [{ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 }],
    }, 7)
    // Никаких событий не эмитим — карточка сама себя не двигает.
    expect(useProject.getState().chats[7].spawnCards[0].status).toBe('running')
  })
})

describe('оркестратор: рендер карточки-следа и клик', () => {
  it('карточка рендерится в родителе, клик открывает дочернюю сессию', () => {
    seedActive(useProject, {
      messages: [{ role: 'assistant', content: 'ответ' }],
      spawnCards: [{ childChatId: 42, title: 'Аудит сайта', status: 'running', sendId: 500 }],
    }, 7)
    const switchSpy = vi.fn(async () => {})
    useProject.setState({ switchChatSession: switchSpy as never }, false)
    const { container } = mountChat()
    // Карточка видна в потоке родителя.
    expect(container.textContent).toContain('Аудит сайта')
    const btn = container.querySelector('.gg-spawn-card-open') as HTMLButtonElement | null
    expect(btn).toBeTruthy()
    act(() => { fireEvent.click(btn!) })
    expect(switchSpy).toHaveBeenCalledWith(42)
  })
})
