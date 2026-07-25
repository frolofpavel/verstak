// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeApiMock, type ApiMock } from './helpers/window-api-mock'
import type { PolicyMatrixDTO } from '../../src/types/api'

const { PolicyTab } = await import('../../src/components/settings/PolicyTab')

const MATRIX: PolicyMatrixDTO = {
  modes: [
    { id: 'ask', label: 'Запрос разрешений', description: 'Спрашивает', icon: '?' },
    { id: 'auto', label: 'Авто', description: 'Работает сам', icon: 'A' },
  ],
  rows: [
    {
      tool: 'read_file',
      category: 'read',
      decisions: {
        ask: 'auto-accept',
        'accept-edits': 'auto-accept',
        plan: 'auto-accept',
        auto: 'auto-accept',
        bypass: 'auto-accept',
      },
    },
    {
      tool: 'run_command',
      category: 'command',
      decisions: {
        ask: 'confirm',
        'accept-edits': 'confirm',
        plan: 'block',
        auto: 'auto-accept',
        bypass: 'auto-accept',
      },
    },
  ],
  commandDanger: ['Удаление системных файлов'],
}

let mock: ApiMock

beforeEach(() => {
  mock = makeApiMock({
    policy: { matrix: async () => MATRIX },
    settings: {
      getKey: async () => null,
      setKey: async () => undefined,
      outputStyles: async () => [],
    },
  })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PolicyTab', () => {
  it('показывает реальную матрицу и список абсолютных запретов', async () => {
    render(createElement(PolicyTab))

    await waitFor(() => expect(screen.getByText('Карта режимов')).toBeTruthy())
    expect(screen.getByText('Чтение файлов')).toBeTruthy()
    expect(screen.getByText('Команды')).toBeTruthy()

    fireEvent.click(screen.getByText('Всегда запрещено'))
    expect(screen.getByText('Удаление системных файлов')).toBeTruthy()
  })

  it('сохраняет изменение расширенной политики через settings API', async () => {
    render(createElement(PolicyTab))

    await waitFor(() => expect(screen.getByText('Карта режимов')).toBeTruthy())
    fireEvent.click(screen.getByText('Дополнительные настройки'))
    fireEvent.click(screen.getByLabelText('Разрешить веб-доступ'))

    await waitFor(() => {
      expect(mock.calls.get('settings.setKey')).toHaveBeenCalledWith('web_access', 'true')
    })
  })
})
