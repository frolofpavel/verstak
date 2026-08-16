// @vitest-environment jsdom
//
// Цель 2.7.0, шаг 2 пункт 3: вход в инспектор суб-агентов перестаёт висеть в
// шапке чата постоянно. Признак, по которому решает продукт, а не человек:
// в этом чате реально шли суб-агенты (subagentRuns непуст).
//
// Возможность не теряется: история суб-сессий прошлых прогонов живёт в разделе
// «История работы» (AgentRunsPanel, detail.subs) и доступна всегда.
//
// Проверки синхронные — под jsdom асинхронное ожидание в смонтированном Chat
// вешает прогон без вывода (CLAUDE.md §3.1).
import { seedActive } from '../store/_active-bundle'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { emptySessionUsage } = await import('../../src/store/session-snapshot')
const { Chat } = await import('../../src/components/Chat')

let mock: ApiMock

function mountChat(rightPanel: string = 'none') {
  return render(createElement(Chat, {
    onOpenSettings: vi.fn(),
    rightPanel: rightPanel as never,
    onSelectRightPanel: vi.fn(),
    isSettingsOpen: false,
    onOpenSideChat: vi.fn(),
    onOpenFilePreview: vi.fn(),
  }))
}

const RUN = {
  callId: 'c1', label: 'analyst', task: 'разобрать логи',
  status: 'running' as const, role: 'analyst',
}

beforeEach(() => {
  mock = makeApiMock({ ...CHAT_API_DEFAULTS, commands: { list: async () => [] } })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7,
    sendOwners: {}, chatSessions: [{ id: 7 }] as never, helpMode: false,
  }, false)
  seedActive(useProject, { messages: [], isStreaming: false, sessionUsage: emptySessionUsage() })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('вход в инспектор суб-агентов — по факту, а не всегда', () => {
  it('суб-агентов в чате не было — кнопки «Агенты» в шапке нет', () => {
    mountChat()
    // Контроль: шапка чата отрисована и соседние кнопки на месте, значит пин
    // измеряет отсутствие ИМЕННО этой кнопки, а не отсутствие всей шапки.
    expect(document.querySelector('.gg-chat-project-actions')).toBeTruthy()
    expect(document.querySelector('.gg-terminal-bar-btn-sidechat')).toBeTruthy()
    expect(document.querySelector('.gg-terminal-bar-btn-agents')).toBeNull()
  })

  it('суб-агенты в чате шли — кнопка появляется сама', () => {
    seedActive(useProject, { subagentRuns: [RUN] })
    mountChat()
    expect(document.querySelector('.gg-terminal-bar-btn-agents')).toBeTruthy()
  })

  it('панель открыта — кнопка есть, иначе её нечем было бы закрыть', () => {
    mountChat('agents')
    expect(document.querySelector('.gg-terminal-bar-btn-agents')).toBeTruthy()
  })
})
