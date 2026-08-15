// @vitest-environment jsdom
//
// БЛОК 4 (VSK-PRODUCT-A1 автономно): снятие флага «СКОРО» тривиально зелёное, а
// панель могла не работать — её собрали, но никто не открывал глазами. Условие
// постановщика: по каждой снимаемой панели пин, что она ОТКРЫВАЕТСЯ И ДЕЛАЕТ СВОЮ
// РАБОТУ (смонтировать + проверить разметку), а не «кнопка кликается». Падает при
// открытии — флаг не снимаем. Четыре панели — четыре сценария ниже.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, waitFor } from '@testing-library/react'
// §5 ревью 2.6.4: заголовок панели теперь берётся из словаря активного языка,
// а не зашит по-русски. Сверяем со словарём — иначе пин снова стерёг бы
// конкретную русскую строку в английском интерфейсе.
import { en } from '../../src/i18n/en'

const { useProject } = await import('../../src/store/projectStore')
const { BrainPanel } = await import('../../src/components/BrainPanel')
const { ScheduledTasksView } = await import('../../src/components/ScheduledTasksView')
const { ProjectMapPanel } = await import('../../src/components/ProjectMapPanel')
const { AgentsPanel } = await import('../../src/components/AgentsPanel')

function stubApi(api: Record<string, unknown>) {
  vi.stubGlobal('window', Object.assign(globalThis.window, { api }))
}

beforeEach(() => {
  useProject.setState({ path: '/proj', activeChatId: null }, false)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Мозг (brain) — открывается, пустое состояние ЧЕСТНО зовёт «Прогреть»', () => {
  it('не прогрет → заголовок + честная подсказка «Прогреть проект» (не сломанный экран)', async () => {
    stubApi({ brain: { get: vi.fn(async () => null), warmup: vi.fn() } })
    render(createElement(BrainPanel))
    await waitFor(() => expect(document.querySelector('.gg-panel-title')?.textContent).toBe('Мозг проекта'))
    // Требование постановщика: пустое состояние объясняет, что нажать.
    // ЖДЁМ ИМЕННО ПОДСКАЗКУ, а не только заголовок: заголовок рисуется сразу, а подсказка —
    // после ответа brain.get(), то есть ТИКОМ ПОЗЖЕ. Ожидание стояло на заголовке, а проверка
    // на подсказке — под нагрузкой проверка успевала раньше ответа и роняла прогон примерно
    // в четверти случаев (09.08, поймано pre-commit хуком на релизе 2.4.7). Утверждения те же,
    // перенесено только место ожидания.
    await waitFor(() => expect(document.body.textContent).toContain('Проект ещё не прогрет'))
    expect(document.body.textContent).toContain('Прогреть проект')
  })

  it('прогрет → рендерит обзор (делает свою работу)', async () => {
    const brain = {
      version: 3, updatedAt: 1_700_000_000_000, lastWarmupAt: 1_700_000_000_000,
      overview: 'Verstak — десктопный AI-агент', architectureSummary: '', projectRules: '',
      importantFiles: ['main.ts'], entities: [],
    }
    stubApi({ brain: { get: vi.fn(async () => brain), warmup: vi.fn() } })
    render(createElement(BrainPanel))
    await waitFor(() => expect(document.body.textContent).toContain('Verstak — десктопный AI-агент'))
    expect(document.querySelector('.gg-brain')).toBeTruthy()
  })
})

describe('Расписание (scheduler) — открывается и показывает свою работу', () => {
  it('заголовок + список задачи + подпись «НЕ пишут» (read-only на виду у человека)', async () => {
    const task = { id: 1, nl: 'каждое утро', prompt: 'собери сводку', cron: '0 9 * * *', enabled: 1, project_path: '/proj', last_run_at: null, last_status: null, last_result: null }
    stubApi({ scheduler: {
      list: vi.fn(async () => [task]),
      health: vi.fn(async () => ({ stalled: false, lastHeartbeatAgeMs: 1000, enabledCount: 1 })),
      create: vi.fn(), remove: vi.fn(), runNow: vi.fn(), toggle: vi.fn(),
    } })
    render(createElement(ScheduledTasksView))
    await waitFor(() => expect(document.querySelector('.gg-view-title')?.textContent).toContain('Расписание'))
    // read-only заявлено человеку прямо в UI (совпадает с кодовым фактом).
    expect(document.body.textContent).toContain('НЕ пишут')
    // задача из списка отрисована (панель делает свою работу, а не пустой каркас).
    expect(document.body.textContent).toContain('собери сводку')
  })
})

describe('Карта (project-map) — открывается и обрабатывает карту', () => {
  it('заголовок + статистика + группа папки (панель не падает и делает свою работу)', async () => {
    stubApi({
      projectMap: {
        get: vi.fn(async () => ({
          root: '/proj',
          files: [{ path: 'src/main.ts', lines: 120, symbols: [] }],
          stats: { totalFiles: 1, codeFiles: 1, totalLines: 120, truncated: false },
        })),
        deps: vi.fn(async () => ({ files: {} })),
      },
      files: { revealInExplorer: vi.fn(async () => {}) },
    })
    render(createElement(ProjectMapPanel))
    // Ждём ИМЕННО разобранную карту, а не заголовок: заголовок панель рисует уже в
    // состоянии «Строю карту проекта…», то есть ДО того, как projectMap.get()
    // разрешился. Под нагрузкой (хук коммита, дефолтный параллелизм) ожидание
    // заканчивалось на загрузке, и следом падало утверждение про статистику —
    // ложное красное о продукте, который вёл себя правильно. Утверждения те же,
    // исправлена точка синхронизации.
    await waitFor(() => expect(document.body.textContent).toContain('1 файлов'))
    expect(document.querySelector('.gg-panel-title')?.textContent).toBe('Карта проекта')
    // Карта разобрана: статистика и группа верхней папки на экране.
    expect(document.body.textContent).toContain('src')
  })
})

describe('Агенты (agents) — открывается', () => {
  it('заголовок панели рендерится с пустыми списками (панель не падает)', async () => {
    stubApi({
      agents: {
        list: vi.fn(async () => []),
        queueStats: vi.fn(async () => ({ running: 0, queued: 0, done: 0 })),
        todos: vi.fn(async () => []),
        history: vi.fn(async () => []),
        cancel: vi.fn(),
      },
      agentJobs: {
        list: vi.fn(async () => []),
        approveResume: vi.fn(), cancel: vi.fn(), chooseVariant: vi.fn(), rejectVariant: vi.fn(),
      },
      providers: { list: vi.fn(async () => []) },
    })
    render(createElement(AgentsPanel))
    await waitFor(() => expect(document.querySelector('.gg-panel-title')?.textContent).toBe(en.sidebar.agents))
  })
})
