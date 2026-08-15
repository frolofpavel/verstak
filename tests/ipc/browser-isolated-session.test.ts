// P3 кусок 3 · ЖИЗНЕННЫЙ ЦИКЛ чистой сессии и полнота её набора действий.
//
// ГЛАВНОЕ, ЧТО ЗДЕСЬ СТЕРЕЖЁТСЯ, — «сессия умирает вместе с задачей». Урок C7 звучит
// как «обрыв не должен оставлять процессов», и проверять его надо не одним путём, а
// каждым: штатный конец, прерывание, выход из приложения. Один рабочий путь из трёх
// выглядит как гарантия и ею не является.
//
// Второе — ПОЛНОТА. Вторая среда обязана уметь ровно то же, что первая. Список
// действий один (BROWSER_ACTION_TOOLS), и пин прогоняет по нему оба диспетчера:
// забытый инструмент краснеет здесь, а не превращается в молчаливый скриншот у
// пользователя.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { browserHandler, BROWSER_ACTION_TOOLS } from '../../electron/ipc/tool-handlers/browser'
import {
  setIsolatedLauncher, closeAllIsolatedSessions, closeIsolatedSession, openIsolatedSession,
  getIsolatedSession, getActiveBrowserEnv, isolatedSessionCount,
  type IsolatedBrowserApi, type IsolatedSession,
} from '../../electron/browser/isolated-session'
import { readCapture } from '../../electron/browser/network-capture'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

// ОБЩЕСЕССИОННЫЙ ЗАХВАТ СЕТИ НАБИТ ЧУЖИМ ТРАФИКОМ НАМЕРЕННО. Без этого пин «сеть
// чистой сессии — только своя» был бы ложно-зелёным: в тестовой среде настоящий
// захват пуст, и подмешивать было бы нечего. Теперь есть что подмешать — значит
// утверждение действительно что-то измеряет.
vi.mock('../../electron/browser/network-capture', () => ({
  readCapture: vi.fn(() => [
    { method: 'POST', url: 'https://кабинет-человека.ru/api/pay', status: 200, headers: { cookie: 'session=1' }, durationMs: 12 },
  ]),
}))

function fakeSession(onClose?: () => void) {
  const hit = vi.fn()
  const api: IsolatedBrowserApi = {
    navigate: async (url: string) => { hit('navigate', url); return { ok: true as const, url } },
    readPage: async () => { hit('readPage'); return 'текст страницы' },
    click: async () => { hit('click'); return { ok: true as const, url: 'https://iso/' } },
    snapshot: async () => { hit('snapshot'); return { gen: 'g', count: 1, shown: 1, truncated: false, elements: [{ n: 1, tag: 'button', role: 'button', name: 'Найти' }] } },
    find: async (q: string) => { hit('find'); return { query: q, count: 1, totalHits: 1, total: 1, truncated: false, matches: [{ n: 1, tag: 'button', role: 'button', name: 'Найти' }] } },
    clickByNumber: async () => { hit('clickByNumber'); return { ok: true as const, url: 'https://iso/' } },
    typeByNumber: async () => { hit('typeByNumber'); return { ok: true as const, url: 'https://iso/' } },
    pressKey: async () => { hit('pressKey'); return { ok: true as const, submitted: true, url: 'https://iso/' } },
    waitFor: async () => { hit('waitFor'); return { ok: true as const } },
    consoleMessages: async () => { hit('consoleMessages'); return [{ level: 'error', text: 'сломалось в чистой сессии' }] },
    networkRequests: async () => { hit('networkRequests'); return [{ method: 'GET', url: 'http://localhost:5173/api', status: 200, headers: {}, durationMs: 5 }] },
    screenshot: async () => { hit('screenshot'); return '' },
    getURL: () => 'http://localhost:5173/',
    getTitle: () => 'dev',
  }
  const session: IsolatedSession = {
    id: 'sess-' + Math.random().toString(36).slice(2),
    api,
    info: { browserLabel: 'Fake Edge', source: 'system', headless: true },
    close: async () => { onClose?.() },
  }
  return { session, hit }
}

let seq = 7000
function ctxFor(overrides: Partial<ToolContext> = {}) {
  const exec = vi.fn(async () => ({ ok: true, url: 'https://builtin/' }))
  const ctx = {
    projectPath: 'C:/proj',
    sendId: ++seq,
    runId: 'run-life',
    agentMode: 'bypass',
    signal: new AbortController().signal,
    sender: { send: vi.fn(), exec },
    pendingAttachments: [],
    pendingCommands: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    recordJournal: vi.fn(),
    recordRunEvent: () => {},
    ...overrides,
  } as unknown as ToolContext
  return { ctx, exec }
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, args })

afterEach(async () => {
  setIsolatedLauncher(null)
  await closeAllIsolatedSessions()
})

describe('чистая сессия: create · reuse · close', () => {
  it('второй navigate в той же среде ПЕРЕИСПОЛЬЗУЕТ сессию, а не поднимает вторую', async () => {
    const launched = vi.fn()
    const { session } = fakeSession()
    setIsolatedLauncher(async () => { launched(); return { ok: true, session, reused: false } })
    const { ctx } = ctxFor()

    const first = await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx)
    const second = await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173/about' }), ctx)

    expect(launched, 'подняли второй браузер вместо переиспользования').toHaveBeenCalledTimes(1)
    // След подъёма ставится один раз — на создании, не на каждом переходе.
    expect((first.result as Record<string, unknown>).session).toMatch(/Fake Edge/)
    expect((second.result as Record<string, unknown>).session).toBeUndefined()
    expect(isolatedSessionCount()).toBe(1)
  })

  it('два одновременных navigate поднимают ОДИН браузер (гонка открытия закрыта)', async () => {
    const launched = vi.fn()
    const { session } = fakeSession()
    setIsolatedLauncher(async () => {
      launched()
      await new Promise(r => setTimeout(r, 20))
      return { ok: true, session, reused: false }
    })
    const { ctx } = ctxFor()

    await Promise.all([
      browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx),
      browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx),
    ])

    expect(launched).toHaveBeenCalledTimes(1)
  })

  it('browser_close_session закрывает сессию и возвращает прогон во встроенный браузер', async () => {
    const closed = vi.fn()
    const { session } = fakeSession(closed)
    setIsolatedLauncher(async () => ({ ok: true, session, reused: false }))
    const { ctx, exec } = ctxFor()

    await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx)
    expect(getActiveBrowserEnv(ctx.sendId)).toBe('isolated')

    const res = await browserHandler.handle(call('browser_close_session'), ctx)

    expect(closed, 'браузер не закрыт').toHaveBeenCalled()
    expect((res.result as Record<string, unknown>).closed).toBe(true)
    expect(getIsolatedSession(ctx.sendId)).toBeUndefined()
    expect(getActiveBrowserEnv(ctx.sendId), 'после закрытия прогон обязан вернуться во встроенный').toBe('builtin')

    // И следующий вызов без env идёт уже во встроенный — то есть закрытие
    // действительно переключило среду, а не только освободило процесс.
    await browserHandler.handle(call('browser_read_page'), ctx)
    expect(exec, 'после закрытия чтение не ушло во встроенный браузер').toHaveBeenCalled()
  })

  it('закрытие несуществующей сессии — честный closed=false, а не ошибка', async () => {
    const { ctx } = ctxFor()
    const res = await browserHandler.handle(call('browser_close_session'), ctx)
    expect(res.error).toBeFalsy()
    expect((res.result as Record<string, unknown>).closed).toBe(false)
  })

  // ПУТЬ 2 из четырёх: прерывание прогона. Проверяется на самом реестре, а не через
  // хендлер: сигнал приходит извне и в любой момент.
  it('прерывание прогона закрывает сессию (AbortSignal)', async () => {
    const closed = vi.fn()
    const { session } = fakeSession(closed)
    setIsolatedLauncher(async () => ({ ok: true, session, reused: false }))
    const ctrl = new AbortController()

    await openIsolatedSession(4242, { signal: ctrl.signal })
    expect(isolatedSessionCount()).toBe(1)
    ctrl.abort()
    await new Promise(r => setTimeout(r, 0))

    expect(closed, 'после остановки прогона браузер остался жить').toHaveBeenCalled()
    expect(isolatedSessionCount()).toBe(0)
  })

  // Отдельный случай той же аварии: прогон остановили ПОКА браузер поднимался. Без
  // этой ветки процесс регистрировался бы уже после отмены — и закрыть его было бы
  // некому (ровно «осиротевший процесс» из урока C7).
  it('остановка ВО ВРЕМЯ подъёма закрывает поднявшийся браузер и не регистрирует его', async () => {
    const closed = vi.fn()
    const { session } = fakeSession(closed)
    const ctrl = new AbortController()
    setIsolatedLauncher(async () => {
      ctrl.abort()
      return { ok: true, session, reused: false }
    })

    const res = await openIsolatedSession(4243, { signal: ctrl.signal })

    expect(res.ok, 'подъём при отменённом прогоне обязан быть отказом').toBe(false)
    expect(closed, 'браузер, поднятый после отмены, не закрыт — это осиротевший процесс').toHaveBeenCalled()
    expect(isolatedSessionCount()).toBe(0)
  })

  // ПУТЬ 3: выход из приложения.
  it('closeAllIsolatedSessions закрывает все сессии (выход из приложения)', async () => {
    const closes: string[] = []
    setIsolatedLauncher(async () => {
      const { session } = fakeSession(() => closes.push('x'))
      return { ok: true, session, reused: false }
    })
    await openIsolatedSession(5001)
    await openIsolatedSession(5002)
    expect(isolatedSessionCount()).toBe(2)

    const n = await closeAllIsolatedSessions()

    expect(n).toBe(2)
    expect(closes).toHaveLength(2)
    expect(isolatedSessionCount()).toBe(0)
  })

  // ПУТЬ 4: браузер умер сам. Труп обязан уйти из реестра, иначе следующий
  // navigate «переиспользует» мёртвую сессию и получит невнятный отказ.
  it('умерший браузер вычищается из реестра сам (disconnected)', async () => {
    let fire: (() => void) | null = null
    const { session } = fakeSession()
    const withGone: IsolatedSession = { ...session, onGone: cb => { fire = cb } }
    setIsolatedLauncher(async () => ({ ok: true, session: withGone, reused: false }))

    await openIsolatedSession(6001)
    expect(isolatedSessionCount()).toBe(1)
    fire!()

    expect(isolatedSessionCount(), 'труп остался в реестре').toBe(0)
  })

  it('closeIsolatedSession идемпотентна', async () => {
    const { session } = fakeSession()
    setIsolatedLauncher(async () => ({ ok: true, session, reused: false }))
    await openIsolatedSession(6100)
    expect(await closeIsolatedSession(6100)).toBe(true)
    expect(await closeIsolatedSession(6100)).toBe(false)
  })
})

describe('отказ чистой сессии честен и НЕ подменяется встроенным браузером', () => {
  it('браузер не поднялся — ошибка модели, и ни одного вызова во встроенный', async () => {
    setIsolatedLauncher(async () => ({ ok: false, error: 'браузер на движке Chromium не найден' }))
    const { ctx, exec } = ctxFor()

    const res = await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx)

    expect(res.error).toMatch(/Chromium/)
    expect(exec, 'молча ушли во встроенный браузер — это подмена среды').not.toHaveBeenCalled()
    // И среда НЕ стала изолированной: иначе прогон заперся бы в среде, которой нет.
    expect(getActiveBrowserEnv(ctx.sendId)).toBe('builtin')
  })

  it('действие без открытой сессии — понятная подсказка начать с navigate', async () => {
    const { ctx } = ctxFor()
    const res = await browserHandler.handle(call('browser_find', { query: 'кнопка', env: 'isolated' }), ctx)
    expect(res.error).toMatch(/browser_navigate/)
  })

  it('неизвестная среда останавливает вызов и не идёт ни в одну из них', async () => {
    const { ctx, exec } = ctxFor()
    const res = await browserHandler.handle(call('browser_navigate', { url: 'https://example.com', env: 'chrome' }), ctx)
    expect(res.error).toMatch(/chrome/)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('полнота и различимость сред', () => {
  // АНТИ-ДРЕЙФ: список действий один, и обе среды обязаны покрывать его целиком.
  it('каждое действие из общего списка исполняется в чистой сессии', async () => {
    const argsFor: Record<string, Record<string, unknown>> = {
      browser_navigate: { url: 'http://localhost:5173' },
      browser_read_page: {},
      browser_snapshot: {},
      browser_find: { query: 'найти' },
      browser_click_by_number: { n: 1 },
      browser_type_by_number: { n: 1, text: 'x' },
      browser_press_key: { key: 'Enter' },
      browser_wait_for: { query: '.ready' },
      browser_console_errors: {},
      browser_network: {},
      browser_click: { selector: 'button' },
      browser_screenshot: {},
    }
    for (const tool of BROWSER_ACTION_TOOLS) {
      const { session, hit } = fakeSession()
      setIsolatedLauncher(async () => ({ ok: true, session, reused: false }))
      const { ctx } = ctxFor()
      await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx)
      const res = await browserHandler.handle(call(tool, argsFor[tool] ?? {}), ctx)

      expect(res.error, `${tool} не исполняется в чистой сессии`).toBeFalsy()
      expect(String(res.error ?? ''), `${tool} упал в ветку «не поддержан»`).not.toMatch(/не поддержан/)
      expect(hit.mock.calls.length, `${tool} не дошёл до страницы`).toBeGreaterThan(0)
      expect((res.result as Record<string, unknown>).mode, `${tool} не назвал среду в ответе`).toBe('isolated')
      setIsolatedLauncher(null)
      await closeAllIsolatedSessions()
    }
  })

  // КОНТРОЛЬ С НАСТОЯЩИМ СКРИНШОТОМ. Предыдущий пин прогоняет и browser_screenshot,
  // но подставной api отдаёт пустой dataUrl — а именно НЕПУСТОЙ включает ветку
  // вложения, которая заменяет result.result целиком. На пустом входе утверждение
  // «mode на месте» было зелёным при сломанном продукте (так и было поймано).
  it('mode переживает превращение скриншота во вложение (непустой dataUrl)', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const { session } = fakeSession()
    const withShot: IsolatedSession = {
      ...session,
      api: { ...session.api, screenshot: async () => 'data:image/png;base64,' + png },
    }
    setIsolatedLauncher(async () => ({ ok: true, session: withShot, reused: false }))
    const { ctx } = ctxFor()
    await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx)

    const res = await browserHandler.handle(call('browser_screenshot'), ctx)
    const r = res.result as Record<string, unknown>

    expect(r.attached, 'скриншот не превратился во вложение').toBe(true)
    expect(r.mode, 'среда потерялась при замене результата вложением').toBe('isolated')
    expect((ctx.pendingAttachments as unknown[]).length).toBe(1)
  })

  // КОНТРОЛЬ: во встроенной среде поле mode тоже есть и говорит «builtin» —
  // иначе «поле есть» было бы зелёным у константы.
  it('КОНТРОЛЬ: во встроенной среде mode="builtin"', async () => {
    const { ctx } = ctxFor()
    const res = await browserHandler.handle(call('browser_navigate', { url: 'https://example.com' }), ctx)
    expect((res.result as Record<string, unknown>).mode).toBe('builtin')
  })

  // ЧУЖИЕ ДАННЫЕ В ЧИСТУЮ СЕССИЮ НЕ ПОПАДАЮТ. Встроенный `browser_network` берёт
  // сеть из общесессионного захвата main — то есть из браузера, где человек работал
  // руками. Подмешать её сюда значило бы убить ровно то свойство, ради которого эта
  // среда построена, и убить молча.
  it('сеть чистой сессии — только её собственная, без общесессионного захвата', async () => {
    const { session } = fakeSession()
    setIsolatedLauncher(async () => ({ ok: true, session, reused: false }))
    const { ctx } = ctxFor()
    await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx)

    const res = await browserHandler.handle(call('browser_network'), ctx)
    const requests = (res.result as { requests: Array<{ url: string }> }).requests

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toContain('localhost:5173')
    expect(requests.some(r => r.url.includes('кабинет-человека')),
      'в чистую сессию попал трафик из браузера, где человек работал руками').toBe(false)
  })

  // КОНТРОЛЬ к предыдущему: тот же захват ВИДЕН во встроенной среде. Без этого
  // «чужого нет» было бы зелёным и при полностью отключённом захвате.
  it('КОНТРОЛЬ: во встроенной среде общесессионный захват как раз используется', async () => {
    const { ctx } = ctxFor()
    const res = await browserHandler.handle(call('browser_network'), ctx)
    const requests = (res.result as { requests: Array<{ url: string }> }).requests

    expect(readCapture).toHaveBeenCalled()
    expect(requests.some(r => r.url.includes('кабинет-человека')),
      'встроенная среда перестала видеть общесессионный захват — контроль сломан').toBe(true)
  })

  // Ошибки консоли доходят С ТЕКСТОМ. Форма записи обязана совпадать с тем, что
  // читает редактор (`text`), иначе ошибки пришли бы пустыми — а ради них среда и
  // строилась (§3.1: фикстура должна совпадать с продовой формой).
  it('ошибки консоли чистой сессии доходят до модели с текстом', async () => {
    const { session } = fakeSession()
    setIsolatedLauncher(async () => ({ ok: true, session, reused: false }))
    const { ctx } = ctxFor()
    await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx)

    const res = await browserHandler.handle(call('browser_console_errors'), ctx)
    const messages = (res.result as { messages: Array<{ level: string; text: string }> }).messages

    expect(messages).toHaveLength(1)
    expect(messages[0].level).toBe('error')
    expect(messages[0].text, 'текст ошибки потерялся по дороге к модели').toBe('сломалось в чистой сессии')
  })

  it('журнал называет чистую сессию явно (след смены среды для человека)', async () => {
    const { session } = fakeSession()
    setIsolatedLauncher(async () => ({ ok: true, session, reused: false }))
    const { ctx } = ctxFor()

    await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx)

    const entries = (ctx.recordJournal as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(String(entries.at(-1)?.[2])).toMatch(/чистая сессия/)
  })
})
