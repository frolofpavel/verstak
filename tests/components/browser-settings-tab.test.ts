// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nContext } from '../../src/i18n'
import { ru } from '../../src/i18n/ru'
import { BrowserSettingsTab } from '../../src/components/settings/BrowserSettingsTab'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BrowserSettingsTab', () => {
  type ConnectResult = {
    ok: boolean
    state: Record<string, unknown>
    needsExtensionAction: boolean
    error?: string
  }

  function installApi(state: Record<string, unknown>) {
    const getState = vi.fn(async () => state)
    const connect = vi.fn(async (): Promise<ConnectResult> => ({ ok: true, state, needsExtensionAction: true }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browserBridge: {
          getState,
          connect,
        },
      },
    })
    return { getState, connect }
  }

  function renderBrowserSettings() {
    return render(createElement(
      I18nContext.Provider,
      { value: ru },
      createElement(BrowserSettingsTab),
    ))
  }

  it('показывает одно действие подключения без pair-кода, пути и attached-tab', async () => {
    const { connect } = installApi({
      ui: 'offline', connected: false, authenticated: false,
      host: { installed: false, needsRepair: true, manifestPath: null },
      attachedTab: { tabRef: 'tab-42', url: 'https://example.test', title: 'Secret tab', origin: 'https://example.test' },
      lastError: null,
    })

    renderBrowserSettings()

    const connectButton = await screen.findByRole('button', { name: 'Подключить браузер' })
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByText(/Pair-код/i)).toBeNull()
    expect(screen.queryByText(/Путь к расширению/i)).toBeNull()
    expect(screen.queryByText('Secret tab')).toBeNull()
    expect(screen.queryByText('https://example.test')).toBeNull()

    fireEvent.click(connectButton)
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
  })

  it('при поломке даёт одну кнопку восстановления и понятное сообщение', async () => {
    const { connect } = installApi({
      ui: 'error', connected: false, authenticated: false,
      host: { installed: true, needsRepair: true, manifestPath: 'C:\\bridge\\host.json' },
      attachedTab: null,
      lastError: 'native_disconnect:EPIPE',
    })

    renderBrowserSettings()
    const recover = await screen.findByRole('button', { name: 'Восстановить' })
    expect(screen.getByText('Не удалось подключить браузер')).toBeTruthy()
    expect(screen.queryByText('native_disconnect:EPIPE')).toBeNull()

    fireEvent.click(recover)
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
  })

  it('ошибку connect переводит в понятное восстановление без сырой технической причины', async () => {
    const state = {
      ui: 'offline', connected: false, authenticated: false,
      host: { installed: false, needsRepair: true, manifestPath: null },
      attachedTab: null,
      lastError: null,
    }
    const { connect } = installApi(state)
    connect.mockResolvedValueOnce({
      ok: false,
      state,
      needsExtensionAction: false,
      error: 'registry_write:EACCES',
    })

    renderBrowserSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Подключить браузер' }))

    expect(await screen.findByText('Не удалось подключить браузер')).toBeTruthy()
    expect(screen.queryByText('registry_write:EACCES')).toBeNull()
    expect(screen.getByRole('button', { name: 'Восстановить' })).toBeTruthy()
  })

  it('paired bridge без exact tab и fresh observe не называет готовым', async () => {
    const { getState } = installApi({
      ui: 'paired', connected: true, authenticated: true,
      connectionGeneration: 4,
      exactTabAttached: false,
      freshObservation: false,
      host: { installed: true, needsRepair: false },
      attachedTab: null,
      lastError: null,
    })

    renderBrowserSettings()
    expect(await screen.findByText('Связь подтверждена')).toBeTruthy()
    expect(screen.queryByText('Готово к работе')).toBeNull()
    const check = await screen.findByRole('button', { name: 'Проверить' })
    fireEvent.click(check)

    await waitFor(() => expect(getState).toHaveBeenCalledTimes(2))
  })

  it('называет готовым только exact attached tab со свежим observe текущего соединения', async () => {
    installApi({
      ui: 'attached', connected: true, authenticated: true,
      connectionGeneration: 4,
      exactTabAttached: true,
      freshObservation: true,
      host: { installed: true, needsRepair: false },
      lastError: null,
    })

    renderBrowserSettings()
    expect(await screen.findByText('Готово к работе')).toBeTruthy()
  })

  it('при готовом host без auth кнопка заново открывает подключение через Connect', async () => {
    const { connect } = installApi({
      ui: 'connecting', connected: true, authenticated: false,
      host: { installed: true, needsRepair: false },
      attachedTab: null,
      lastError: null,
    })

    renderBrowserSettings()
    const button = await screen.findByRole('button', { name: 'Подключить браузер' })
    fireEvent.click(button)

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
  })
})
