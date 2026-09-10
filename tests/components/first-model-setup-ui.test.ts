// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AuthScreen } from '../../src/components/AuthScreen'
import { I18nContext } from '../../src/i18n'
import { ru } from '../../src/i18n/ru'
import { makeApiMock } from './helpers/window-api-mock'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('первый запуск с IRI Gateway', () => {
  it('не завершает онбординг и не сохраняет ключ при неуспешной проверке', async () => {
    const onComplete = vi.fn()
    const api = mount(onComplete, async () => ({ ok: false, message: 'Ключ не принят.' }))

    await createProfile()
    expect(screen.getByRole('heading', { name: 'Подключите AI-модель' })).toBeTruthy()
    expect(onComplete).not.toHaveBeenCalled()
    expect(api.calls.get('settings.setKey')).not.toHaveBeenCalledWith('auth_completed', 'true')

    fireEvent.change(screen.getByPlaceholderText('Ключ из кабинета IRI Gateway'), {
      target: { value: 'test-invalid-key' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Проверить и начать работу →' }))

    expect(await screen.findByText('Ключ не принят.')).toBeTruthy()
    expect(api.calls.get('providers.testConnection')).toHaveBeenCalledWith(
      'verstak-gateway',
      'test-invalid-key',
    )
    expect(api.calls.get('settings.setKey')).not.toHaveBeenCalledWith(
      'verstak_gateway_api_key',
      expect.anything(),
    )
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('сохраняет проверенный ключ и выбранную модель, затем открывает приложение', async () => {
    const onComplete = vi.fn()
    const api = mount(onComplete, async () => ({ ok: true, message: 'Подключение работает.' }))

    await createProfile()
    fireEvent.change(screen.getByPlaceholderText('Ключ из кабинета IRI Gateway'), {
      target: { value: '  test-valid-key  ' },
    })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'verstak/free' } })
    fireEvent.click(screen.getByRole('button', { name: 'Проверить и начать работу →' }))

    await waitFor(() => {
      expect(api.calls.get('settings.setKey')).toHaveBeenCalledWith(
        'verstak_gateway_api_key',
        'test-valid-key',
      )
      expect(api.calls.get('settings.setKey')).toHaveBeenCalledWith('provider', 'verstak-gateway')
      expect(api.calls.get('settings.setKey')).toHaveBeenCalledWith('model_verstak-gateway', 'verstak/free')
      expect(api.calls.get('settings.setKey')).toHaveBeenCalledWith('auth_completed', 'true')
    })
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce(), { timeout: 1_500 })
  })
})

function mount(
  onComplete: () => void,
  testConnection: (providerId: string, apiKey: string) => Promise<{ ok: boolean; message: string }>,
) {
  const mock = makeApiMock({
    settings: {
      getKey: async (key: string) => key === 'app_language' ? 'ru' : null,
      setKey: async () => undefined,
    },
    userProfiles: {
      list: async () => [],
      create: async () => ({ id: 1, name: 'Игорь', role: 'manager', isActive: true }),
      setActive: async () => undefined,
    },
    localModels: { scan: async () => [] },
    cli: { detect: async () => [] },
    providers: { testConnection },
  })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  render(createElement(
    I18nContext.Provider,
    { value: ru },
    createElement(AuthScreen, { onComplete, onLangChange: vi.fn() }),
  ))
  return mock
}

async function createProfile() {
  const name = await screen.findByPlaceholderText('Как тебя зовут?')
  fireEvent.change(name, { target: { value: 'Игорь' } })
  fireEvent.click(screen.getByRole('button', { name: 'Начать работу →' }))
  await screen.findByRole('heading', { name: 'Подключите AI-модель' })
}
