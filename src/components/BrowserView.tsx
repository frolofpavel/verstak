import { useEffect, useRef, useState } from 'react'

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

const HOMEPAGE = 'https://www.google.com/'
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

export function BrowserView() {
  const webviewRef = useRef<Webview | null>(null)
  const [urlInput, setUrlInput] = useState(HOMEPAGE)
  const [currentUrl, setCurrentUrl] = useState(HOMEPAGE)
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
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFail)
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
