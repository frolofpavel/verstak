// @vitest-environment jsdom
//
// СТРАХОВОЧНАЯ СЕТКА под срезы 2.0.9 (карта: docs/2.0.9-A-chat-map.md).
//
// Chat.tsx — 4292 строки, 37 эффектов, 38 веток событий, ноль тестов на компонент. Из него
// будут извлекать persistent context snapshot / fork / rewind. Этот харнес фиксирует ФАКТИЧЕСКОЕ
// поведение диспетчера ai.onEvent (E18, 1327-1753) ДО извлечения — чтобы рефактор не изменил его молча.
//
// jsdom включён docblock'ом ТОЛЬКО в этом файле: остальные 335 тест-файлов остаются в node
// (environmentMatchGlobs в vitest 4 удалён, а docblock — точечнее и не трогает конфиг).
// JSX не используем (React.createElement) — файл остаётся .ts и попадает под include 'tests/**/*.test.ts'.
//
// ГЛАВНОЕ, ЧТО ЗДЕСЬ ЗАЩИЩЕНО (ловушка №1 карты): диспетчер — замыкание ПЕРВОГО рендера с
// deps [updateLastAssistant, setStreaming] (обе стабильны) ⇒ подписка ставится РОВНО ОДИН РАЗ.
// Любое извлечение с «честными» deps пересоздаст подписку, и события, пришедшие между off() и
// onEvent(), потеряются молча: текст пропадёт, done не придёт → isStreaming залипнет НАВСЕГДА.
// Тесты ниже краснеют именно на этом (проверено мутацией deps).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'
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

/** Прогон агента в активном чате: регистрируем owner, как это делает send(). */
function startRun(sendId: number, chatId: number) {
  act(() => {
    useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId, projectPath: '/p' })
    useProject.getState().setStreaming(true)
    useProject.getState().addMessage({ role: 'assistant', content: '' })
  })
}

beforeEach(() => {
  mock = makeApiMock(CHAT_API_DEFAULTS)
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7, messages: [], isStreaming: false,
    sendOwners: {}, chatSessions: [{ id: 7 }] as never, helpMode: false,
  }, false)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Chat: диспетчер ai.onEvent — характеризация (2.0.9-A)', () => {
  it('подписка ставится РОВНО ОДИН РАЗ за маунт (несущий инвариант)', () => {
    mountChat()
    expect(mock.aiEvents.subscribeCount).toBe(1)
    expect(mock.aiEvents.handlers).toHaveLength(1)
  })

  // BASELINE TRACE: текст → текст → done. Фиксирует, что реально делает роутер сегодня.
  it('трасса text→text→done: текст склеивается, стрим закрывается', () => {
    mountChat()
    startRun(101, 7)

    act(() => {
      mock.aiEvents.emit({ id: 101, event: { type: 'text', text: 'Привет' } })
      mock.aiEvents.emit({ id: 101, event: { type: 'text', text: ', Павел' } })
    })
    expect(useProject.getState().messages.at(-1)?.content).toBe('Привет, Павел')

    act(() => { mock.aiEvents.emit({ id: 101, event: { type: 'done' } }) })
    expect(useProject.getState().isStreaming).toBe(false)
    expect(mock.aiEvents.lostEvents).toBe(0)
  })

  it('трасса error: стрим закрывается, событие не теряется', () => {
    mountChat()
    startRun(102, 7)
    act(() => { mock.aiEvents.emit({ id: 102, event: { type: 'error', message: 'сломалось' } }) })
    expect(useProject.getState().isStreaming).toBe(false)
    expect(mock.aiEvents.lostEvents).toBe(0)
  })

  it('чужой sendId (owner не зарегистрирован) НЕ трогает активный чат', () => {
    mountChat()
    startRun(103, 7)
    act(() => { mock.aiEvents.emit({ id: 103, event: { type: 'text', text: 'моё' } }) })
    act(() => { mock.aiEvents.emit({ id: 999, event: { type: 'text', text: 'ЧУЖОЕ' } }) })
    expect(useProject.getState().messages.at(-1)?.content).toBe('моё')
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // ЛОВУШКА №1 (ради чего сетка и заводилась). Эти тесты — не про «красиво», а про то,
  // что рефактор с реактивными deps будет пойман. Доказано мутацией: при добавлении
  // реактивной зависимости в deps диспетчера они КРАСНЕЮТ.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('ловушка №1: подписка не должна пересоздаваться', () => {
    it('ре-рендеры НЕ пересоздают подписку (иначе события теряются в окне off→on)', () => {
      const { rerender } = mountChat()
      const afterMount = mock.aiEvents.subscribeCount

      // Гоняем компонент через изменения, которые обычно попадают в deps при рефакторе:
      // активный чат, стрим, сообщения.
      act(() => { useProject.setState({ activeChatId: 8 }, false) })
      rerender(createElement(Chat, {
        onOpenSettings: vi.fn(), rightPanel: null as never, onSelectRightPanel: vi.fn(),
        isSettingsOpen: false, onOpenSideChat: vi.fn(), onOpenFilePreview: vi.fn(),
      }))
      act(() => { useProject.setState({ isStreaming: true }, false) })
      act(() => { useProject.getState().addMessage({ role: 'user', content: 'ещё' }) })

      expect(mock.aiEvents.subscribeCount).toBe(afterMount) // не переподписались
      expect(mock.aiEvents.offCount).toBe(0)                // и не отписывались
      expect(mock.aiEvents.handlers).toHaveLength(1)        // ровно один живой слушатель
    })

    it('слушатель НЕ снимается, пока компонент жив (окно off→on = окно потери события)', () => {
      mountChat()
      startRun(104, 7)

      // Чередуем ре-рендеры и события — так выглядит живой стрим. Активный чат НЕ меняем:
      // харнес показал, что уход с чата прогона — это ДРУГОЕ (и корректное) поведение —
      // события уходят в фоновый путь (chatSnapshots) и isStreaming активного чата не трогают.
      // Смешивать два инварианта в одном тесте — путать себя же.
      act(() => { mock.aiEvents.emit({ id: 104, event: { type: 'text', text: 'a' } }) })
      act(() => { useProject.getState().addMessage({ role: 'user', content: 'ре-рендер 1' }) })
      act(() => { mock.aiEvents.emit({ id: 104, event: { type: 'text', text: 'b' } }) })
      act(() => { useProject.getState().addMessage({ role: 'user', content: 'ре-рендер 2' }) })
      act(() => { mock.aiEvents.emit({ id: 104, event: { type: 'done' } }) })

      // ЧЕСТНО ПРО ГРАНИЦУ ЭТОГО ТЕСТА: сам факт ПОТЕРИ события — гонка (событие должно
      // прилететь из IPC ровно между off() и onEvent()), детерминированно в тесте её не
      // воспроизвести. Поэтому стережём ПРИЧИНУ, а не следствие: пока компонент жив,
      // отписки быть не должно вообще. offCount>0 = окно потери открылось = поймали.
      expect(mock.aiEvents.offCount).toBe(0)
      expect(mock.aiEvents.handlers).toHaveLength(1)
      expect(mock.aiEvents.lostEvents).toBe(0)
      // …и итог трассы: done дошёл, стрим не залип.
      expect(useProject.getState().isStreaming).toBe(false)
    })
  })
})
