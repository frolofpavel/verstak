/**
 * P3 кусок 3: TASK-SCOPED ИЗОЛИРОВАННАЯ СЕССИЯ (Playwright).
 *
 * Живёт РЯДОМ со встроенным браузером, не вместо него. Одна сессия на прогон
 * (`sendId`), свой эфемерный профиль, гарантированное закрытие вместе с задачей.
 *
 * ПОЧЕМУ ОДНА РЕАЛИЗАЦИЯ СТРАНИЧНОЙ ЛОГИКИ, А НЕ ВТОРАЯ. Снимок, поиск, разрешение
 * номера, ввод и нажатие берутся из `shared/browser-snapshot` и инжектируются в
 * страницу ТЕМ ЖЕ способом (`fn.toString()`), что и во встроенном браузере. Значит
 * номера, подписи, роли, тексты ошибок и границы бюджетов совпадают ПО ПОСТРОЕНИЮ, а
 * не по внимательности автора правки. Вторая копия рано или поздно разошлась бы, и
 * разошлась бы молча: пины стерегли бы одну из них (§3.1).
 *
 * КУКИ И ВХОДЫ ЧЕЛОВЕКА СЮДА НЕ ПОПАДАЮТ — и это не «мы стараемся», а свойство
 * запуска: `chromium.launch()` заводит НОВЫЙ временный профиль и удаляет его при
 * закрытии, `newContext()` без `storageState` начинается с нуля. Мы нигде не
 * указываем `userDataDir`, не зовём `launchPersistentContext`, не читаем профиль
 * пользователя и не копируем его данные (прямой запрет постановки).
 *
 * ЗАКРЫТИЕ ГАРАНТИРОВАНО ЧЕТЫРЬМЯ ПУТЯМИ (урок C7: обрыв не должен оставлять
 * процессов). Один путь — это надежда, а не гарантия:
 *   1. штатный конец прогона — `cleanup()` в `ipc/ai.ts`;
 *   2. остановка/прерывание — `AbortSignal` прогона;
 *   3. выход из приложения — `closeAllIsolatedSessions()` на `before-quit`;
 *   4. смерть самого браузера — событие `disconnected` чистит реестр,
 *      иначе следующий прогон переиспользовал бы труп.
 * Плюс закрытие идёт с ПОТОЛКОМ ожидания: висящий `close()` не должен превращать
 * выход из приложения в зависание.
 */

import { randomUUID } from 'crypto'
import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright-core'
import {
  vskSnapshot, vskResolveNumbered, vskFill, vskPressKey, vskMatchTarget, vskFind, vskCapSnapshot,
  VSK_SNAPSHOT_TOP_N, type CappedSnapshot, type FindResult,
} from '../../shared/browser-snapshot'
import { normalizeAgentUrl, DEFAULT_BROWSER_ENV, type BrowserEnv } from '../../shared/browser-env'
import { resolveBrowserExecutable, type BrowserSourceKind } from './isolated-launch'
import { logRuntime } from '../runtime-log'

/** Ключ сессии — прогон (`sendId`). Одна задача = одна изолированная сессия. */
export type IsolatedKey = number

type Ok = { ok: true; url: string | null }
type Fail = { ok: false; error: string }

/**
 * Поверхность страницы. ФОРМА ТА ЖЕ, что у `window.verstakBrowser` встроенного пути —
 * сознательно: диспетчер инструментов зовёт одинаковые методы, различая только
 * получателя. Расхождение формы означало бы второй набор инструментов.
 */
export interface IsolatedBrowserApi {
  navigate(url: string): Promise<{ ok: true; url: string } | Fail>
  readPage(selector?: string): Promise<string>
  click(selector: string): Promise<Ok | Fail>
  snapshot(): Promise<CappedSnapshot | { error: string }>
  find(query: string, limit?: number): Promise<FindResult | { error: string }>
  clickByNumber(n: number): Promise<Ok | Fail>
  typeByNumber(n: number, text: string): Promise<Ok | Fail>
  pressKey(key: string, n?: number): Promise<{ ok: true; submitted: boolean; url: string | null } | Fail>
  waitFor(query: string, timeoutMs?: number): Promise<{ ok: true } | Fail>
  /** Форма записи — `{ level, text, line, source }`: ровно то, что читает
   *  `browser-redact.redactConsoleMessage`. Иначе редактор вернул бы пустой текст. */
  consoleMessages(): Promise<Array<{ level: string; text: string; line?: number; source?: string }>>
  networkRequests(): Promise<Array<Record<string, unknown>>>
  screenshot(): Promise<string>
  getURL(): string | null
  getTitle(): string | null
}

export interface IsolatedSession {
  readonly id: string
  readonly api: IsolatedBrowserApi
  /** След происхождения браузера — едет в ответ `browser_navigate`, чтобы человек и
   *  модель видели, ЧЕМ и КАК подняли сессию, а не гадали. */
  readonly info: { browserLabel: string; source: BrowserSourceKind; headless: boolean }
  close(): Promise<void>
  /** Четвёртый путь закрытия: браузер умер сам (упал, убит извне). Без этого реестр
   *  хранил бы труп, и следующий `browser_navigate` «переиспользовал» бы его. */
  onGone?(cb: () => void): void
}

export type OpenIsolatedResult =
  | { ok: true; session: IsolatedSession; reused: boolean }
  | { ok: false; error: string }

/** Подмена запуска (тесты): позволяет проверить маршрутизацию и гейты без браузера. */
export type IsolatedLauncher = (opts: { headless: boolean }) => Promise<OpenIsolatedResult>

let launcher: IsolatedLauncher | null = null
/** Только для тестов: подставить фиктивный запуск. `null` возвращает настоящий. */
export function setIsolatedLauncher(fn: IsolatedLauncher | null): void {
  launcher = fn
}

const sessions = new Map<IsolatedKey, IsolatedSession>()
/** Гонка двойного открытия: два подряд `browser_navigate` не должны поднять два браузера. */
const opening = new Map<IsolatedKey, Promise<OpenIsolatedResult>>()

const CLOSE_TIMEOUT_MS = 5000
const LAUNCH_TIMEOUT_MS = 30_000
const CONSOLE_CAP = 200
const NETWORK_CAP = 100

/** Headed — свойство ЗАПУСКА, не отдельный продуктовый режим (постановка). */
function wantHeaded(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['VERSTAK_BROWSER_HEADED'] || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

// ── страничная логика: ТЕ ЖЕ исходники, что во встроенном браузере ──────────────
// Сниппеты собраны здесь, чтобы обе среды инжектировали идентичный код (см. шапку).

function snapshotCode(gen: string): string {
  return `(() => {
    const snapshot = ${vskSnapshot.toString()};
    const cap = ${vskCapSnapshot.toString()};
    return cap(snapshot(${JSON.stringify(gen)}), ${VSK_SNAPSHOT_TOP_N});
  })()`
}

function findCode(gen: string, query: string, limit: number): string {
  return `(() => {
    const snapshot = ${vskSnapshot.toString()};
    const find = ${vskFind.toString()};
    return find(snapshot(${JSON.stringify(gen)}), ${JSON.stringify(query)}, ${limit});
  })()`
}

function clickByNumberCode(n: number): string {
  return `(() => {
    const resolve = ${vskResolveNumbered.toString()};
    const r = resolve(${JSON.stringify(n)});
    if (!r.ok) return r;
    try { r.el.scrollIntoView({ block: 'center' }); } catch (e) {}
    if (typeof r.el.click === 'function') r.el.click();
    else r.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { ok: true, url: location.href };
  })()`
}

function typeByNumberCode(n: number, text: string): string {
  return `(() => {
    const resolve = ${vskResolveNumbered.toString()};
    const fill = ${vskFill.toString()};
    const r = resolve(${JSON.stringify(n)});
    if (!r.ok) return r;
    const f = fill(r.el, ${JSON.stringify(text)});
    if (!f.ok) return f;
    return { ok: true, url: location.href };
  })()`
}

function pressKeyCode(key: string, n?: number): string {
  const target = n != null
    ? `(() => { const r = resolve(${JSON.stringify(n)}); return r.ok ? r.el : r; })()`
    : `(document.activeElement && document.activeElement !== document.body ? document.activeElement : null)`
  return `(() => {
    const resolve = ${vskResolveNumbered.toString()};
    const press = ${vskPressKey.toString()};
    const t = ${target};
    if (!t) return { ok: false, error: 'Нет поля в фокусе: сначала введи текст (browser_type_by_number) или укажи номер поля.' };
    if (t.ok === false) return t;
    const r = press(t, ${JSON.stringify(key)});
    if (!r.ok) return r;
    return { ok: true, submitted: r.submitted, url: location.href };
  })()`
}

function clickBySelectorCode(selector: string): string {
  const sel = JSON.stringify(selector)
  return `(() => {
    let el = document.querySelector(${sel});
    if (!el) {
      const t = ${sel}.trim().toLowerCase();
      el = [...document.querySelectorAll('a,button,[role=button],input[type=submit]')]
        .find(n => (n.innerText || n.value || '').trim().toLowerCase().includes(t));
    }
    if (!el) return { ok: false, error: 'элемент не найден: ' + ${sel} };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, url: location.href };
  })()`
}

function newGen(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// ── реализация API поверх страницы Playwright ──────────────────────────────────

interface Buffers {
  console: Array<{ level: string; text: string; line?: number; source?: string }>
  network: Array<Record<string, unknown>>
  title: string
}

function makeApi(page: Page, buffers: Buffers): IsolatedBrowserApi {
  const evalPage = async (code: string): Promise<unknown> => page.evaluate(code)
  const fail = (e: unknown): Fail => ({ ok: false, error: e instanceof Error ? e.message : String(e) })

  return {
    async navigate(url) {
      const norm = normalizeAgentUrl(url)
      if (!norm.ok) return { ok: false, error: norm.error }
      try {
        // Буферы чистятся на КАЖДОЙ навигации: новая страница — свой лог. Ровно то же
        // делает встроенный путь (did-start-loading → сброс), иначе «ошибки консоли
        // этой страницы» включали бы чужие.
        buffers.console.length = 0
        buffers.network.length = 0
        await page.goto(norm.url, { waitUntil: 'domcontentloaded' })
        buffers.title = await page.title().catch(() => '')
        return { ok: true, url: page.url() }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    async readPage(selector) {
      const code = selector
        ? `(document.querySelector(${JSON.stringify(selector)})?.innerText) || ''`
        : `(document.body?.innerText || '').slice(0, 50000)`
      try {
        const r = await evalPage(code)
        return typeof r === 'string' ? r : ''
      } catch { return '' }
    },
    async click(selector) {
      try {
        const r = await evalPage(clickBySelectorCode(selector)) as Ok | Fail
        return r && typeof r === 'object' ? r : { ok: false, error: 'нет ответа' }
      } catch (e) { return fail(e) }
    },
    async snapshot() {
      try {
        const r = await evalPage(snapshotCode(newGen()))
        return (r && typeof r === 'object') ? r as CappedSnapshot : { error: 'снимок не удался' }
      } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
    },
    async find(query, limit) {
      const lim = Math.min(Math.max(1, limit ?? 30), 100)
      try {
        const r = await evalPage(findCode(newGen(), query, lim))
        return (r && typeof r === 'object') ? r as FindResult : { error: 'поиск не удался' }
      } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
    },
    async clickByNumber(n) {
      try {
        const r = await evalPage(clickByNumberCode(n)) as Ok | Fail
        return r && typeof r === 'object' ? r : { ok: false, error: 'нет ответа' }
      } catch (e) { return fail(e) }
    },
    async typeByNumber(n, text) {
      try {
        const r = await evalPage(typeByNumberCode(n, text)) as Ok | Fail
        return r && typeof r === 'object' ? r : { ok: false, error: 'нет ответа' }
      } catch (e) { return fail(e) }
    },
    async pressKey(key, n) {
      try {
        const r = await evalPage(pressKeyCode(key, n)) as { ok: true; submitted: boolean; url: string | null } | Fail
        return r && typeof r === 'object' ? r : { ok: false, error: 'нет ответа' }
      } catch (e) { return fail(e) }
    },
    async waitFor(query, timeoutMs) {
      // Тот же опрос с ЧЕСТНЫМ таймаутом и тем же текстом отказа, что у встроенного:
      // разные формулировки на разных средах модель читала бы как разные дефекты.
      const budget = Math.min(Math.max(500, timeoutMs ?? 10_000), 30_000)
      const started = Date.now()
      const check = `(${vskMatchTarget.toString()})(${JSON.stringify(query)})`
      while (Date.now() - started < budget) {
        try {
          if (await evalPage(check) === true) return { ok: true }
        } catch { /* страница между переходами — повторим */ }
        await new Promise(r => setTimeout(r, 200))
      }
      return { ok: false, error: `Элемент «${query}» не появился за ${Math.round(budget / 1000)} с.` }
    },
    async consoleMessages() {
      return buffers.console.slice()
    },
    async networkRequests() {
      return buffers.network.slice()
    },
    async screenshot() {
      try {
        const buf = await page.screenshot({ type: 'png' })
        return 'data:image/png;base64,' + Buffer.from(buf).toString('base64')
      } catch { return '' }
    },
    getURL() {
      try { return page.url() } catch { return null }
    },
    getTitle() {
      return buffers.title || null
    },
  }
}

// ── запуск настоящей сессии ────────────────────────────────────────────────────

async function realLaunch(opts: { headless: boolean }): Promise<OpenIsolatedResult> {
  let pw: typeof import('playwright-core')
  try {
    // Динамический импорт: 13-мегабайтный драйвер не грузится, пока изолированную
    // сессию не попросили. Отсутствие модуля — честная причина, а не крах старта.
    pw = await import('playwright-core')
  } catch (e) {
    return { ok: false, error: `Модуль playwright-core недоступен: ${e instanceof Error ? e.message : String(e)}` }
  }
  const found = resolveBrowserExecutable({ playwrightExecutablePath: () => {
    try { return pw.chromium.executablePath() } catch { return null }
  } })
  if (!found.ok) return { ok: false, error: found.error }

  let browser: Browser
  try {
    browser = await pw.chromium.launch({
      headless: opts.headless,
      executablePath: found.browser.executablePath,
      timeout: LAUNCH_TIMEOUT_MS,
      args: ['--no-first-run', '--no-default-browser-check'],
    })
  } catch (e) {
    return {
      ok: false,
      error: `Не удалось запустить ${found.browser.label} (${found.browser.executablePath}): ` +
             `${e instanceof Error ? e.message : String(e)}`,
    }
  }

  let context: BrowserContext
  let page: Page
  try {
    // Ни storageState, ни userDataDir — профиль пустой и временный по построению.
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    page = await context.newPage()
  } catch (e) {
    await browser.close().catch(() => {})
    return { ok: false, error: `Не удалось создать чистый контекст: ${e instanceof Error ? e.message : String(e)}` }
  }

  const buffers: Buffers = { console: [], network: [], title: '' }
  const pushConsole = (rec: { level: string; text: string; line?: number; source?: string }) => {
    buffers.console.push(rec)
    if (buffers.console.length > CONSOLE_CAP) buffers.console.splice(0, buffers.console.length - CONSOLE_CAP)
  }
  page.on('console', (msg: ConsoleMessage) => {
    const loc = msg.location()
    pushConsole({ level: msg.type(), text: msg.text(), line: loc?.lineNumber, source: loc?.url })
  })
  // Необработанное исключение страницы — самая ценная ошибка при проверке своей
  // правки, и в console-событие оно не приходит. Метим как error явно.
  page.on('pageerror', err => pushConsole({ level: 'error', text: err.message }))
  page.on('response', res => {
    const req = res.request()
    const timing = req.timing()
    buffers.network.push({
      method: req.method(),
      url: res.url(),
      status: res.status(),
      headers: req.headers(),
      durationMs: timing && timing.responseEnd > 0 ? timing.responseEnd : null,
    })
    if (buffers.network.length > NETWORK_CAP) buffers.network.splice(0, buffers.network.length - NETWORK_CAP)
  })
  page.on('requestfailed', req => {
    buffers.network.push({ method: req.method(), url: req.url(), status: 0, headers: req.headers(), durationMs: null })
    if (buffers.network.length > NETWORK_CAP) buffers.network.splice(0, buffers.network.length - NETWORK_CAP)
  })

  const session: IsolatedSession = {
    id: randomUUID(),
    api: makeApi(page, buffers),
    info: { browserLabel: found.browser.label, source: found.browser.source, headless: opts.headless },
    async close() {
      // Потолок ожидания: висящее закрытие не должно держать выход из приложения.
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise<void>(r => setTimeout(r, CLOSE_TIMEOUT_MS)),
      ])
    },
    onGone(cb) { browser.on('disconnected', cb) },
  }
  return { ok: true, session, reused: false }
}

// ── реестр сессий ──────────────────────────────────────────────────────────────

export function getIsolatedSession(key: IsolatedKey): IsolatedSession | undefined {
  return sessions.get(key)
}

/**
 * АКТИВНАЯ СРЕДА ПРОГОНА. Живёт рядом с сессией, потому что это одно состояние: пока
 * прогон работает в чистой сессии, вызов без `env` обязан попадать туда же (рамка
 * волны §4 — молчаливая смена среды запрещена). Закрытие сессии возвращает прогон во
 * встроенный браузер, и это не «умолчание», а следствие: чистой сессии больше нет.
 */
const activeEnv = new Map<IsolatedKey, BrowserEnv>()

export function getActiveBrowserEnv(key: IsolatedKey): BrowserEnv {
  return activeEnv.get(key) ?? DEFAULT_BROWSER_ENV
}

export function setActiveBrowserEnv(key: IsolatedKey, env: BrowserEnv): void {
  if (env === DEFAULT_BROWSER_ENV) activeEnv.delete(key)
  else activeEnv.set(key, env)
}

export function isolatedSessionCount(): number {
  return sessions.size
}

export interface OpenIsolatedOptions {
  /** Прерывание прогона — второй из четырёх путей закрытия (см. шапку). */
  signal?: AbortSignal
  headless?: boolean
}

/**
 * Поднять изолированную сессию прогона или переиспользовать уже поднятую
 * (`reused: true`). Явный create/reuse: второй `browser_navigate` с той же средой
 * не заводит второй браузер.
 */
export async function openIsolatedSession(key: IsolatedKey, opts: OpenIsolatedOptions = {}): Promise<OpenIsolatedResult> {
  const existing = sessions.get(key)
  if (existing) return { ok: true, session: existing, reused: true }
  const inFlight = opening.get(key)
  if (inFlight) return inFlight

  const headless = opts.headless ?? !wantHeaded()
  const task = (launcher ?? realLaunch)({ headless })
    .then(res => {
      if (!res.ok) return res
      // Прогон мог быть прерван, ПОКА браузер поднимался: тогда закрываем сразу и не
      // регистрируем — иначе остался бы процесс, которого никто уже не закроет.
      if (opts.signal?.aborted) {
        void res.session.close()
        return { ok: false as const, error: 'Прогон остановлен — изолированная сессия закрыта.' }
      }
      sessions.set(key, res.session)
      opts.signal?.addEventListener('abort', () => { void closeIsolatedSession(key) }, { once: true })
      // Труп из реестра убираем СРАЗУ, но только если это всё ещё та же сессия:
      // иначе поздний `disconnected` от старого браузера выбросил бы новый.
      res.session.onGone?.(() => { if (sessions.get(key) === res.session) sessions.delete(key) })
      logRuntime('browser.isolated.open', {
        key, sessionId: res.session.id, browser: res.session.info.browserLabel,
        source: res.session.info.source, headless: res.session.info.headless,
      })
      return res
    })
    .catch(e => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => { opening.delete(key) })

  opening.set(key, task)
  return task
}

/** Закрыть сессию прогона. `true` — что-то закрыли. Идемпотентна. */
export async function closeIsolatedSession(key: IsolatedKey): Promise<boolean> {
  const s = sessions.get(key)
  // Среда сбрасывается ВСЕГДА, даже если сессии уже нет: иначе прогон остался бы
  // «в чистой сессии», которой не существует, и следующий вызов упёрся бы в отказ.
  activeEnv.delete(key)
  if (!s) return false
  sessions.delete(key)
  try { await s.close() } catch { /* закрытие не должно ломать вызывающего */ }
  logRuntime('browser.isolated.close', { key, sessionId: s.id })
  return true
}

/** Закрыть ВСЕ сессии (выход из приложения). Возвращает число закрытых. */
export async function closeAllIsolatedSessions(): Promise<number> {
  const keys = [...sessions.keys()]
  await Promise.all(keys.map(k => closeIsolatedSession(k)))
  return keys.length
}
