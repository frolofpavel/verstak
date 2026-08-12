import { useEffect, useRef, useState } from 'react'
// VSK-BROWSER-B1 этап 1: ЕДИНЫЙ исходник page-логики (тот же, что в jsdom-пинах,
// §3.1). Инжектим в webview через executeJavaScript(`(${fn.toString()})(...)`).
import { vskSnapshot, vskResolveNumbered, vskFill, vskPressKey, vskMatchTarget, vskFind, vskCapSnapshot, VSK_SNAPSHOT_TOP_N, type PageSnapshot, type CappedSnapshot, type FindResult } from '../../shared/browser-snapshot'

/**
 * In-app browser. Uses Electron's <webview> tag (enabled via webviewTag: true
 * in main.ts). The webview runs in its own renderer process so the host app
 * stays responsive even if a page hangs.
 *
 * AI tools (browser_navigate, browser_read_page, browser_screenshot) talk to
 * this view through window.verstakBrowser, which is set on the global
 * window object when the BrowserView mounts. This is a renderer-side
 * extension point — see useEffect below.
 */

// Пустая домашняя страница — как browser-панель Claude Code, а не поисковик.
// Стартового Google быть не должно: он в одиночку создавал впечатление «это просто
// хром», ради снятия которого построен весь браузер-пакет (VSK-BROWSER-B1).
const HOMEPAGE = 'about:blank'
// SEARCH_URL остаётся: он для РУЧНОГО ввода не-URL в адресную строку (удобство
// человека), а не для стартового экрана. Убрать значит отнять функцию.
const SEARCH_URL = 'https://www.google.com/search?q='

// Minimal subset of the Electron webview API we use.
interface Webview extends HTMLElement {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  getURL(): string
  getTitle(): string
  executeJavaScript: (code: string) => Promise<unknown>
  loadURL: (url: string) => Promise<void>
  capturePage: () => Promise<{ toDataURL(): string }>
}

declare global {
  interface Window {
    verstakBrowser?: {
      navigate: (url: string) => Promise<{ ok: true; url: string } | { ok: false; error: string }>
      readPage: (selector?: string) => Promise<string>
      click: (selector: string) => Promise<{ ok: true; url: string | null } | { ok: false; error: string }>
      /** VSK-BROWSER-B1: структурный снимок. B2: отдаётся top-N с `truncated`
       *  (в DOM пронумерованы ВСЕ — клик/find работают за пределами N). */
      snapshot: () => Promise<CappedSnapshot | { error: string }>
      /** VSK-BROWSER-B2: ОСНОВНОЙ путь адресации — найти элементы по запросу,
       *  вернуть их номера (годны для клика/ввода). Пусто → подсказка. */
      find: (query: string, limit?: number) => Promise<FindResult | { error: string }>
      /** Клик по номеру из последнего снимка; устаревший номер → честная ошибка. */
      clickByNumber: (n: number) => Promise<{ ok: true; url: string | null } | { ok: false; error: string }>
      /** Ввод текста по номеру поля из последнего снимка (заполнение форм). */
      typeByNumber: (n: number, text: string) => Promise<{ ok: true; url: string | null } | { ok: false; error: string }>
      /** Д3: нажать Enter/Tab/Escape в поле с фокусом (или по номеру) — отправка формы. */
      pressKey: (key: string, n?: number) => Promise<{ ok: true; submitted: boolean; url: string | null } | { ok: false; error: string }>
      /** Ждать элемент (селектор/текст) с честным таймаутом. */
      waitFor: (query: string, timeoutMs?: number) => Promise<{ ok: true } | { ok: false; error: string }>
      /** VSK-BROWSER-B2: сырой буфер консоли (редакция/фильтр в main). */
      consoleMessages: () => Promise<Array<{ level: number; message: string; line?: number; source?: string }>>
      /** VSK-BROWSER-B2: сырые записи сети из страницы (редакция в main). */
      networkRequests: () => Promise<Array<Record<string, unknown>>>
      screenshot: () => Promise<string>  // data:image/png;base64,...
      getURL: () => string | null
      getTitle: () => string | null
    }
  }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return HOMEPAGE
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(trimmed)) return 'https://' + trimmed
  return SEARCH_URL + encodeURIComponent(trimmed)
}

// VSK-BROWSER-B2 блок 2: рекордер сети в СТРАНИЦЕ — оборачивает fetch/XHR, копит
// метаданные запросов в window.__vskNet (метод/URL/статус/заголовки/длительность,
// БЕЗ тел). Идемпотентен (гард __vskNetHooked — переинжект на dom-ready не двоит).
// Сырьё читается networkRequests() и РЕДАКТИРУЕТСЯ в main (browser-redact) до модели.
const NET_RECORDER = `(() => {
  if (window.__vskNetHooked) return; window.__vskNetHooked = true;
  window.__vskNet = window.__vskNet || [];
  var CAP = 100;
  var push = function(e){ window.__vskNet.push(e); if (window.__vskNet.length > CAP) window.__vskNet.splice(0, window.__vskNet.length - CAP); };
  var now = function(){ return (window.performance && performance.now) ? performance.now() : 0; };
  var hdrs = function(h){ var o = {}; try { if (h) { if (h.forEach) h.forEach(function(v,k){ o[k]=v; }); else for (var k in h) o[k]=h[k]; } } catch(e){} return o; };
  var of = window.fetch;
  if (of) window.fetch = function(input, init){
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var method = (init && init.method) || (input && input.method) || 'GET';
    var headers = hdrs((init && init.headers) || (input && input.headers));
    var t0 = now();
    return of.apply(this, arguments).then(function(res){ try { push({ method: method, url: url, status: res.status, headers: headers, durationMs: t0 ? now()-t0 : null }); } catch(e){} return res; },
      function(err){ try { push({ method: method, url: url, status: 0, headers: headers, durationMs: t0 ? now()-t0 : null }); } catch(e){} throw err; });
  };
  var OX = window.XMLHttpRequest;
  if (OX) {
    var op = OX.prototype.open, se = OX.prototype.send, sh = OX.prototype.setRequestHeader;
    OX.prototype.open = function(m,u){ this.__vsk = { method: m, url: u, headers: {} }; return op.apply(this, arguments); };
    OX.prototype.setRequestHeader = function(k,v){ try { if (this.__vsk) this.__vsk.headers[k]=v; } catch(e){} return sh.apply(this, arguments); };
    OX.prototype.send = function(){ var x = this, t0 = now(); this.addEventListener('loadend', function(){ try { if (x.__vsk) push({ method: x.__vsk.method, url: x.__vsk.url, status: x.status, headers: x.__vsk.headers, durationMs: t0 ? now()-t0 : null }); } catch(e){} }); return se.apply(this, arguments); };
  }
})()`

export function BrowserView() {
  const webviewRef = useRef<Webview | null>(null)
  // B2: буфер консоли — событие webview 'console-message' (без CDP). Хранит сырое,
  // редакция и фильтр «только error/warning» — в main. Чистится на новой навигации.
  const consoleBufRef = useRef<Array<{ level: number; message: string; line?: number; source?: string }>>([])
  // Адресная строка пустая на старте (виден плейсхолдер) — «about:blank» в поле
  // выглядел бы артефактом; browser-панель Claude Code тоже открывается пустой.
  const [urlInput, setUrlInput] = useState('')
  const [currentUrl, setCurrentUrl] = useState('')
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onStart = () => { setLoading(true); setError(null) }
    const onStop = () => {
      setLoading(false)
      try {
        setCurrentUrl(wv.getURL())
        setTitle(wv.getTitle())
        setCanBack(wv.canGoBack())
        setCanFwd(wv.canGoForward())
      } catch { /* webview not ready */ }
    }
    const onFail = (e: Event) => {
      const ev = e as Event & { errorDescription?: string; validatedURL?: string }
      // -3 (ABORTED) fires on normal user-initiated navigation cancellation; ignore.
      const errCode = (ev as unknown as { errorCode?: number }).errorCode
      if (errCode === -3) return
      setError(ev.errorDescription ?? 'Не удалось загрузить страницу')
      setLoading(false)
    }
    // B2: захват консоли + чистка на новой странице + (пере)инжект рекордера сети.
    const CONSOLE_CAP = 200
    const onConsole = (e: Event) => {
      const ev = e as Event & { level?: number; message?: string; line?: number; sourceId?: string }
      const buf = consoleBufRef.current
      buf.push({ level: ev.level ?? 0, message: String(ev.message ?? ''), line: ev.line, source: ev.sourceId })
      if (buf.length > CONSOLE_CAP) buf.splice(0, buf.length - CONSOLE_CAP)
    }
    const onNav = () => { consoleBufRef.current = [] }   // новая страница — свой лог
    const onDomReady = () => { try { void wv.executeJavaScript(NET_RECORDER) } catch { /* страница между переходами */ } }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-start-loading', onNav)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFail)
    wv.addEventListener('console-message', onConsole)
    wv.addEventListener('dom-ready', onDomReady)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-start-loading', onNav)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFail)
      wv.removeEventListener('console-message', onConsole)
      wv.removeEventListener('dom-ready', onDomReady)
    }
  }, [])

  // Expose the AI-facing API on window.verstakBrowser while this view is mounted.
  useEffect(() => {
    window.verstakBrowser = {
      async navigate(url) {
        const wv = webviewRef.current
        if (!wv) return { ok: false, error: 'Browser view не активен' }
        const target = normalizeUrl(url)
        try {
          await wv.loadURL(target)
          return { ok: true, url: wv.getURL() }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
      async readPage(selector) {
        const wv = webviewRef.current
        if (!wv) return ''
        const code = selector
          ? `(document.querySelector(${JSON.stringify(selector)})?.innerText) || ''`
          : `(document.body?.innerText || '').slice(0, 50000)`
        try {
          const r = await wv.executeJavaScript(code)
          return typeof r === 'string' ? r : ''
        } catch { return '' }
      },
      async click(selector) {
        const wv = webviewRef.current
        if (!wv) return { ok: false, error: 'Browser view не активен' }
        // Tier-2 #5: клик по элементу (CSS-селектор или текст ссылки/кнопки). Сначала
        // querySelector; если не нашли — ищем ссылку/кнопку по видимому тексту.
        const sel = JSON.stringify(selector)
        const code = `(() => {
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
        try {
          const r = await wv.executeJavaScript(code) as { ok: true; url: string | null } | { ok: false; error: string }
          return r && typeof r === 'object' ? r : { ok: false, error: 'нет ответа' }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
      async snapshot() {
        const wv = webviewRef.current
        if (!wv) return { error: 'Browser view не активен' }
        // Нонс поколения генерим здесь (renderer), внутрь страницы — как аргумент.
        const gen = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        // B2: нумеруем ВСЕ элементы (vskSnapshot), но модели отдаём top-N (vskCapSnapshot)
        // с `truncated` — за пределами N адресуется через browser_find. Инжектим обе
        // рядом (compose локальными именами — минификация имён не ломает инжект).
        const code = `(() => {
          const snapshot = ${vskSnapshot.toString()};
          const cap = ${vskCapSnapshot.toString()};
          return cap(snapshot(${JSON.stringify(gen)}), ${VSK_SNAPSHOT_TOP_N});
        })()`
        try {
          const r = await wv.executeJavaScript(code)
          return (r && typeof r === 'object') ? r as CappedSnapshot : { error: 'снимок не удался' }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      },
      async find(query, limit) {
        const wv = webviewRef.current
        if (!wv) return { error: 'Browser view не активен' }
        // ОСНОВНОЙ путь адресации: снимаем снимок (нумерует все) и фильтруем по запросу.
        // Номера совпадений — те же, что в снимке → click/type по номеру работают через
        // тот же vskResolveNumbered, второго резолвера нет. Инжектим vskSnapshot+vskFind.
        const gen = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        const lim = Math.min(Math.max(1, limit ?? 30), 100)
        const code = `(() => {
          const snapshot = ${vskSnapshot.toString()};
          const find = ${vskFind.toString()};
          return find(snapshot(${JSON.stringify(gen)}), ${JSON.stringify(query)}, ${lim});
        })()`
        try {
          const r = await wv.executeJavaScript(code)
          return (r && typeof r === 'object') ? r as FindResult : { error: 'поиск не удался' }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      },
      async clickByNumber(n) {
        const wv = webviewRef.current
        if (!wv) return { ok: false, error: 'Browser view не активен' }
        // Инжектим ТОТ ЖЕ vskResolveNumbered (пин §3.1); клик над найденным el —
        // здесь же, в странице, т.к. DOM-ссылку наружу не отдать.
        // P3 (13.08): у не-HTML элемента метода .click() НЕТ — живой замер на Хабре
        // дал «target.click is not a function» на <svg>. Такой элемент попадает в
        // снимок, когда ему проставлена роль (<svg role="button">), и клик по нему
        // падал в рантайме вместо действия. Запасной путь — настоящее событие мыши.
        const code = `(() => {
          const resolve = ${vskResolveNumbered.toString()};
          const r = resolve(${JSON.stringify(n)});
          if (!r.ok) return r;
          try { r.el.scrollIntoView({ block: 'center' }); } catch (e) {}
          if (typeof r.el.click === 'function') r.el.click();
          else r.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return { ok: true, url: location.href };
        })()`
        try {
          const r = await wv.executeJavaScript(code) as { ok: true; url: string | null } | { ok: false; error: string }
          return r && typeof r === 'object' ? r : { ok: false, error: 'нет ответа' }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
      async typeByNumber(n, text) {
        const wv = webviewRef.current
        if (!wv) return { ok: false, error: 'Browser view не активен' }
        // Тот же резолвер, что у клика (пин §3.1); заполнение — vskFill в странице.
        const code = `(() => {
          const resolve = ${vskResolveNumbered.toString()};
          const fill = ${vskFill.toString()};
          const r = resolve(${JSON.stringify(n)});
          if (!r.ok) return r;
          const f = fill(r.el, ${JSON.stringify(text)});
          if (!f.ok) return f;
          return { ok: true, url: location.href };
        })()`
        try {
          const r = await wv.executeJavaScript(code) as { ok: true; url: string | null } | { ok: false; error: string }
          return r && typeof r === 'object' ? r : { ok: false, error: 'нет ответа' }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
      async pressKey(key, n) {
        const wv = webviewRef.current
        if (!wv) return { ok: false, error: 'Browser view не активен' }
        // Д3: цель нажатия — поле с текущим ФОКУСОМ (обычный случай: только что
        // ввели текст через typeByNumber), либо конкретный номер из снимка. Тот же
        // резолвер, что у клика/ввода (§3.1) — второго пути адресации не заводим.
        const target = n != null
          ? `(() => { const r = resolve(${JSON.stringify(n)}); return r.ok ? r.el : r; })()`
          : `(document.activeElement && document.activeElement !== document.body ? document.activeElement : null)`
        const code = `(() => {
          const resolve = ${vskResolveNumbered.toString()};
          const press = ${vskPressKey.toString()};
          const t = ${target};
          if (!t) return { ok: false, error: 'Нет поля в фокусе: сначала введи текст (browser_type_by_number) или укажи номер поля.' };
          if (t.ok === false) return t;
          const r = press(t, ${JSON.stringify(key)});
          if (!r.ok) return r;
          return { ok: true, submitted: r.submitted, url: location.href };
        })()`
        try {
          const r = await wv.executeJavaScript(code) as { ok: true; submitted: boolean; url: string | null } | { ok: false; error: string }
          return r && typeof r === 'object' ? r : { ok: false, error: 'нет ответа' }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
      async waitFor(query, timeoutMs) {
        const wv = webviewRef.current
        if (!wv) return { ok: false, error: 'Browser view не активен' }
        // Опрос ОДНОГО момента (vskMatchTarget) во времени, с ЧЕСТНЫМ таймаутом.
        // Слепых пауз не заводим: не появился за бюджет → явная ошибка.
        const budget = Math.min(Math.max(500, timeoutMs ?? 10_000), 30_000)
        const started = Date.now()
        const check = `(${vskMatchTarget.toString()})(${JSON.stringify(query)})`
        while (Date.now() - started < budget) {
          try {
            if (await wv.executeJavaScript(check) === true) return { ok: true }
          } catch { /* страница между переходами — повторим */ }
          await new Promise(r => setTimeout(r, 200))
        }
        return { ok: false, error: `Элемент «${query}» не появился за ${Math.round(budget / 1000)} с.` }
      },
      // B2: сырой буфер консоли (renderer) — фильтр «error/warning» + редакция в main.
      async consoleMessages() {
        return consoleBufRef.current.slice()
      },
      // B2: сырые записи сети из window.__vskNet (страница) — редакция в main.
      async networkRequests() {
        const wv = webviewRef.current
        if (!wv) return []
        try {
          const r = await wv.executeJavaScript('(window.__vskNet || [])')
          return Array.isArray(r) ? r : []
        } catch { return [] }
      },
      async screenshot() {
        const wv = webviewRef.current
        if (!wv) return ''
        try {
          const img = await wv.capturePage()
          return img.toDataURL()
        } catch { return '' }
      },
      getURL() { return webviewRef.current?.getURL() ?? null },
      getTitle() { return webviewRef.current?.getTitle() ?? null }
    }
    return () => { delete window.verstakBrowser }
  }, [])

  function go() {
    const target = normalizeUrl(urlInput)
    setUrlInput(target)
    const wv = webviewRef.current
    if (wv) wv.src = target
  }

  return (
    <div className="gg-panel" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="gg-browser-bar">
        <button
          className="gg-browser-btn"
          onClick={() => webviewRef.current?.goBack()}
          disabled={!canBack}
          title="Назад"
        >←</button>
        <button
          className="gg-browser-btn"
          onClick={() => webviewRef.current?.goForward()}
          disabled={!canFwd}
          title="Вперёд"
        >→</button>
        <button
          className="gg-browser-btn"
          onClick={() => loading ? webviewRef.current?.stop() : webviewRef.current?.reload()}
          title={loading ? 'Остановить' : 'Обновить'}
        >{loading ? '×' : '↻'}</button>
        <input
          className="gg-browser-url"
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') go() }}
          placeholder="URL или поисковый запрос"
          spellCheck={false}
        />
        <button className="gg-btn gg-btn-primary gg-browser-go" onClick={go}>↵</button>
      </div>
      {title && (
        <div className="gg-browser-status" title={currentUrl}>
          <span className="gg-browser-title">{title}</span>
          <span className="gg-browser-host">{(() => {
            try { return new URL(currentUrl).host } catch { return '' }
          })()}</span>
        </div>
      )}
      {error && <div className="gg-browser-error">⚠ {error}</div>}
      <div
        className="gg-browser-frame"
        ref={el => {
          // Insert the webview element manually so React's strict TS intrinsics
          // don't fight with us. Idempotent: only inserts if not already present.
          if (!el) return
          if (el.querySelector('webview')) return
          const wv = document.createElement('webview') as unknown as Webview
          wv.setAttribute('src', HOMEPAGE)
          wv.setAttribute('allowpopups', 'true')
          wv.style.width = '100%'
          wv.style.height = '100%'
          wv.style.border = 'none'
          wv.style.background = '#fff'
          el.appendChild(wv as unknown as Node)
          webviewRef.current = wv
        }}
      />
    </div>
  )
}
