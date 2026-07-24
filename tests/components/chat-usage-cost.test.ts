// @vitest-environment jsdom
//
// Фаза 2.2 (FIX-PLAN-2026-07-24): per-chat pill стоимости недосчитывал cache write у Claude.
// Цепочка была готова ВСЯ, кроме одного звена: диспетчер ai.onEvent (ветка 'usage')
// передавал в store inputAccounting, но НЕ cacheWriteTokens → estimateCost получал 0
// на месте записи кэша (у Claude cache_creation ~1.25× input цены) → pill занижал.
// Red-first: без проброса cacheWriteTokens в addUsage эти тесты красные.
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

function startRun(sendId: number, chatId: number) {
  act(() => {
    useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId, projectPath: '/p' })
    useProject.getState().setStreaming(true)
    useProject.getState().addMessage({ role: 'assistant', content: '' })
  })
}

beforeEach(() => {
  mock = makeApiMock(CHAT_API_DEFAULTS)
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7, messages: [], isStreaming: false,
    sendOwners: {}, chatSessions: [{ id: 7 }] as never, helpMode: false,
    sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
  }, false)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('usage-событие → sessionUsage (Фаза 2.2)', () => {
  it('cacheWriteTokens из usage-события накапливается в sessionUsage', () => {
    mountChat()
    startRun(201, 7)

    act(() => {
      mock.aiEvents.emit({
        id: 201,
        event: {
          type: 'usage',
          usage: {
            inputTokens: 1000, outputTokens: 200,
            cacheReadTokens: 0, cacheWriteTokens: 40000,
            inputAccounting: 'exclusive',
          },
        },
      })
    })

    const u = useProject.getState().sessionUsage
    expect(u.cacheWriteTokens).toBe(40000) // RED без проброса: 0
    expect(u.inputTokens).toBe(1000)
    expect(u.inputAccounting).toBe('exclusive')
  })

  it('deprecated-мост cacheCreationInputTokens тоже доезжает (старые эмиттеры)', () => {
    mountChat()
    startRun(202, 7)

    act(() => {
      mock.aiEvents.emit({
        id: 202,
        event: {
          type: 'usage',
          usage: {
            inputTokens: 500, outputTokens: 100,
            cachedInputTokens: 0, cacheCreationInputTokens: 25000,
            inputAccounting: 'exclusive',
          },
        },
      })
    })

    expect(useProject.getState().sessionUsage.cacheWriteTokens).toBe(25000)
  })

  it('повторные usage-события СУММИРУЮТ cache write (мульти-ходовой агент)', () => {
    mountChat()
    startRun(203, 7)

    act(() => {
      for (const w of [10000, 15000]) {
        mock.aiEvents.emit({
          id: 203,
          event: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cacheWriteTokens: w, inputAccounting: 'exclusive' } },
        })
      }
    })

    expect(useProject.getState().sessionUsage.cacheWriteTokens).toBe(25000)
  })
})
