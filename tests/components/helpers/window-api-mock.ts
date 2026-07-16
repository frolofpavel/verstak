import { vi } from 'vitest'

/**
 * Мок `window.api` для компонентных тестов (срез 2.0.9-A).
 *
 * ЗАЧЕМ ОДИН НА ВСЕХ: Chat.tsx трогает 18 неймспейсов, Settings — свои; копипастить моки по
 * файлам = дрейф и боль. Этот хелпер послужит всем Chat-хирургиям 2.0.9 и characterization
 * настроек (перенос 2.0.8-A).
 *
 * КАК УСТРОЕН. Явно перечислять ~200 методов бессмысленно (превратится в мёртвый список,
 * который врёт при первом же изменении preload). Вместо этого — прокси с ДВУМЯ правилами,
 * выведенными из реального контракта preload:
 *   · метод с префиксом `on…` — это ПОДПИСКА: обязан вернуть функцию-отписку (её React
 *     использует как cleanup эффекта; вернуть промис = React ругается и cleanup не работает);
 *   · любой другой метод — async, резолвится в undefined (или в значение из overrides).
 * Реальную форму ответа задаёшь через overrides только там, где она важна тесту.
 *
 * `aiEvents` даёт управление потоком событий агента: захватывает хэндлеры `ai.onEvent`,
 * считает подписки/отписки (это ловит класс «диспетчер пересоздался и потерял событие»)
 * и позволяет эмитить события руками.
 */

export interface AiEventPayload {
  id: number
  event: Record<string, unknown> & { type: string }
  projectPath?: string | null
}

export interface AiEventsControl {
  /** Живые хэндлеры ai.onEvent (после отписки удаляются). */
  handlers: Array<(p: AiEventPayload) => void>
  /** Сколько раз подписывались за жизнь теста (норма для Chat — РОВНО 1 за маунт). */
  subscribeCount: number
  /** Сколько раз отписывались. */
  offCount: number
  /** Отправить событие во все живые хэндлеры. Если хэндлеров нет — событие ПОТЕРЯНО (это и ловим). */
  emit: (p: AiEventPayload) => void
  /** Сколько событий ушло в пустоту (ни одного живого хэндлера) — прямой индикатор ловушки №1. */
  lostEvents: number
}

/** Значения по неймспейсам: { chats: { listWindow: async () => ({...}) } }. */
export type ApiOverrides = Record<string, Record<string, unknown>>

export interface ApiMock {
  api: Record<string, unknown>
  aiEvents: AiEventsControl
  /** Все вызовы вида "namespace.method" — для проверки «что дёрнул компонент». */
  calls: Map<string, ReturnType<typeof vi.fn>>
}

const isSubscription = (method: string): boolean => /^on[A-Z]/.test(method)

export function makeApiMock(overrides: ApiOverrides = {}): ApiMock {
  const calls = new Map<string, ReturnType<typeof vi.fn>>()

  const aiEvents: AiEventsControl = {
    handlers: [],
    subscribeCount: 0,
    offCount: 0,
    lostEvents: 0,
    emit(p) {
      if (aiEvents.handlers.length === 0) {
        // Никто не слушает → событие исчезло. Ровно так теряются text/done, когда
        // подписка пересоздаётся между off() и onEvent() (карта 2.0.9-A, ловушка №1).
        aiEvents.lostEvents++
        return
      }
      for (const h of [...aiEvents.handlers]) h(p)
    },
  }

  const makeNamespace = (ns: string): Record<string, unknown> =>
    new Proxy({}, {
      get(_t, prop: string) {
        if (typeof prop !== 'string') return undefined
        const key = `${ns}.${prop}`

        // ai.onEvent — сердце: захватываем хэндлер и считаем подписки/отписки.
        if (ns === 'ai' && prop === 'onEvent') {
          const fn = calls.get(key) ?? vi.fn((cb: (p: AiEventPayload) => void) => {
            aiEvents.handlers.push(cb)
            aiEvents.subscribeCount++
            return () => {
              aiEvents.offCount++
              const i = aiEvents.handlers.indexOf(cb)
              if (i >= 0) aiEvents.handlers.splice(i, 1)
            }
          })
          calls.set(key, fn)
          return fn
        }

        const override = overrides[ns]?.[prop]
        let fn = calls.get(key)
        if (!fn) {
          if (typeof override === 'function') {
            fn = vi.fn(override as (...a: unknown[]) => unknown)
          } else if (isSubscription(prop)) {
            // Подписка обязана вернуть отписку — React ждёт cleanup, не промис.
            fn = vi.fn(() => () => {})
          } else if (override !== undefined) {
            fn = vi.fn(async () => override)
          } else {
            fn = vi.fn(async () => undefined)
          }
          calls.set(key, fn)
        }
        return fn
      },
    })

  const namespaces = new Map<string, Record<string, unknown>>()
  const api = new Proxy({}, {
    get(_t, ns: string) {
      if (typeof ns !== 'string') return undefined
      let n = namespaces.get(ns)
      if (!n) { n = makeNamespace(ns); namespaces.set(ns, n) }
      return n
    },
  })

  return { api: api as Record<string, unknown>, aiEvents, calls }
}

/**
 * Дефолты форм, без которых Chat падает или ведёт себя неестественно на маунте.
 * Правило: сюда попадает только то, чью ФОРМУ читает код (обращается к полю ответа).
 * Всё остальное прекрасно живёт с `undefined` из прокси — не раздуваем список.
 */
export const CHAT_API_DEFAULTS: ApiOverrides = {
  // WorktreeBar (дочерний компонент Chat) читает status.active сразу — undefined роняет рендер.
  worktree: { status: async () => ({ active: false }) },
  // ModelPicker итерирует каталог провайдеров (for..of) — undefined роняет рендер.
  providers: { list: async () => [], catalogStatus: async () => null },
  // Оконная загрузка истории (фича Ильи, reapply-2.0.7).
  chats: { listWindow: async () => ({ messages: [], totalCount: 0, hasMoreBefore: false }), list: async () => [] },
  chatSessions: { list: async () => [], listReviews: async () => [] },
  agentRuns: { list: async () => [], sessionStats: async () => null },
  settings: { getKey: async () => null },
  skills: { list: async () => [] },
  undo: { count: async () => 0 },
  suggestions: { get: async () => [] },
  files: { tree: async () => [] },
  app: { getVersion: async () => '2.0.8', isFocused: async () => true },
}
