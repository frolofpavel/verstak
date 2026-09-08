// @vitest-environment jsdom
//
// ДЕФЕКТ, пойманный существующим пином при врезке: секция постоянных задач живёт
// ВНУТРИ экрана «Расписание» и звала мост без проверки. На окружении, где моста
// ещё нет, падал весь экран целиком — расписания вместе с ним. Соседняя функция
// не имеет права ломать чужую.
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { PersistentJobsSection } from '../../src/components/PersistentJobsSection'

afterEach(() => { cleanup(); delete (window as unknown as { api?: unknown }).api })

describe('секция задач не ломает экран, в котором живёт', () => {
  it('без моста секция рисуется, а не падает', () => {
    ;(window as unknown as { api: unknown }).api = {}
    const { container } = render(createElement(PersistentJobsSection, { projectPath: '/p' }))
    expect(container.textContent).toContain('Постоянные задачи')
  })

  it('без моста нечего показать — так и сказано, без выдуманного списка', () => {
    ;(window as unknown as { api: unknown }).api = {}
    const { container } = render(createElement(PersistentJobsSection, { projectPath: '/p' }))
    expect(container.querySelectorAll('.gg-cap-row').length).toBe(0)
  })

  // Контроль: с мостом секция обязана работать — иначе пины выше зелены и у
  // компонента, который не делает вообще ничего.
  it('контроль: с мостом секция запрашивает задачи проекта', async () => {
    const calls: string[] = []
    ;(window as unknown as { api: unknown }).api = {
      jobs: {
        list: async (p: string) => { calls.push(p); return [] },
        limits: async () => ({ maxRunsCap: 100, minIntervalMinutes: 5 }),
        create: async () => ({ error: 'нет' }),
        pause: async () => null,
        resume: async () => null,
        remove: async () => true,
      },
    }
    render(createElement(PersistentJobsSection, { projectPath: '/проект' }))
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toEqual(['/проект'])
  })
})
