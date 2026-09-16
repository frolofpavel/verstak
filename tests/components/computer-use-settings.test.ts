// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nContext } from '../../src/i18n'
import { ru } from '../../src/i18n/ru'
import { ComputerUseSettingsCard } from '../../src/components/settings/ComputerUseSettingsCard'
import type { ComputerUseStateDTO } from '../../src/types/api'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ComputerUseSettingsCard', () => {
  function installApi() {
    const getState = vi.fn(async (): Promise<ComputerUseStateDTO> => ({
      supported: true,
      helperReady: true,
      bound: false,
      bindingGeneration: 0,
      target: null as { processName: string; title: string } | null,
      expiresAt: null as number | null,
      reconciliationRequired: false,
    }))
    const listCandidates = vi.fn(async () => [
      { candidateId: 'opaque-safe', processName: 'notepad.exe', title: 'Temporary R2 document', blockedReason: null },
      { candidateId: 'opaque-admin', processName: 'admin.exe', title: 'Elevated window', blockedReason: 'Повышенное окно запрещено' },
    ])
    const bind = vi.fn(async () => ({ ok: true, bindingGeneration: 1 }))
    const acknowledgeUncertain = vi.fn<() => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true }))
    const unbind = vi.fn(async () => ({ ok: true }))
    const stop = vi.fn(async () => ({ acknowledged: true, targetAckMs: 500, realTimeGuaranteed: false }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { computerUse: { getState, listCandidates, bind, acknowledgeUncertain, unbind, stop } },
    })
    return { getState, listCandidates, bind, acknowledgeUncertain, unbind, stop }
  }

  function renderCard() {
    return render(createElement(
      I18nContext.Provider,
      { value: ru },
      createElement(ComputerUseSettingsCard),
    ))
  }

  function expectNoticeSeverity(expected: 'is-ok' | 'is-error') {
    const notice = document.querySelector('.gg-browser-settings-notice')
    expect(notice).toBeTruthy()
    expect(notice?.classList.contains(expected)).toBe(true)
    expect(notice?.classList.contains(expected === 'is-ok' ? 'is-error' : 'is-ok')).toBe(false)
  }

  function mockBoundState(api: ReturnType<typeof installApi>) {
    api.getState.mockResolvedValue({
      supported: true,
      helperReady: true,
      bound: true,
      bindingGeneration: 3,
      target: { processName: 'notepad.exe', title: 'Temporary R2 document' },
      expiresAt: null,
      reconciliationRequired: false,
    })
  }

  it('binds only the exact opaque window selected by the user', async () => {
    const api = installApi()
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать окно' }))
    const safe = await screen.findByRole('button', { name: /Temporary R2 document/ })
    const blocked = screen.getByRole('button', { name: /Elevated window/ })
    expect((blocked as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(safe)
    await waitFor(() => expect(api.bind).toHaveBeenCalledWith('opaque-safe'))
    expect(document.body.textContent).not.toMatch(/PID|HWND|4242|0x/i)
  })

  it('shows an explicit revoke and bounded stop after binding', async () => {
    const api = installApi()
    api.getState.mockResolvedValue({
      supported: true,
      helperReady: true,
      bound: true,
      bindingGeneration: 3,
      target: { processName: 'notepad.exe', title: 'Temporary R2 document' },
      expiresAt: Date.now() + 300_000,
      reconciliationRequired: false,
    })
    renderCard()

    expect(await screen.findByText('Temporary R2 document')).toBeTruthy()
    expect(screen.getByText('notepad.exe')).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: 'Стоп' }))
    await waitFor(() => expect(api.stop).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/остановлена/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Снять доступ' }))
    await waitFor(() => expect(api.unbind).toHaveBeenCalledTimes(1))
  })

  it('tells the user how to transfer foreground before an effectful run', async () => {
    const api = installApi()
    api.getState.mockResolvedValue({
      supported: true,
      helperReady: true,
      bound: true,
      bindingGeneration: 3,
      target: { processName: 'notepad.exe', title: 'Temporary R2 document' },
      expiresAt: null,
      reconciliationRequired: false,
    })
    renderCard()

    expect(await screen.findByText(/после отправки команды переключитесь в выбранное окно/i)).toBeTruthy()
    expect(screen.getByText(/не используйте мышь и клавиатуру до завершения/i)).toBeTruthy()
  })

  it('discloses the provider data scope and persistence boundary before selection', async () => {
    installApi()
    renderCard()

    expect(await screen.findByText(/текст, названия и роли видимых UIA-элементов/i)).toBeTruthy()
    expect(screen.getByText(/передаются выбранной AI-модели/i)).toBeTruthy()
    expect(screen.getByText(/снимки экрана в R2 не передаются/i)).toBeTruthy()
    expect(screen.getByText(/не копирует содержимое наблюдений.*в техническую телеметрию, checkpoints, журнал agent-run и память.*обычная видимая переписка.*общей политике данных приложения/i)).toBeTruthy()
  })

  it('renders successful bind, stop, and unbind notices only as success', async () => {
    const bindApi = installApi()
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать окно' }))
    fireEvent.click(await screen.findByRole('button', { name: /Temporary R2 document/ }))
    await screen.findByText('Доступ выдан только выбранному окну.')
    expectNoticeSeverity('is-ok')

    cleanup()
    const boundApi = installApi()
    mockBoundState(boundApi)
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Стоп' }))
    await screen.findByText('Очередь ввода остановлена.')
    expectNoticeSeverity('is-ok')

    fireEvent.click(screen.getByRole('button', { name: 'Снять доступ' }))
    await screen.findByText('Доступ к окну снят.')
    expectNoticeSeverity('is-ok')
    expect(bindApi.bind).toHaveBeenCalledTimes(1)
  })

  it('renders a rejected candidate list only as an error', async () => {
    const api = installApi()
    api.listCandidates.mockRejectedValueOnce(new Error('helper unavailable'))
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать окно' }))
    await screen.findByText(/Computer Use недоступен/)
    expectNoticeSeverity('is-error')
  })

  it('shows explicit human reconciliation only for an unknown effect and refreshes after acknowledgement', async () => {
    const api = installApi()
    api.getState.mockResolvedValue({
      supported: true,
      helperReady: true,
      bound: true,
      bindingGeneration: 3,
      target: { processName: 'notepad.exe', title: 'Temporary R2 document' },
      expiresAt: null,
      reconciliationRequired: true,
      reconciliationAcknowledgementAvailable: true,
    })
    renderCard()

    expect(await screen.findByText(/исход прошлого действия неизвестен/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Я проверил результат' }))
    await waitFor(() => expect(api.acknowledgeUncertain).toHaveBeenCalledWith())
    expect(api.getState.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(await screen.findByText('Результат отмечен как проверенный. Для продолжения нужна новая команда и новое наблюдение.')).toBeTruthy()
    expectNoticeSeverity('is-ok')
  })

  it('does not present a failed uncertain acknowledgement as success', async () => {
    const api = installApi()
    api.getState.mockResolvedValue({
      supported: true,
      helperReady: true,
      bound: true,
      bindingGeneration: 3,
      target: { processName: 'notepad.exe', title: 'Temporary R2 document' },
      expiresAt: null,
      reconciliationRequired: true,
      reconciliationAcknowledgementAvailable: true,
    })
    api.acknowledgeUncertain.mockResolvedValueOnce({ ok: false, error: 'Нет ожидающего подтверждения результата' })
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Я проверил результат' }))
    expect(await screen.findByText('Нет ожидающего подтверждения результата')).toBeTruthy()
    expectNoticeSeverity('is-error')
  })

  it('does not offer acknowledgement when the original exact target is not selected', async () => {
    const api = installApi()
    api.getState.mockResolvedValue({
      supported: true,
      helperReady: true,
      bound: true,
      bindingGeneration: 4,
      target: { processName: 'other.exe', title: 'Different target' },
      expiresAt: null,
      reconciliationRequired: true,
      reconciliationAcknowledgementAvailable: false,
    })
    renderCard()

    expect(await screen.findByText(/подтверждение пока недоступно/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Я проверил результат' })).toBeNull()
    expect(api.acknowledgeUncertain).not.toHaveBeenCalled()
  })

  it('renders bind ok:false only as an error', async () => {
    const api = installApi()
    api.bind.mockResolvedValueOnce({
      ok: false,
      error: 'Выбранное окно больше недоступно',
    } as never)
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать окно' }))
    fireEvent.click(await screen.findByRole('button', { name: /Temporary R2 document/ }))
    await screen.findByText('Выбранное окно больше недоступно')
    expectNoticeSeverity('is-error')
  })

  it('renders rejected unbind only as an error', async () => {
    const api = installApi()
    mockBoundState(api)
    api.unbind.mockRejectedValueOnce(new Error('helper unavailable'))
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Снять доступ' }))
    await screen.findByText(/Computer Use недоступен/)
    expectNoticeSeverity('is-error')
  })

  it.each([
    ['negative acknowledgement', (api: ReturnType<typeof installApi>) => {
      api.stop.mockResolvedValueOnce({ acknowledged: false, targetAckMs: 500, realTimeGuaranteed: false })
    }],
    ['rejection', (api: ReturnType<typeof installApi>) => {
      api.stop.mockRejectedValueOnce(new Error('helper unavailable'))
    }],
  ])('renders stop %s only as an error', async (_case, arrange) => {
    const api = installApi()
    mockBoundState(api)
    arrange(api)
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Стоп' }))
    await screen.findByText(/Computer Use недоступен/)
    expectNoticeSeverity('is-error')
  })
})
