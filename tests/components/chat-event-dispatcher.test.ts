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

// ─────────────────────────────────────────────────────────────────────────────
// 2.1.3-CD: видимая история переключений маршрута + ранние маршрутные стопы.
//
// До CD main при ротации аккаунта слал эфемерную info-пилюлю (терялась при reload),
// а ранний стоп (pin/one-shot на удалённый/остывающий/требующий входа аккаунт) шёл с
// id=0 БЕЗ owner'а — роутер дропал его на `if (!owner) return`, и человек видел только
// общий «провайдер недоступен» вместо настоящей причины и выхода из тупика.
// ─────────────────────────────────────────────────────────────────────────────
describe('2.1.3-CD: route-changed и ранние маршрутные стопы', () => {
  beforeEach(() => {
    // earlyRouteStop живёт в глобальном zustand и протекает между тестами файла —
    // внешний beforeEach его не знает (поле новое). Сбрасываем здесь.
    useProject.setState({ earlyRouteStop: null, chatSnapshots: {} }, false)
  })

  it('route-changed (ротация аккаунта) → activity с именами аккаунтов и причиной', () => {
    mountChat()
    startRun(201, 7)
    act(() => {
      mock.aiEvents.emit({
        id: 201,
        event: {
          type: 'route-changed', action: 'rotate-account', reason: 'quota', attempt: 1,
          requested: { providerId: 'claude-cli', model: 'auto' },
          actual: { providerId: 'claude-cli', model: 'auto' },
          resetAt: null,
          accounts: { fromLabel: 'Рабочий Max', toLabel: 'Личный Max' },
        },
      })
    })
    const a = useProject.getState().activity.at(-1)
    expect(a?.kind).toBe('route')
    expect(a?.label).toBe('⇄ Аккаунт Рабочий Max → Личный Max')
    expect(a?.detail).toContain('квота исчерпана')
    // внутренние id аккаунтов нигде не светятся
    expect(a?.label).not.toMatch(/\bid\b/)
  })

  it('route-changed (model-fallback) → другая подпись: провайдеры, не аккаунты', () => {
    mountChat()
    startRun(202, 7)
    act(() => {
      mock.aiEvents.emit({
        id: 202,
        event: {
          type: 'route-changed', action: 'model-fallback', reason: 'provider-unavailable', attempt: 2,
          requested: { providerId: 'gemini-api', model: 'gemini-3-flash' },
          actual: { providerId: 'claude', model: 'claude-sonnet' },
          resetAt: null, accounts: null,
        },
      })
    })
    const a = useProject.getState().activity.at(-1)
    expect(a?.kind).toBe('route')
    expect(a?.label).toBe('⚡ gemini-api → claude')
    expect(a?.detail).toContain('claude-sonnet')
  })

  it('ранний стоп АКТИВНОГО чата (id=0, owner нет) → причина сохраняется для send(), не дропается', () => {
    mountChat()
    act(() => {
      mock.aiEvents.emit({
        id: 0, chatId: 7,
        event: { type: 'error', message: 'Аккаунт «Личный Max» остывает после лимита · срок неизвестен. Выберите другой аккаунт или Auto.' },
      })
    })
    // send() подхватит точную причину вместо общего «провайдер недоступен»
    expect(useProject.getState().earlyRouteStop).toMatchObject({ chatId: 7 })
    expect(useProject.getState().earlyRouteStop?.message).toContain('Личный Max')
    // в ленту активного чата при этом ничего не прилипло (её допишет сам send)
    expect(useProject.getState().messages).toHaveLength(0)
    expect(mock.aiEvents.lostEvents).toBe(0)
  })

  it('ранний стоп ФОНОВОГО чата → уходит в его snapshot (персист), активный не трогается', () => {
    mountChat()
    act(() => {
      mock.aiEvents.emit({
        id: 0, chatId: 9,
        event: { type: 'error', message: 'Выбранный на один запрос аккаунт был удалён.' },
      })
    })
    // активному чату (7) ничего не досталось
    expect(useProject.getState().earlyRouteStop).toBeNull()
    expect(useProject.getState().messages).toHaveLength(0)
    // фоновый чат получил событие в snapshot — при открытии причина будет видна
    const snap = useProject.getState().chatSnapshots[9]
    expect(snap).toBeTruthy()
    expect(snap.hasUnread).toBe(true)
  })

  it('error с id=0 БЕЗ chatId (легаси/непонятное) → по-прежнему дропается молча', () => {
    mountChat()
    act(() => { mock.aiEvents.emit({ id: 0, event: { type: 'error', message: 'странное' } }) })
    expect(useProject.getState().earlyRouteStop).toBeNull()
    expect(useProject.getState().messages).toHaveLength(0)
  })
})
