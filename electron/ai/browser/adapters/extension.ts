// extension.ts — Chrome extension adapter (EXT-B1 Eyes + EXT-C1 first hand: click).
//
// Observe + click идут только через BridgeServer → Native Messaging → extension.
// Никакого clipboard. Controller — единственный chokepoint; adapter только
// исполняет observe/click. type_text/select — out of scope.

import { randomUUID } from 'node:crypto'
import { scanText } from '../../secret-scanner'
import type {
  BrowserAdapter,
  ElementRef,
  Observation,
  ObservationId,
} from '../types'
import type { BridgeServer } from '../bridge/server'
import type { BridgePageSnapshot } from '../bridge/protocol'

export interface ExtensionAdapterDeps {
  /** Live bridge server (main process). */
  getBridge: () => BridgeServer | null
  generateObservationId?: () => ObservationId
}

const NOT_CONNECTED =
  'chrome-extension bridge offline. Запустите Verstak, откройте side panel расширения и pair/attach вкладку.'

function extractOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function hostOnly(originOrUrl: string): string {
  const s = String(originOrUrl || '')
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).host
  } catch { /* fallthrough */ }
  return s.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function snapshotToObservation(
  snapshot: BridgePageSnapshot,
  scope: { browserTaskId: string; runId: string; tabRef?: string | null },
  obsId: ObservationId,
): Observation {
  const url = snapshot.source.url || ''
  const title = (snapshot.source.title || '').slice(0, 500)
  const originFull = snapshot.source.origin || extractOrigin(url)
  const origin = hostOnly(originFull)
  const textScan = scanText(snapshot.text || '')
  const tables = (snapshot.tables || []).map((t) => ({
    caption: scanText(t.caption || '').redacted,
    rows: (t.rows || []).map((row) => row.map((c) => scanText(String(c)).redacted)),
  }))
  const observationVersion =
    typeof snapshot.observationVersion === 'number' && Number.isFinite(snapshot.observationVersion)
      ? Math.floor(snapshot.observationVersion)
      : Date.now()
  const controls = (snapshot.controls || []).slice(0, 40).map((c) => ({
    elementRef: String(c.elementRef || ''),
    role: String(c.role || 'unknown'),
    label: scanText(String(c.label || '')).redacted.slice(0, 120),
    state: c.state ? String(c.state).slice(0, 40) : undefined,
    observationVersion:
      typeof c.observationVersion === 'number' ? c.observationVersion : observationVersion,
  })).filter((c) => c.elementRef)
  const omissions = [...(snapshot.omissions || [])]
  if (textScan.hits.length) {
    omissions.push(`secret-scanner: ${textScan.hits.length} hit(s)`)
  }
  return {
    observationId: obsId,
    observationVersion,
    browserTaskId: scope.browserTaskId,
    runId: scope.runId,
    capturedAt: Date.now(),
    source: {
      kind: 'chrome-extension',
      tabRef: scope.tabRef ?? null,
      documentId: null,
      url,
      title,
      origin,
    },
    tenant: null,
    account: null,
    text: textScan.redacted,
    tables,
    controls,
    screenshotDataUrl: null,
    omissions,
    truncated: {
      text: !!snapshot.truncated?.text,
      selection: !!snapshot.truncated?.selection,
      tables: !!snapshot.truncated?.tables,
    },
  }
}

class ExtensionAdapter implements BrowserAdapter {
  readonly id = 'chrome-extension' as const
  private readonly getBridge: () => BridgeServer | null
  private readonly genObsId: () => ObservationId
  /** Last successful observation (for elementRef + version on click). */
  private lastObs: Observation | null = null

  constructor(deps: ExtensionAdapterDeps) {
    this.getBridge = deps.getBridge
    this.genObsId = deps.generateObservationId ?? (() => `obs-ext-${randomUUID().slice(0, 12)}`)
  }

  available(): boolean {
    const b = this.getBridge()
    if (!b) return false
    if (!b.isExtensionConnected()) return false
    const st = b.getPublicState()
    // Observe/click only after explicit attach (paired alone is not enough).
    return st.ui === 'attached' && !!st.attachedTab
  }

  unavailableReason(): string | null {
    const b = this.getBridge()
    if (!b) return NOT_CONNECTED
    if (!b.isExtensionConnected()) return NOT_CONNECTED
    const st = b.getPublicState()
    if (st.ui === 'offline') return 'Verstak bridge offline'
    if (st.ui === 'connecting') return 'chrome-extension connecting…'
    if (st.ui === 'error') return st.lastError || 'bridge error'
    if (st.ui === 'paired' && !st.attachedTab) {
      return 'вкладка не прикреплена — Attach в side panel'
    }
    if (!this.available()) return NOT_CONNECTED
    return null
  }

  async observe(scope: { browserTaskId: string; runId: string; tabRef?: string | null }): Promise<Observation> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    const st = bridge.getPublicState()
    const tabRef = scope.tabRef || st.attachedTab?.tabRef
    if (!tabRef) {
      throw new Error('нет task tab — attach вкладку в side panel расширения Verstak')
    }
    const snapshot = await bridge.requestObserve({
      browserTaskId: scope.browserTaskId,
      runId: scope.runId,
      tabRef,
    })
    const obs = snapshotToObservation(snapshot, { ...scope, tabRef }, this.genObsId())
    this.lastObs = obs
    return obs
  }

  private extractStrictScope(st: { browserTaskId?: string | null; runId?: string | null }): {
    browserTaskId: string
    runId: string
  } {
    const bt = (st.browserTaskId || this.lastObs?.browserTaskId || '').trim()
    const run = (st.runId || this.lastObs?.runId || '').trim()
    if (!bt || !run) {
      throw new Error('нет active browserTaskId/runId lineage — observe перед действием (fail-closed)')
    }
    return { browserTaskId: bt, runId: run }
  }

  private validateRefContext(elementRef: ElementRef, tabRef: string, attachedOrigin?: string) {
    const ref = String(elementRef || '').trim()
    if (!ref) throw new Error('elementRef пуст')
    if (/[{};<>]|document\.|querySelector|eval\(/i.test(ref)) {
      throw new Error('raw CSS/JS selector запрещён — только elementRef из observation')
    }
    const last = this.lastObs
    if (!last) {
      throw new Error('нет observation — observe перед действием (elementRef map)')
    }
    if (last.source.tabRef && last.source.tabRef !== tabRef) {
      throw new Error('wrong tab — elementRef из другой вкладки, действие остановлено')
    }
    const origin = hostOnly(attachedOrigin || '')
    if (last.source.origin && origin && last.source.origin !== origin) {
      throw new Error(`wrong origin — observation ${last.source.origin} ≠ attached ${origin}`)
    }
    const ctrl = (last.controls || []).find((c) => c.elementRef === ref)
    if (!ctrl) {
      throw new Error(`elementRef "${ref}" нет в последнем observation — перечитай страницу`)
    }
    return { ctrl, ref, observationVersion: ctrl.observationVersion || last.observationVersion }
  }

  async navigate(url: string): Promise<{ finalUrl: string; title: string }> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) {
      throw new Error(this.unavailableReason() || NOT_CONNECTED)
    }
    const st = bridge.getPublicState()
    const tabRef = st.attachedTab?.tabRef
    if (!tabRef) throw new Error('нет attached tab')
    const scope = this.extractStrictScope(st)
    const targetUrl = String(url || '').trim()
    if (!targetUrl) throw new Error('url пуст')
    const res = await bridge.requestNavigate({
      browserTaskId: scope.browserTaskId,
      runId: scope.runId,
      tabRef,
      url: targetUrl,
    })
    if (!res.ok) {
      throw new Error(res.error || 'navigate failed')
    }
    this.lastObs = null
    return { finalUrl: res.finalUrl, title: res.title }
  }

  async back(): Promise<void> {
    throw new Error('back — используйте navigate')
  }
  async forward(): Promise<void> {
    throw new Error('forward — используйте navigate')
  }
  async reload(): Promise<void> {
    const lastUrl = this.lastObs?.source.url
    if (!lastUrl) {
      throw new Error('reload невозможно — нет предшествующего observation с URL')
    }
    await this.navigate(lastUrl)
  }

  async click(elementRef: ElementRef): Promise<{ finalUrl: string }> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) {
      throw new Error(this.unavailableReason() || NOT_CONNECTED)
    }
    const st = bridge.getPublicState()
    const tabRef = st.attachedTab?.tabRef
    if (!tabRef) throw new Error('нет attached tab')
    const scope = this.extractStrictScope(st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      tabRef,
      st.attachedTab?.origin,
    )

    try {
      const result = await bridge.requestClick({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef,
        elementRef: ref,
        observationVersion,
        origin: st.attachedTab?.origin,
      })
      if (!result.ok) {
        throw new Error(result.error || 'click failed')
      }
      return { finalUrl: result.finalUrl || st.attachedTab?.url || '' }
    } finally {
      this.lastObs = null
    }
  }

  async focus(elementRef: ElementRef): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const tabRef = st.attachedTab?.tabRef
    if (!tabRef) throw new Error('нет attached tab')
    const scope = this.extractStrictScope(st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      tabRef,
      st.attachedTab?.origin,
    )
    const res = await bridge.requestFocus({
      browserTaskId: scope.browserTaskId,
      runId: scope.runId,
      tabRef,
      elementRef: ref,
      observationVersion,
    })
    if (!res.ok) throw new Error(res.error || 'focus failed')
  }

  async scroll(elementRef: ElementRef | null, delta: { x?: number; y?: number }): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const tabRef = st.attachedTab?.tabRef
    if (!tabRef) throw new Error('нет attached tab')
    const scope = this.extractStrictScope(st)
    let refStr: string | undefined
    if (elementRef) {
      const v = this.validateRefContext(elementRef, tabRef, st.attachedTab?.origin)
      refStr = v.ref
    }
    const res = await bridge.requestScroll({
      browserTaskId: scope.browserTaskId,
      runId: scope.runId,
      tabRef,
      elementRef: refStr,
      delta,
    })
    if (!res.ok) throw new Error(res.error || 'scroll failed')
  }

  async selectOption(elementRef: ElementRef, value: string): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const tabRef = st.attachedTab?.tabRef
    if (!tabRef) throw new Error('нет attached tab')
    const scope = this.extractStrictScope(st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      tabRef,
      st.attachedTab?.origin,
    )
    try {
      const res = await bridge.requestSelectOption({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef,
        elementRef: ref,
        observationVersion,
        value,
      })
      if (!res.ok) throw new Error(res.error || 'select_option failed')
    } finally {
      this.lastObs = null
    }
  }

  async typeText(
    elementRef: ElementRef,
    text: string,
    opts?: { clearFirst?: boolean; submitEnter?: boolean },
  ): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const tabRef = st.attachedTab?.tabRef
    if (!tabRef) throw new Error('нет attached tab')
    const scope = this.extractStrictScope(st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      tabRef,
      st.attachedTab?.origin,
    )
    try {
      const res = await bridge.requestTypeText({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef,
        elementRef: ref,
        observationVersion,
        text,
        clearFirst: opts?.clearFirst,
        submitEnter: opts?.submitEnter,
      })
      if (!res.ok) throw new Error(res.error || 'type_text failed')
    } finally {
      this.lastObs = null
    }
  }

  async clearField(elementRef: ElementRef): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const tabRef = st.attachedTab?.tabRef
    if (!tabRef) throw new Error('нет attached tab')
    const scope = this.extractStrictScope(st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      tabRef,
      st.attachedTab?.origin,
    )
    try {
      const res = await bridge.requestClearField({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef,
        elementRef: ref,
        observationVersion,
      })
      if (!res.ok) throw new Error(res.error || 'clear_field failed')
    } finally {
      this.lastObs = null
    }
  }

  async toggle(elementRef: ElementRef): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const tabRef = st.attachedTab?.tabRef
    if (!tabRef) throw new Error('нет attached tab')
    const scope = this.extractStrictScope(st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      tabRef,
      st.attachedTab?.origin,
    )
    try {
      const res = await bridge.requestToggle({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef,
        elementRef: ref,
        observationVersion,
      })
      if (!res.ok) throw new Error(res.error || 'toggle failed')
    } finally {
      this.lastObs = null
    }
  }

  async pressKey(elementRef: ElementRef, key: string): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const tabRef = st.attachedTab?.tabRef
    if (!tabRef) throw new Error('нет attached tab')
    const scope = this.extractStrictScope(st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      tabRef,
      st.attachedTab?.origin,
    )
    const res = await bridge.requestPressKey({
      browserTaskId: scope.browserTaskId,
      runId: scope.runId,
      tabRef,
      elementRef: ref,
      observationVersion,
      key,
    })
    if (!res.ok) throw new Error(res.error || 'press_key failed')
  }

  async waitFor(condition: {
    elementRef?: ElementRef
    text?: string
    url?: string
    timeoutMs?: number
  }): Promise<{ ok: boolean; reason?: string }> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const tabRef = st.attachedTab?.tabRef
    if (!tabRef) throw new Error('нет attached tab')
    const scope = this.extractStrictScope(st)
    if (condition.elementRef) {
      this.validateRefContext(condition.elementRef, tabRef, st.attachedTab?.origin)
    }
    return bridge.requestWaitFor({
      browserTaskId: scope.browserTaskId,
      runId: scope.runId,
      tabRef,
      condition,
    })
  }

  async screenshot(): Promise<string | null> {
    return null
  }

  unsupported(actionType: string): { ok: false; reason: string } {
    return {
      ok: false as const,
      reason: `chrome-extension adapter (C1): action "${actionType}" не поддерживается в C1 (EXT-D1).`,
    }
  }
}

export function createExtensionAdapter(deps: ExtensionAdapterDeps): BrowserAdapter {
  return new ExtensionAdapter(deps)
}

/** Для unit-тестов без live bridge. */
export function createExtensionAdapterWithTransport(opts: {
  requestObserve: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
  }) => Promise<BridgePageSnapshot>
  requestClick?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
    origin?: string
  }) => Promise<{ ok: true; finalUrl: string } | { ok: false; error: string }>
  requestNavigate?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    url: string
  }) => Promise<{ ok: true; finalUrl: string; title: string } | { ok: false; error: string }>
  requestScroll?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef?: string
    delta?: { x?: number; y?: number }
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  requestFocus?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  requestSelectOption?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    value: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  requestTypeText?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
    text: string
    clearFirst?: boolean
    submitEnter?: boolean
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  requestClearField?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  requestToggle?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  requestPressKey?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
    key: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  requestWaitFor?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    condition: { elementRef?: string; text?: string; url?: string; timeoutMs?: number }
  }) => Promise<{ ok: true; reason?: string } | { ok: false; reason?: string; error?: string }>
  connected?: boolean
  attachedTabRef?: string | null
  attachedOrigin?: string
  sessionId?: string | null
  browserTaskId?: string
  runId?: string
}): BrowserAdapter {
  const fakeBridge = {
    isExtensionConnected: () => opts.connected !== false,
    getPublicState: () => ({
      ui: (opts.attachedTabRef ? 'attached' : opts.sessionId ? 'paired' : 'offline') as 'attached' | 'paired' | 'offline',
      sessionId: opts.sessionId ?? 'test-session',
      pairingToken: null,
      browserTaskId: opts.browserTaskId ?? 'bt-test',
      runId: opts.runId ?? 'run-test',
      attachedTab: opts.attachedTabRef
        ? {
            tabRef: opts.attachedTabRef,
            url: `${opts.attachedOrigin || 'https://example.com'}/`,
            title: 't',
            origin: opts.attachedOrigin || 'https://example.com',
          }
        : null,
      lastError: null,
      connected: opts.connected !== false,
      desktopOnline: true,
    }),
    requestObserve: async (input: { browserTaskId: string; runId: string; tabRef: string }) =>
      opts.requestObserve(input),
    requestClick: async (input: {
      browserTaskId: string
      runId: string
      tabRef: string
      elementRef: string
      observationVersion: number
      origin?: string
    }) => {
      if (!opts.requestClick) {
        return { ok: false as const, error: 'requestClick not stubbed' }
      }
      return opts.requestClick(input)
    },
    requestNavigate: async (input: { browserTaskId: string; runId: string; tabRef: string; url: string }) => {
      if (!opts.requestNavigate) {
        return { ok: true as const, finalUrl: input.url, title: 'Navigated' }
      }
      return opts.requestNavigate(input)
    },
    requestScroll: async (input: { browserTaskId: string; runId: string; tabRef: string; elementRef?: string; delta?: { x?: number; y?: number } }) => {
      if (!opts.requestScroll) return { ok: true as const }
      return opts.requestScroll(input)
    },
    requestFocus: async (input: { browserTaskId: string; runId: string; tabRef: string; elementRef: string }) => {
      if (!opts.requestFocus) return { ok: true as const }
      return opts.requestFocus(input)
    },
    requestSelectOption: async (input: { browserTaskId: string; runId: string; tabRef: string; elementRef: string; value: string }) => {
      if (!opts.requestSelectOption) return { ok: true as const }
      return opts.requestSelectOption(input)
    },
    requestTypeText: async (input: { browserTaskId: string; runId: string; tabRef: string; elementRef: string; observationVersion: number; text: string; clearFirst?: boolean; submitEnter?: boolean }) => {
      if (!opts.requestTypeText) return { ok: true as const }
      return opts.requestTypeText(input)
    },
    requestClearField: async (input: { browserTaskId: string; runId: string; tabRef: string; elementRef: string; observationVersion: number }) => {
      if (!opts.requestClearField) return { ok: true as const }
      return opts.requestClearField(input)
    },
    requestToggle: async (input: { browserTaskId: string; runId: string; tabRef: string; elementRef: string; observationVersion: number }) => {
      if (!opts.requestToggle) return { ok: true as const }
      return opts.requestToggle(input)
    },
    requestPressKey: async (input: { browserTaskId: string; runId: string; tabRef: string; elementRef: string; observationVersion: number; key: string }) => {
      if (!opts.requestPressKey) return { ok: true as const }
      return opts.requestPressKey(input)
    },
    requestWaitFor: async (input: { browserTaskId: string; runId: string; tabRef: string; condition: { elementRef?: string; text?: string; url?: string; timeoutMs?: number } }) => {
      if (!opts.requestWaitFor) return { ok: true as const, reason: 'matched' }
      return opts.requestWaitFor(input)
    },
    getSession: () => null as never,
    getEndpointPath: () => null,
    start: async () => '',
    stop: async () => {},
    setActiveLineage: () => {},
  }
  return createExtensionAdapter({ getBridge: () => fakeBridge as unknown as BridgeServer })
}
