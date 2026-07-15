// Срез 2.0.7-F: one-shot маршрут модели в projectStore. Проверяем: (1) set/clear;
// (2) НЕ течёт между чатами — switchChatSession сбрасывает override (иначе выбор для
// чата A применился бы в чате B — «два параллельных чата» из карточки).
import { describe, it, expect, beforeEach, vi } from 'vitest'

const baseWindow = {
  api: {
    chats: { append: vi.fn(async () => {}), list: vi.fn(async () => []) },
    agentRuns: { list: vi.fn(async () => []) },
    settings: { getKey: vi.fn(async () => null), setKey: vi.fn(async () => {}) },
    chatSessions: {
      list: vi.fn(async () => []),
      listReviews: vi.fn(async () => []),
      setModel: vi.fn(async () => {}),
      get: vi.fn(async () => ({ id: 5, providerId: null, model: null })),
      messages: vi.fn(async () => []),
    },
  },
}
vi.stubGlobal('window', baseWindow)

import { useProject } from '../../src/store/projectStore'
import type { PromptRouteOverride } from '../../src/types/api'

const ROUTE: PromptRouteOverride = { providerId: 'grok', model: 'grok-4.5', fallbackPolicy: 'strict' }

// tests/setup.ts afterEach(unstubAllGlobals) убивает module-level window → re-stub перед
// каждым тестом (граба project-store-routing/[[ilya-design-collab]]).
const flush = () => new Promise(r => setTimeout(r, 0))

describe('projectStore: one-shot promptRouteOverride', () => {
  beforeEach(() => {
    vi.stubGlobal('window', baseWindow)
    useProject.setState({ path: 'C:/proj', activeChatId: 1, promptRouteOverride: null, chatSessions: [] })
  })

  it('setPromptRouteOverride задаёт и снимает', () => {
    useProject.getState().setPromptRouteOverride(ROUTE)
    expect(useProject.getState().promptRouteOverride).toEqual(ROUTE)
    useProject.getState().setPromptRouteOverride(null)
    expect(useProject.getState().promptRouteOverride).toBeNull()
  })

  it('дефолт store — override отсутствует (не «липкий» между сессиями)', () => {
    expect(useProject.getState().promptRouteOverride).toBeNull()
  })

  it('switchChatSession сбрасывает override (не течёт в другой чат)', async () => {
    useProject.getState().setPromptRouteOverride(ROUTE)
    expect(useProject.getState().promptRouteOverride).toEqual(ROUTE)
    await useProject.getState().switchChatSession(2)
    expect(useProject.getState().promptRouteOverride, 'override должен обнулиться при переключении чата').toBeNull()
    await flush() // дать fire-and-forget IIFE (chats.list) завершиться ДО teardown window
  })
})
