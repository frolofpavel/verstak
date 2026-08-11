// @vitest-environment jsdom
//
// P1 шаг 3: панель состязания в «Истории работы» (ResultTrialsSection).
//
// Что стерегут пины:
//  · таблица попыток рендерится из фактов list+summary; неизвестная цена —
//    словом «неизвестна», не нулём;
//  · финиш попытки ставит ПАНЕЛЬ: терминальный runStatus при running-попытке →
//    finishAttempt; живому прогону — НЕ ставится (контрольная пара);
//  · «Принять» зовёт resultTrials.accept, «Дифф» — resultTrials.diff и текст виден;
//  · запуск: оценка и старт получают ОДИН И ТОТ ЖЕ состав конкурентов с ЯВНОЙ
//    моделью (дефолт провайдера разрешён до вызовов); допущение объёма — рядом;
//  · панель НЕ трогает ai.onEvent — свои данные тянет поллингом (0 подписок).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { makeApiMock, type ApiMock } from './helpers/window-api-mock'
import type { TrialAttemptSummaryDTO } from '../../src/types/api'

const { ResultTrialsSection } = await import('../../src/components/ResultTrialsSection')

let mock: ApiMock

const TRIAL = {
  id: 1, projectPath: '/p', parentChatId: 7, prompt: 'почини форму обратной связи',
  status: 'running' as const, acceptedAttemptId: null, createdAt: 1, updatedAt: 1,
}

function attemptRow(over: Partial<TrialAttemptSummaryDTO>): TrialAttemptSummaryDTO {
  return {
    id: 11, trialId: 1, providerId: 'deepseek', model: 'deepseek-chat', workspace: '/w/a',
    chatId: 21, runId: 'run-a', status: 'running', outcome: null, error: null,
    createdAt: 1, updatedAt: 1,
    turns: null, toolCount: null, filesCount: null, costCents: null, durationMs: null, runStatus: 'running',
    ...over,
  }
}

function mount(overrides: Record<string, Record<string, unknown>> = {}) {
  mock = makeApiMock({
    providers: {
      list: async () => [
        { id: 'deepseek', name: 'DeepSeek', shortLabel: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat' },
        { id: 'qwen', name: 'Qwen', shortLabel: 'Qwen', models: ['qwen-max'], defaultModel: 'qwen-max' },
      ],
    },
    resultTrials: {
      list: async () => [TRIAL],
      summary: async () => [
        attemptRow({}),
        attemptRow({ id: 12, providerId: 'qwen', model: 'qwen-max', workspace: '/w/b', runId: 'run-b', status: 'done', runStatus: 'done', costCents: null, turns: 9, durationMs: 120_000 }),
      ],
      available: async () => ({ available: true, reason: null }),
      estimate: async () => [],
      diff: async () => 'diff --git a/x b/x',
      accept: async () => [],
    },
    ...overrides,
  })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  return render(createElement(ResultTrialsSection, { projectPath: '/p', launchSource: null, onDismissSource: vi.fn() }))
}

beforeEach(() => { vi.useRealTimers() })
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('таблица попыток из фактов', () => {
  it('строки видны: исполнитель и честная цена («неизвестна» для терминального без цены)', async () => {
    mount()
    expect(await screen.findByText(/почини форму/)).toBeTruthy()
    // Терминальная попытка qwen без цены — слово, не ноль.
    expect(await screen.findByText('неизвестна')).toBeTruthy()
    // Живая попытка deepseek цены ещё не имеет — «—», не «неизвестна».
    const cells = screen.getAllByText('—')
    expect(cells.length).toBeGreaterThan(0)
  })

  it('панель не трогает ai.onEvent — ноль подписок на поток чата', async () => {
    mount()
    await screen.findByText(/почини форму/)
    expect(mock.aiEvents.subscribeCount).toBe(0)
  })
})

describe('финиш попытки ставит панель', () => {
  it('терминальный runStatus при running-попытке → finishAttempt(done); живому — не ставится', async () => {
    mount({
      resultTrials: {
        list: async () => [TRIAL],
        summary: async () => [
          attemptRow({}), // живой: running + runStatus running → НЕ финишировать
          attemptRow({ id: 12, runId: 'run-b', workspace: '/w/b', status: 'running', runStatus: 'done' }),
        ],
        available: async () => ({ available: true, reason: null }),
      },
    })
    await waitFor(() => {
      const fin = mock.calls.get('resultTrials.finishAttempt')
      expect(fin?.mock.calls.length ?? 0).toBe(1)
    })
    const fin = mock.calls.get('resultTrials.finishAttempt')!
    expect(fin.mock.calls[0][0]).toBe(12)
    expect(fin.mock.calls[0][1]).toMatchObject({ status: 'done' })
  })
})

describe('принятие и дифф', () => {
  it('«Принять» зовёт accept с trialId+attemptId', async () => {
    mount()
    const btn = await screen.findByRole('button', { name: /принять/i })
    fireEvent.click(btn)
    await waitFor(() => {
      const acc = mock.calls.get('resultTrials.accept')
      expect(acc?.mock.calls[0]).toEqual([1, 12])
    })
  })

  it('«Дифф» тянет resultTrials.diff и показывает текст', async () => {
    mount()
    const btns = await screen.findAllByRole('button', { name: /дифф/i })
    fireEvent.click(btns[0])
    expect(await screen.findByText(/diff --git/)).toBeTruthy()
  })
})

describe('запуск состязания у существующей задачи', () => {
  function mountWithSource() {
    mock = makeApiMock({
      providers: {
        list: async () => [
          { id: 'deepseek', name: 'DeepSeek', shortLabel: 'DeepSeek', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
          { id: 'qwen', name: 'Qwen', shortLabel: 'Qwen', models: ['qwen-max'], defaultModel: 'qwen-max' },
        ],
      },
      agentRuns: { resume: async () => ({ chatId: 7, userMessage: 'почини форму обратной связи' }) },
      resultTrials: {
        list: async () => [],
        available: async () => ({ available: true, reason: null }),
        estimate: async () => [
          { providerId: 'deepseek', model: 'deepseek-chat', basis: 'price', price: { input: 0.28, output: 0.42 }, estimateCents: 13 },
          { providerId: 'qwen', model: 'qwen-max', basis: 'unknown', price: null, estimateCents: null },
        ],
        start: async () => ({ trial: TRIAL, attempts: [] }),
        startRuns: async () => ({ started: 2, attempts: [] }),
      },
    })
    vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
    return render(createElement(ResultTrialsSection, {
      projectPath: '/p',
      launchSource: { runId: 'run-src', chatId: 7, title: 'почини форму' },
      onDismissSource: vi.fn(),
    }))
  }

  it('оценка и старт получают ОДИН состав конкурентов с ЯВНОЙ моделью; допущение видно', async () => {
    mountWithSource()
    // Лаунчер открыт: постановка задачи подтянута из прогона (read-only resume).
    await screen.findByText(/почини форму обратной связи/)
    // Оценка приходит с явными моделями (дефолт провайдера разрешён ДО вызова).
    await waitFor(() => {
      const est = mock.calls.get('resultTrials.estimate')
      expect(est?.mock.calls.length ?? 0).toBeGreaterThan(0)
    })
    const est = mock.calls.get('resultTrials.estimate')!
    const estimated = est.mock.calls.at(-1)![0]
    expect(estimated).toEqual([
      { providerId: 'deepseek', model: 'deepseek-chat' },
      { providerId: 'qwen', model: 'qwen-max' },
    ])
    // Неизвестная оценка — словом; допущение объёма — рядом с центами.
    expect(await screen.findByText('неизвестна')).toBeTruthy()
    expect(screen.getByText(/400/)).toBeTruthy()
    expect(screen.getByText(/30/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /запустить/i }))
    await waitFor(() => {
      const start = mock.calls.get('resultTrials.start')
      expect(start?.mock.calls.length ?? 0).toBe(1)
    })
    const start = mock.calls.get('resultTrials.start')!
    const input = start.mock.calls[0][0] as { prompt: string; competitors: unknown; parentChatId: number | null }
    // Постановка НЕ переписана, конкуренты — байт в байт те же, что в оценке.
    expect(input.prompt).toBe('почини форму обратной связи')
    expect(input.competitors).toEqual(estimated)
    expect(input.parentChatId).toBe(7)
    // После start прогоны реально запускаются.
    await waitFor(() => {
      const runs = mock.calls.get('resultTrials.startRuns')
      expect(runs?.mock.calls.length ?? 0).toBe(1)
    })
  })
})
