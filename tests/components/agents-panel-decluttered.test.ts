// @vitest-environment jsdom
//
// Цель 2.7.0, шаг 2 пункт 3: панель «Агенты» перестаёт быть отдельным
// ИНСТРУМЕНТОМ и становится инспектором того, что реально идёт.
//
// Снимается ровно то, что было решением на человеке при пустом экране:
//  · три фильтра «Все роли / Все провайдеры / Все статусы» над списком, который
//    почти всегда пуст или в одну строку;
//  · кнопка «↻» рядом с автообновлением раз в 2 с — продукт уже решил обновлять;
//  · пустое состояние, объясняющее, что оно пустое, и предлагающее две кнопки
//    оркестрации (их разбор — tests/components/multiagent-off-view.test.ts).
//
// Что НЕ снимается: дерево живых суб-сессий, «Отменить всё», Durable Jobs,
// TodoGate. История суб-сессий прошлых прогонов остаётся в разделе «История
// работы» (AgentRunsPanel читает detail.subs) — возможность не теряется.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { makeApiMock, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { AgentsPanel } = await import('../../src/components/AgentsPanel')

let mock: ApiMock

const SUBS = [
  { id: 1, role: 'analyst', providerId: 'claude', model: 'opus', task: 'разобрать логи', status: 'running', startedAt: 1000, endedAt: null, toolCount: 3, costCents: 12, depth: 1, parentId: null },
  { id: 2, role: 'writer', providerId: 'openai', model: 'gpt', task: 'сводка', status: 'done', startedAt: 1000, endedAt: 2000, toolCount: 1, costCents: 4, depth: 1, parentId: null },
]

function mountPanel() {
  return render(createElement(AgentsPanel))
}

function setupApi(subs: unknown[]) {
  mock = makeApiMock({
    agents: {
      list: async () => subs,
      queueStats: async () => ({ inFlight: 0, queued: 0, tracked: 0 }),
      todos: async () => [],
    },
    agentJobs: { list: async () => [] },
    providers: { list: async () => [] },
  })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
}

beforeEach(() => {
  useProject.setState({ path: '/p' }, false)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('панель «Агенты» — разгружена', () => {
  it('фильтров роли/провайдера/статуса и кнопки обновления нет', async () => {
    setupApi([])
    mountPanel()
    await act(async () => { await Promise.resolve() })
    // Контроль отрисовки: панель смонтирована. Без него «селектов нет» зелено и
    // на упавшем рендере.
    expect(document.querySelector('.gg-panel-header')).toBeTruthy()
    expect(document.querySelectorAll('.gg-agents-select').length).toBe(0)
  })

  it('пустого состояния с кнопками оркестрации и роя нет', async () => {
    setupApi([])
    mountPanel()
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.gg-agents-empty')).toBeNull()
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('Оркестровать')
    expect(text).not.toContain('Запустить рой')
  })

  // КОНТРОЛЬНЫЙ КЕЙС: инспектор жив. Если бы снятие пустого состояния задело
  // список, оба пина выше остались бы зелёными и молчали об этом.
  it('живые суб-сессии по-прежнему показываются карточками', async () => {
    setupApi(SUBS)
    mountPanel()
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(document.querySelectorAll('.gg-agent-card').length).toBe(2)
    expect(document.body.textContent).toContain('analyst')
  })
})
