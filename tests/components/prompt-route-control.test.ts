// @vitest-environment jsdom
//
// 2.1.3-CD: маршрут на один запрос учится выбирать КОНКРЕТНЫЙ аккаунт подписки.
//
// Карточка: «На один запрос» = provider + model + account только для следующего
// сообщения. Аккаунтный one-shot всегда строгий (policy-toggle бессмысленен и вреден:
// smart-fallback молча увёз бы запрос с осознанно выбранного аккаунта — main его и так
// выключит, так что честно не показывать переключатель вовсе).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { PromptRouteControl } = await import('../../src/components/chat/PromptRouteControl')

const PROVIDERS = [
  { id: 'claude-cli', name: 'Claude CLI', shortLabel: 'Claude', transport: 'CLI', supportsTools: false, models: ['auto'], defaultModel: 'auto', secretKey: null },
  { id: 'grok', name: 'Grok', shortLabel: 'Grok', transport: 'API', supportsTools: true, models: ['grok-4.5'], defaultModel: 'grok-4.5', secretKey: 'grok_key' },
]

const ACCOUNTS = [
  { id: 1, providerId: 'claude-cli', label: 'Рабочий Max', authMode: 'token', state: 'ready', active: true, lastUsedAt: null, hasCredential: true },
  { id: 2, providerId: 'claude-cli', label: 'Личный Max', authMode: 'token', state: 'cooling', active: false, lastUsedAt: null, hasCredential: true,
    cooldown: { scope: 'account', reason: 'quota', until: null } },
]

let mock: ApiMock
let accountListCalls: Array<string | undefined>
let accountList: unknown[]

function mountControl() {
  return render(createElement(PromptRouteControl))
}

async function openPicker() {
  fireEvent.click(screen.getByText(/модель на 1 запрос/))
  await waitFor(() => expect(document.querySelector('.gg-prompt-route-select')).toBeTruthy())
}

beforeEach(() => {
  accountListCalls = []
  accountList = ACCOUNTS
  mock = makeApiMock({
    ...CHAT_API_DEFAULTS,
    providers: { list: async () => PROVIDERS },
    subscriptionAccounts: {
      list: async (providerId?: string) => {
        accountListCalls.push(providerId)
        // Proxy-мок: переназначение метода невидимо, поэтому читаем мутабельную
        // переменную — тесты меняют состав аккаунтов через неё.
        return providerId === 'claude-cli' ? accountList : []
      },
    },
  })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({ path: '/p', activeChatId: 7, promptRouteOverride: null }, false)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('PromptRouteControl: аккаунт на один запрос (2.1.3-CD)', () => {
  it('провайдер БЕЗ аккаунтов → override сразу, аккаунтный шаг не показывается', async () => {
    mountControl()
    await openPicker()
    fireEvent.change(document.querySelector('.gg-prompt-route-select')!, { target: { value: 'grok::grok-4.5' } })
    await waitFor(() => expect(useProject.getState().promptRouteOverride).toEqual({
      providerId: 'grok', model: 'grok-4.5', fallbackPolicy: 'strict',
    }))
    expect(accountListCalls).toEqual(['grok']) // спросили — аккаунтов нет — шага нет
    expect(document.querySelector('.gg-prompt-route-account-select')).toBeNull()
  })

  it('у провайдера есть аккаунты → второй шаг: «Автоматически» или конкретный аккаунт', async () => {
    mountControl()
    await openPicker()
    fireEvent.change(document.querySelector('.gg-prompt-route-select')!, { target: { value: 'claude-cli::auto' } })
    await waitFor(() => expect(document.querySelector('.gg-prompt-route-account-select')).toBeTruthy())
    // override ещё НЕ выставлен — ждём выбора аккаунта
    expect(useProject.getState().promptRouteOverride).toBeNull()
    // аккаунты названы label'ами, статусы человеческие; id нигде не светится
    expect(screen.getByText(/Рабочий Max/)).toBeTruthy()
    expect(screen.getByText(/Личный Max — остывает · квота исчерпана · срок неизвестен/)).toBeTruthy()
  })

  it('выбор конкретного аккаунта → override с accountId, всегда strict', async () => {
    mountControl()
    await openPicker()
    fireEvent.change(document.querySelector('.gg-prompt-route-select')!, { target: { value: 'claude-cli::auto' } })
    await waitFor(() => expect(document.querySelector('.gg-prompt-route-account-select')).toBeTruthy())
    fireEvent.change(document.querySelector('.gg-prompt-route-account-select')!, { target: { value: '2' } })
    await waitFor(() => expect(useProject.getState().promptRouteOverride).toEqual({
      providerId: 'claude-cli', model: 'auto', fallbackPolicy: 'strict', accountId: 2,
    }))
  })

  it('«Автоматически» → override БЕЗ accountId (обычный pin/auto путь)', async () => {
    mountControl()
    await openPicker()
    fireEvent.change(document.querySelector('.gg-prompt-route-select')!, { target: { value: 'claude-cli::auto' } })
    await waitFor(() => expect(document.querySelector('.gg-prompt-route-account-select')).toBeTruthy())
    fireEvent.change(document.querySelector('.gg-prompt-route-account-select')!, { target: { value: 'auto' } })
    await waitFor(() => expect(useProject.getState().promptRouteOverride).toEqual({
      providerId: 'claude-cli', model: 'auto', fallbackPolicy: 'strict',
    }))
  })

  it('чип с accountId: виден label аккаунта, policy-toggle СКРЫТ (строго всегда)', async () => {
    useProject.setState({
      promptRouteOverride: { providerId: 'claude-cli', model: 'auto', fallbackPolicy: 'strict', accountId: 2 },
    }, false)
    mountControl()
    await waitFor(() => expect(screen.getByText(/Личный Max/).textContent).toBeTruthy())
    expect(document.querySelector('.gg-prompt-route-policy')).toBeNull()
    expect(screen.getByText(/строго/)).toBeTruthy() // статичная пометка вместо тумблера
  })

  it('чип без accountId: прежний policy-toggle на месте (регрессии нет)', async () => {
    useProject.setState({
      promptRouteOverride: { providerId: 'grok', model: 'grok-4.5', fallbackPolicy: 'strict' },
    }, false)
    mountControl()
    await waitFor(() => expect(document.querySelector('.gg-prompt-route-policy')).toBeTruthy())
  })

  it('аккаунтный шаг требует входа/ошибка — недоступен для выбора (гарантированный стоп)', async () => {
    accountList = [
      ...ACCOUNTS,
      { id: 3, providerId: 'claude-cli', label: 'Сломанный', authMode: 'token', state: 'login-required', active: false, lastUsedAt: null, hasCredential: true },
    ]
    mountControl()
    await openPicker()
    fireEvent.change(document.querySelector('.gg-prompt-route-select')!, { target: { value: 'claude-cli::auto' } })
    await waitFor(() => expect(document.querySelector('.gg-prompt-route-account-select')).toBeTruthy())
    const broken = [...document.querySelectorAll('.gg-prompt-route-account-select option')]
      .find(o => o.textContent?.includes('Сломанный')) as HTMLOptionElement
    expect(broken.disabled).toBe(true)
  })
})
