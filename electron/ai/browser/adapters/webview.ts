// webview.ts — BrowserAdapter для встроенного <webview> (BR-011).
//
// Встроенный Browser (src/components/BrowserView.tsx) экспонирует window.verstakBrowser
// с методами navigate/readPage/click/screenshot/getURL/getTitle. Main process
// дёргает их через ctx.sender.exec(snippet) — WebContents.executeJavaScript
// синхронно возвращает результат.
//
// Этот адаптер — обёртка над verstakBrowser для controller'а. Реализует только
// то, что умеет verstakBrowser: observe(=readPage)/navigate/click/screenshot.
// Остальные action types (back/forward/reload/scroll/type_text/select/...) —
// unsupported в B0. В webview они, возможно, есть на самом элементе, но мы их
// намеренно НЕ экспонируем: B0 строит безопасный chokepoint, expose новых
// mutation-capabilities без отдельной приёмки запрещён (§9 Phase B0 гейт).
//
// ВАЖНО: adapter НЕ делает risk-classification — это controller. Adapter только
// исполняет atom-команды и собирает observations.

import type {
  BrowserAdapter,
  ElementRef,
  Observation,
  ObservationId,
} from '../types'

export interface WebViewAdapterDeps {
  /** exec(snippet) — выполнить JS в renderer где живёт window.verstakBrowser.
   *  Возвращает результат (Promise<any>). */
  exec: (snippet: string) => Promise<unknown>
  /** Генератор id для observations. */
  generateObservationId?: () => ObservationId
}

interface VerstakBrowserApi {
  navigate(url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>
  readPage(selector?: string): Promise<string>
  click(selector: string): Promise<{ ok: true; url: string | null } | { ok: false; error: string }>
  screenshot(): Promise<string>
}

class WebviewAdapter implements BrowserAdapter {
  readonly id = 'electron-webview' as const
  private readonly exec: (snippet: string) => Promise<unknown>
  private readonly genObsId: () => ObservationId

  constructor(deps: WebViewAdapterDeps) {
    this.exec = deps.exec
    this.genObsId = deps.generateObservationId ?? (() => `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  }

  available(): boolean { return true }
  unavailableReason(): string | null { return null }

  private async probeApi(): Promise<VerstakBrowserApi | null> {
    const snippet = `(() => {
      const api = window.verstakBrowser;
      if (!api) return null;
      return {
        hasNavigate: typeof api.navigate === 'function',
        hasReadPage: typeof api.readPage === 'function',
        hasClick: typeof api.click === 'function',
        hasScreenshot: typeof api.screenshot === 'function',
        hasGetURL: typeof api.getURL === 'function',
        hasGetTitle: typeof api.getTitle === 'function',
      };
    })()`
    try {
      const probe = await this.exec(snippet) as Record<string, boolean> | null
      if (!probe) return null
      if (!probe.hasNavigate || !probe.hasReadPage || !probe.hasClick || !probe.hasScreenshot) return null
      // Возвращаем фасад: каждый метод дёргает verstakBrowser через exec.
      const call = <T>(expr: string): Promise<T> => this.exec(expr) as Promise<T>
      return {
        navigate: (url: string) => call(`window.verstakBrowser.navigate(${JSON.stringify(url)})`),
        readPage: (selector?: string) => call(selector
          ? `window.verstakBrowser.readPage(${JSON.stringify(selector)})`
          : `window.verstakBrowser.readPage()`),
        click: (selector: string) => call(`window.verstakBrowser.click(${JSON.stringify(selector)})`),
        screenshot: () => call(`window.verstakBrowser.screenshot()`),
      }
    } catch {
      return null
    }
  }

  private async getURL(): Promise<string> {
    try { return String(await this.exec('window.verstakBrowser.getURL()') ?? '') }
    catch { return '' }
  }

  private async getTitle(): Promise<string> {
    try { return String(await this.exec('window.verstakBrowser.getTitle()') ?? '') }
    catch { return '' }
  }

  async observe(scope: { browserTaskId: string; runId: string; tabRef?: string | null }): Promise<Observation> {
    const api = await this.probeApi()
    if (!api) {
      throw new Error('Вкладка Browser не открыта — попроси пользователя открыть её, либо действие невозможно в текущей среде.')
    }
    const [url, title, text, screenshot] = await Promise.all([
      this.getURL(),
      this.getTitle(),
      api.readPage().catch(() => ''),
      api.screenshot().catch(() => null),
    ])
    const safeUrl = sanitizeUrl(url)
    const observation: Observation = {
      observationId: this.genObsId(),
      observationVersion: 0, // controller инкрементирует и сохраняет в task
      browserTaskId: scope.browserTaskId,
      runId: scope.runId,
      capturedAt: Date.now(),
      source: {
        kind: 'electron-webview',
        tabRef: scope.tabRef ?? null,
        documentId: null,
        url: safeUrl,
        title: title.slice(0, 500),
        origin: extractOrigin(safeUrl),
      },
      tenant: null,
      account: null,
      text: (text ?? '').slice(0, 50_000),
      tables: [],
      controls: [],
      screenshotDataUrl: typeof screenshot === 'string' && screenshot.startsWith('data:image/') ? screenshot : null,
      omissions: [
        // В B0 webview-adapter не собирает interactive map/tables (verstakBrowser
        // их не отдаёт). Это упрощённая observation по сравнению с extension.
        'webview-adapter: controls/tables не собираются в B0 (verstakBrowser не отдаёт interactive map)',
      ],
      truncated: { text: false, selection: false, tables: false },
    }
    return observation
  }

  async navigate(url: string): Promise<{ finalUrl: string; title: string }> {
    const api = await this.probeApi()
    if (!api) throw new Error('webview adapter: verstakBrowser not available')
    const r = await api.navigate(url)
    if (!r.ok) throw new Error(`navigate failed: ${r.error}`)
    const finalUrl = sanitizeUrl(await this.getURL() || r.url)
    const title = (await this.getTitle()).slice(0, 500)
    return { finalUrl, title }
  }

  async back(): Promise<void> { throw new Error(this.unsupported('back').reason) }
  async forward(): Promise<void> { throw new Error(this.unsupported('forward').reason) }
  async reload(): Promise<void> { throw new Error(this.unsupported('reload').reason) }

  async click(elementRef: ElementRef): Promise<{ finalUrl: string }> {
    const api = await this.probeApi()
    if (!api) throw new Error('webview adapter: verstakBrowser not available')
    const r = await api.click(elementRef)
    if (!r.ok) throw new Error(`click failed: ${r.error}`)
    const finalUrl = sanitizeUrl(await this.getURL() || r.url || '')
    return { finalUrl }
  }

  async focus(_elementRef: ElementRef): Promise<void> { throw new Error(this.unsupported('focus').reason) }
  async scroll(_elementRef: ElementRef | null, _delta: { x?: number; y?: number }): Promise<void> {
    throw new Error(this.unsupported('scroll').reason)
  }

  async screenshot(): Promise<string | null> {
    const api = await this.probeApi()
    if (!api) throw new Error('webview adapter: verstakBrowser not available')
    const r = await api.screenshot()
    return typeof r === 'string' && r.startsWith('data:image/') ? r : null
  }

  unsupported(actionType: string): { ok: false; reason: string } {
    return {
      ok: false as const,
      reason: `webview-adapter не поддерживает action type "${actionType}" в EXT-B0. Доступно: observe/navigate/click/screenshot. Остальные action types требуют chrome-extension adapter (EXT-B1).`,
    }
  }
}

export function createWebviewAdapter(deps: WebViewAdapterDeps): BrowserAdapter {
  return new WebviewAdapter(deps)
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sanitizeUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return ''
  try {
    const u = new URL(raw)
    return (u.protocol + '//' + u.host + u.pathname).slice(0, 2048)
  } catch {
    return String(raw).slice(0, 2048)
  }
}

function extractOrigin(url: string): string {
  try {
    const u = new URL(url)
    return u.host
  } catch {
    return ''
  }
}
