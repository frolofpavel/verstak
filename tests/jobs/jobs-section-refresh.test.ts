// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { PersistentJobsSection } from '../../src/components/PersistentJobsSection'
import type { PersistentJobV1 } from '../../shared/contracts/persistent-job'

function job(overrides: Partial<PersistentJobV1> = {}): PersistentJobV1 {
  return {
    id: 'job-1', projectPath: '/a', title: 'Сводка', goal: 'Подготовить сводку',
    status: 'active', triggerKind: 'schedule', triggerConfig: { everyMinutes: 5 },
    state: {}, nextAction: null, assignedCapabilityId: null, requiredCapabilities: [],
    budgetCents: null, maxRuntimeMs: null, maxRuns: 10, runsDone: 0, costUsedCents: 0,
    lastRunAt: null, nextRunAt: 1000, lastResult: null, createdAt: 0, updatedAt: 0,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function bridge() {
  const jobs = {
    list: vi.fn<(projectPath?: string) => Promise<PersistentJobV1[]>>().mockResolvedValue([job()]),
    limits: vi.fn().mockResolvedValue({ maxRunsCap: 100, minIntervalMinutes: 5 }),
    create: vi.fn().mockResolvedValue({ error: 'нет' }),
    pause: vi.fn().mockResolvedValue(null), resume: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(true),
  } satisfies typeof window.api.jobs
  Object.defineProperty(window, 'api', { configurable: true, value: { jobs } })
  return jobs
}

async function tick(ms = 2000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('открытая карточка постоянной задачи обновляется', () => {
  it('показывает фоновое пробуждение и результат без remount и действий человека', async () => {
    const api = bridge()
    const { container } = render(createElement(PersistentJobsSection, { projectPath: '/a' }))
    await tick(0)
    expect(container.textContent).toContain('спит, ждёт своего часа')
    api.list.mockResolvedValue([job({ status: 'running' })])
    await tick()
    expect(container.querySelector('.gg-cap-status')?.textContent).toBe('работает')
    api.list.mockResolvedValue([job({ status: 'done', runsDone: 1, lastResult: 'Сводка готова' })])
    await tick()
    expect(container.textContent).toContain('закончена')
    expect(container.textContent).toContain('1 из 10')
    expect(container.textContent).toContain('Сводка готова')
    expect(api.list.mock.calls.every(([path]) => path === '/a')).toBe(true)
  })

  it('не наслаивает polling и ручное обновление на медленный IPC', async () => {
    const api = bridge()
    const { getByText } = render(createElement(PersistentJobsSection, { projectPath: '/a' }))
    await tick(0)
    const pending = deferred<PersistentJobV1[]>()
    api.list.mockReturnValueOnce(pending.promise)
    await tick()
    fireEvent.click(getByText('Пауза'))
    await tick(6000)
    expect(api.list).toHaveBeenCalledTimes(2)
    await act(async () => { pending.resolve([job({ status: 'paused' })]) })
    await tick()
    expect(api.list).toHaveBeenCalledTimes(3)
  })

  it('останавливает таймер при unmount даже с ожидающим ответом', async () => {
    const api = bridge()
    const pending = deferred<PersistentJobV1[]>()
    api.list.mockReturnValueOnce(pending.promise)
    const view = render(createElement(PersistentJobsSection, { projectPath: '/a' }))
    view.unmount()
    await act(async () => { pending.resolve([job()]) })
    await tick(6000)
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('не подменяет новый проект поздним списком предыдущего', async () => {
    const api = bridge()
    const pending = deferred<PersistentJobV1[]>()
    api.list.mockReturnValueOnce(pending.promise)
    const view = render(createElement(PersistentJobsSection, { projectPath: '/a' }))
    api.list.mockResolvedValue([job({ projectPath: '/b', title: 'Проект Б' })])
    view.rerender(createElement(PersistentJobsSection, { projectPath: '/b' }))
    await tick(0)
    expect(view.container.textContent).toContain('Проект Б')
    await act(async () => { pending.resolve([job({ title: 'Старый проект' })]) })
    expect(view.container.textContent).toContain('Проект Б')
    expect(view.container.textContent).not.toContain('Старый проект')
  })

  it('игнорирует позднюю ошибку старого проекта', async () => {
    const api = bridge()
    const pending = deferred<PersistentJobV1[]>()
    api.list.mockReturnValueOnce(pending.promise)
    const view = render(createElement(PersistentJobsSection, { projectPath: '/a' }))
    view.rerender(createElement(PersistentJobsSection, { projectPath: '/b' }))
    await act(async () => { pending.reject(new Error('старый IPC')) })
    expect(view.container.textContent).not.toContain('Не удалось прочитать')
  })

  it('убирает прежние карточки и polling без выбранного проекта', async () => {
    const api = bridge()
    const view = render(createElement(PersistentJobsSection, { projectPath: '/a' }))
    await tick(0)
    expect(view.container.textContent).toContain('Сводка')
    view.rerender(createElement(PersistentJobsSection, { projectPath: null }))
    await tick(6000)
    expect(view.container.querySelector('.gg-cap-row')).toBeNull()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('после ошибки чтения продолжает обновлять карточки', async () => {
    const api = bridge()
    api.list.mockRejectedValueOnce(new Error('IPC failed'))
    const view = render(createElement(PersistentJobsSection, { projectPath: '/a' }))
    await tick(0)
    expect(view.container.textContent).toContain('Не удалось прочитать')
    await tick()
    expect(view.container.textContent).toContain('Сводка')
    expect(view.container.textContent).not.toContain('Не удалось прочитать')
  })
})
