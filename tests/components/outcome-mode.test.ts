// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nContext } from '../../src/i18n'
import { ru } from '../../src/i18n/ru'
import { PipelineWizard } from '../../src/components/PipelineWizard'
import type { PipelineRun } from '../../src/types/api'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('2.1.5 Outcome Mode GA', () => {
  it('показывает понятный вход и по умолчанию выбирает «Под контролем»', () => {
    mount(vi.fn())
    expect(screen.getByRole('dialog', { name: 'До результата' })).toBeTruthy()
    expect((screen.getByRole('radio', { name: /Под контролем/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/План, независимая критика/)).toBeTruthy()
  })

  it('передаёт выбранную глубину в durable pipeline start', async () => {
    const start = vi.fn(async () => run())
    mount(start)
    fireEvent.change(screen.getByPlaceholderText(/Опиши результат/), { target: { value: 'Починить авторизацию' } })
    fireEvent.click(screen.getByRole('radio', { name: /Глубоко/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Уточнить задачу' }))

    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({
      effortLevel: 'deep',
      brief: expect.objectContaining({ goal: 'Починить авторизацию' }),
    })))
  })

  it('не закрывает форму и показывает ошибку, если main не создал прогон', async () => {
    mount(vi.fn(async () => null))
    fireEvent.change(screen.getByPlaceholderText(/Опиши результат/), { target: { value: 'Починить авторизацию' } })
    fireEvent.click(screen.getByRole('button', { name: 'Уточнить задачу' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Не удалось запустить задачу')
    expect(screen.getByRole('dialog', { name: 'До результата' })).toBeTruthy()
  })
})

function mount(start: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: { pipeline: { start } } }))
  return render(createElement(
    I18nContext.Provider,
    { value: ru },
    createElement(PipelineWizard, { onClose: vi.fn(), onStarted: vi.fn() }),
  ))
}

function run(): PipelineRun {
  return {
    id: 1,
    projectPath: 'C:/project',
    chatId: null,
    agentRunId: null,
    mode: 'dev',
    effortLevel: 'controlled',
    workflowId: null,
    step: 'refine',
    brief: { goal: 'Починить авторизацию', constraints: '', dod: '' },
    planId: null,
    taskContract: null,
    contractRevision: 0,
    contractDiagnostics: [],
    verifyAttempts: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}
