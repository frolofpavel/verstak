// @vitest-environment jsdom
//
// Хвост 2.0.8-D2 (срез 2.0.10): закрепление аккаунта за чатом получает интерфейс.
// В notes 2.0.8 было обещано «кнопка появится в следующем релизе» — здесь проверяем,
// что она реально работает в живом компоненте, а не только компилируется.
//
// Логика показа покрыта отдельно (tests/lib/chat-account-binding.test.ts + страж от дрейфа
// с движком). Тут — проводка: читает биндинг, пишет биндинг, показывает правду.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { ModelPicker } = await import('../../src/components/ModelPicker')

const ACCOUNTS = [
  { id: 1, providerId: 'claude', label: 'Рабочий Max', authMode: 'token', state: 'ready', active: true, lastUsedAt: null, hasCredential: true },
  { id: 2, providerId: 'claude', label: 'Личный Max', authMode: 'token', state: 'cooling', active: false, lastUsedAt: null, hasCredential: true },
  { id: 3, providerId: 'claude', label: 'Сломанный', authMode: 'token', state: 'login-required', active: false, lastUsedAt: null, hasCredential: true },
]

let mock: ApiMock
let setBindingCalls: unknown[]
let currentBinding: unknown = null

function mountPicker() {
  return render(createElement(ModelPicker, { onOpenSettings: vi.fn() }))
}
const openMenu = async () => {
  const btn = document.querySelector('.gg-mp-trigger, button')!
  fireEvent.click(btn)
  await waitFor(() => expect(document.querySelector('.gg-mp-popover')).toBeTruthy())
}

beforeEach(() => {
  setBindingCalls = []
  currentBinding = null
  mock = makeApiMock({
    ...CHAT_API_DEFAULTS,
    providers: { list: async () => [{ id: 'claude', name: 'Claude', shortLabel: 'Claude', transport: 'API', supportsTools: true, models: ['claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-6', secretKey: 'claude_key' }] },
    settings: { getKey: async (k: string) => (k === 'provider' ? 'claude' : k === 'claude_key' ? 'sk-test' : k === 'model_claude' ? 'claude-sonnet-4-6' : null) },
    subscriptionAccounts: { list: async () => ACCOUNTS },
    chats: {
      getSubscriptionBinding: async () => currentBinding,
      setSubscriptionBinding: async (b: unknown) => { setBindingCalls.push(b); currentBinding = b; return { ok: true } },
    },
    cliAuth: { statusAll: async () => ({}) },
    localModels: { scan: async () => [] },
  })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({ activeChatId: 7, path: '/p' }, false)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('ModelPicker: закрепление аккаунта за чатом (хвост D2)', () => {
  it('показывает аккаунты подписки с человеческими статусами', async () => {
    mountPicker()
    await openMenu()
    await waitFor(() => expect(screen.getByText('Аккаунт подписки')).toBeTruthy())
    expect(screen.getByText('Рабочий Max')).toBeTruthy()
    expect(screen.getByText('остывает')).toBeTruthy()   // не 'cooling'
    expect(screen.getByText('нужен вход')).toBeTruthy() // не 'login-required'
  })

  it('клик по аккаунту ЗАКРЕПЛЯЕТ чат за ним (пишется биндинг)', async () => {
    mountPicker()
    await openMenu()
    await waitFor(() => expect(screen.getByText('Рабочий Max')).toBeTruthy())
    fireEvent.click(screen.getByText('Рабочий Max'))
    await waitFor(() => expect(setBindingCalls).toHaveLength(1))
    expect(setBindingCalls[0]).toEqual({ chatId: 7, providerId: 'claude', mode: 'pinned', accountId: 1 })
  })

  it('«Автоматически» СНИМАЕТ закрепление (accountId обнуляется)', async () => {
    currentBinding = { chatId: 7, providerId: 'claude', mode: 'pinned', accountId: 1 }
    mountPicker()
    await openMenu()
    await waitFor(() => expect(screen.getByText('Автоматически')).toBeTruthy())
    fireEvent.click(screen.getByText('Автоматически'))
    await waitFor(() => expect(setBindingCalls).toHaveLength(1))
    expect(setBindingCalls[0]).toEqual({ chatId: 7, providerId: 'claude', mode: 'auto', accountId: null })
  })

  it('сломанный аккаунт закрепить НЕЛЬЗЯ (закрепление гарантировало бы стоп прогонов)', async () => {
    mountPicker()
    await openMenu()
    await waitFor(() => expect(screen.getByText('Сломанный')).toBeTruthy())
    const row = screen.getByText('Сломанный').closest('button')!
    expect(row.disabled).toBe(true)
  })

  // ГЛАВНОЕ: UI обязан сказать то же, что сделает движок. route-policy на удалённый
  // закреплённый аккаунт возвращает 'unavailable' и ОСТАНАВЛИВАЕТ прогон вопросом.
  it('закреплён за УДАЛЁННЫМ аккаунтом → честное предупреждение, а не тишина', async () => {
    currentBinding = { chatId: 7, providerId: 'claude', mode: 'pinned', accountId: 999 }
    mountPicker()
    await openMenu()
    await waitFor(() => expect(screen.getByText(/Закреплённый аккаунт удалён/)).toBeTruthy())
    expect(screen.getByText(/Чат не будет отвечать/)).toBeTruthy()
  })

  it('нет аккаунтов подписки → секции нет (не шумим там, где закреплять нечего)', async () => {
    mock = makeApiMock({
      ...CHAT_API_DEFAULTS,
      providers: { list: async () => [{ id: 'claude', name: 'Claude', shortLabel: 'Claude', transport: 'API', supportsTools: true, models: ['claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-6', secretKey: 'claude_key' }] },
      settings: { getKey: async (k: string) => (k === 'provider' ? 'claude' : k === 'claude_key' ? 'sk-test' : null) },
      subscriptionAccounts: { list: async () => [] },
      chats: { getSubscriptionBinding: async () => null, setSubscriptionBinding: async () => ({ ok: true }) },
      cliAuth: { statusAll: async () => ({}) },
      localModels: { scan: async () => [] },
    })
    vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
    mountPicker()
    await openMenu()
    expect(screen.queryByText('Аккаунт подписки')).toBeNull()
  })
})
