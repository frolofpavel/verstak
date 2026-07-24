// @vitest-environment jsdom
//
// Решение Павла (24.07, отчёт dev-hq): матрица событий уведомлений — мёртвый UI.
// Исполнение (response-notify.ts) читает ТОЛЬКО master-toggle, режим, тихие часы и
// «Ответ готов» → звук/всплывашка (events['assistant'] с маппингом на legacy-ключи).
// Остальные 5 событий (error/reminder/queue/update/background) и канал «Проект»
// нигде не читаются → скрываем, чтобы UI не обещал нерабочее.
// Red-first: без правки Settings.tsx эти тесты красные (матрица показывает всё).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { Settings } = await import('../../src/components/Settings')

const SETTINGS_DEFAULTS = {
  ...CHAT_API_DEFAULTS,
  subscriptionAccounts: { list: async () => [] },
  cliAuth: { statusAll: async () => ({}) },
  localModels: { scan: async () => [] },
  usage: { summary: async () => null, list: async () => [] },
  userProfiles: { list: async () => [] },
}

let mock: ApiMock
beforeEach(() => {
  mock = makeApiMock(SETTINGS_DEFAULTS)
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

const mountNotify = () =>
  render(createElement(Settings, { onClose: vi.fn(), initialTab: 'notifications' }))

describe('Settings → Уведомления: только рабочие элементы (решение Павла 24.07)', () => {
  it('рабочее остаётся: master-toggle, режим, тихие часы, проверка, «Ответ готов»', async () => {
    mountNotify()
    await waitFor(() => expect(screen.getByText('Режим уведомлений')).toBeTruthy(), { timeout: 10000 })
    expect(screen.getByText('Проверить')).toBeTruthy()
    expect(screen.getByText('Тихие часы')).toBeTruthy()
    expect(screen.getByText('Ответ готов')).toBeTruthy()
    // рабочие каналы «Ответ готов»
    expect(screen.getAllByText('Всплывающее').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Звук').length).toBeGreaterThan(0)
  }, 15000)

  it('мёртвые события НЕ показываются (Очередь/Обновления/Фоновая работа)', async () => {
    mountNotify()
    await waitFor(() => expect(screen.getByText('Режим уведомлений')).toBeTruthy(), { timeout: 10000 })
    expect(screen.queryByText('Очередь')).toBeNull()
    expect(screen.queryByText('Обновления')).toBeNull()
    expect(screen.queryByText('Фоновая работа')).toBeNull()
    expect(screen.queryByText('Напоминание')).toBeNull()
  }, 15000)

  it('мёртвый канал «Проект» НЕ показывается', async () => {
    mountNotify()
    await waitFor(() => expect(screen.getByText('Режим уведомлений')).toBeTruthy(), { timeout: 10000 })
    expect(screen.queryByText('Проект')).toBeNull()
  }, 15000)
})
