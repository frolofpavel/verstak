// @vitest-environment jsdom
//
// 2.1.11 срез D — characterization панелей прогона, снятая ДО переноса.
//
// Под потоком в Chat.tsx стоял блок управления прогоном: таймлайн активности,
// pills ревью, баннер pipeline, приёмка контракта задачи, модальный визард
// pipeline, панель «Прогоны» и хост панели хода работы. Прямых проверок не было.
//
// Переносится ТОЛЬКО UI-слой: оркестрация (что делает кнопка, как стартует
// pipeline, как резолвится контракт) остаётся в Chat.tsx и здесь не трогается.
// Поэтому пины держат две вещи: что панель ЕСТЬ на своём месте и что модалка
// закрыта, пока её не открыли — открытие идёт через живой клик по реальной
// кнопке, а не через залезание в состояние.
//
// ГРАНИЦА ХАРНЕССА — общая для 2.1.11 (docs/CODE-AUDIT-2026-07-25.md): только
// синхронные проверки через act(), реальный конвейер отправки не запускается.
import { seedActive } from '../store/_active-bundle'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { Chat } = await import('../../src/components/Chat')

let mock: ApiMock

function mountChat() {
  return render(createElement(Chat, {
    onOpenSettings: vi.fn(),
    rightPanel: null as never,
    onSelectRightPanel: vi.fn(),
    isSettingsOpen: false,
    onOpenSideChat: vi.fn(),
    onOpenFilePreview: vi.fn(),
  }))
}

function click(el: Element | null): void {
  if (!el) throw new Error('нет элемента — пин потерял якорь')
  act(() => { fireEvent.click(el) })
}

/** Кнопки входа в pipeline и «Прогоны» делят класс gg-pipeline-entry. «Прогоны» —
 *  строка захардкожена, подпись входа берётся из локали (в тестах — английской),
 *  поэтому вход опознаём «от противного»: это та кнопка, которая не «Прогоны». */
function runsButton(): Element {
  return entryButton(text => text === 'Прогоны', 'Прогоны')
}

function pipelineEntryButton(): Element {
  return entryButton(text => text !== 'Прогоны', 'вход в pipeline')
}

function entryButton(match: (text: string) => boolean, what: string): Element {
  const all = Array.from(document.querySelectorAll('.gg-pipeline-entry'))
  const found = all.find(el => match(el.textContent?.trim() ?? ''))
  if (!found) throw new Error(`нет кнопки «${what}» среди: ${all.map(e => e.textContent?.trim()).join(' | ')}`)
  return found
}

beforeEach(() => {
  mock = makeApiMock({
    ...CHAT_API_DEFAULTS,
    commands: { list: async () => [] },
    // Панель «Прогоны» грузит историю сразу при открытии: без формы ответа
    // filterOutcomeRuns падает на undefined ещё до первого рендера.
    pipeline: { list: async () => [] },
    agentJobs: { list: async () => [] },
  })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7, chats: {},
    sendOwners: {}, chatSessions: [{ id: 7 }] as never, helpMode: false,
  }, false)
  seedActive(useProject, { messages: [], isStreaming: false })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('панели прогона — состав и место', () => {
  it('активности нет — лейн таймлайна не рендерится', () => {
    mountChat()
    expect(document.querySelector('.gg-timeline')).toBeNull()
  })

  // В1 (решение Павла 11.08): лента активности над строкой ввода ДУБЛИРОВАЛА
  // карточку «Ход работы» — остаётся только карточка. Прежний пин этого блока
  // («появилась активность — таймлайн встаёт под потоком») стерёг именно
  // отменённый контракт и снят тем же коммитом, что скрыл ленту (§3.1).
  it('В1: активность больше НЕ рендерит ленту над строкой ввода', () => {
    mountChat()
    seedActive(useProject, {
      activity: [{ id: 'a1', kind: 'read', label: 'Читаю', detail: 'src/a.ts', status: 'ok', timestamp: 1 }],
    })
    act(() => { useProject.setState({}, false) })
    expect(document.querySelector('.gg-timeline')).toBeNull()
    // Данные не потеряны: активность по-прежнему лежит в store — её читает
    // «Ход работы», скрыт только дублирующий рендер.
    const bundle = useProject.getState().chats[7]
    expect(bundle?.activity).toHaveLength(1)
  })

  it('В1-контроль: пилюли ревью и артефактов НЕ дубли — остаются в подвале', () => {
    mountChat()
    act(() => {
      useProject.setState({
        reviews: {
          5: {
            reviewChatId: 5, parentChatId: 7, providerId: 'claude',
            status: 'done', noteCount: 2, createdAt: 1,
          } as never,
        },
        artifacts: [{ kind: 'html', path: 'C:/proj/a.html', filename: 'a.html', sizeBytes: 2048 } as never],
      }, false)
    })
    const timeline = document.querySelector('.gg-timeline')
    expect(timeline, 'подвал с ревью/артефактами исчез вместе с лентой — потеря доступа').toBeTruthy()
    expect(document.querySelector('.gg-review-pill')).toBeTruthy()
    expect(document.querySelector('.gg-artifact-pill')).toBeTruthy()
    // А чипов активности в нём нет и с активностью в store:
    seedActive(useProject, {
      activity: [{ id: 'a1', kind: 'read', label: 'Читаю', detail: 'src/a.ts', status: 'ok', timestamp: 1 }],
    })
    act(() => { useProject.setState({}, false) })
    expect(document.querySelector('.gg-timeline-pill.is-read')).toBeNull()
  })

  it('баннера pipeline нет, пока pipeline не запущен', () => {
    mountChat()
    expect(document.querySelector('.gg-pipeline-banner')).toBeNull()
  })

  it('приёмки контракта задачи нет, пока агент её не предложил', () => {
    mountChat()
    expect(document.querySelector('.gg-task-contract')).toBeNull()
  })
})

describe('панели прогона — модалки открываются кнопками', () => {
  it('визард pipeline закрыт и открывается кнопкой входа', () => {
    mountChat()
    expect(document.querySelector('.gg-pipeline-wizard')).toBeNull()
    click(pipelineEntryButton())
    expect(document.querySelector('.gg-pipeline-wizard')).toBeTruthy()
  })

  it('панель «Прогоны» закрыта и открывается своей кнопкой', () => {
    mountChat()
    expect(document.querySelector('.gg-outcome-runs-panel')).toBeNull()
    click(runsButton())
    expect(document.querySelector('.gg-outcome-runs-panel')).toBeTruthy()
  })
})

describe('панели прогона — ход работы', () => {
  it('хост хода работы появляется только на стриме с накопленным прогрессом', () => {
    mountChat()
    expect(document.querySelector('.gg-agent-progress-host')).toBeNull()

    act(() => { useProject.getState().setStreaming(true) })
    expect(document.querySelector('.gg-agent-progress-host')).toBeNull()

    seedActive(useProject, {
      isStreaming: true,
      agentProgress: [{
        id: 'p1', phase: 'tool', title: 'Работаю', detail: 'читаю файлы',
        status: 'running', timestamp: 1,
      }],
    })
    act(() => { useProject.setState({}, false) })
    const host = document.querySelector('.gg-agent-progress-host')
    expect(host).toBeTruthy()
    expect(host?.querySelector('.gg-agent-progress.is-live')).toBeTruthy()
  })
})
