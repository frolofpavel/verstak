// extension.ts — Chrome extension adapter (EXT-B1 Eyes + EXT-C1 first hand: click).
//
// Observe + actions идут только через BridgeServer → Native Messaging → extension.
// Никакого clipboard. Controller — единственный chokepoint; adapter исполняет
// только нормализованные действия по trusted scope и opaque elementRef.

import { randomUUID } from 'node:crypto'
import { scanText } from '../../secret-scanner'
import type {
  BrowserAdapter,
  BrowserAdapterActionScope,
  BrowserActionScope,
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
  'Браузер не подключён. Откройте Настройки → Интеграции → Браузер и нажмите «Подключить браузер».'
const TAB_NOT_SELECTED =
  'Вкладка не выбрана. Откройте нужную страницу и нажмите значок Verstak в браузере.'

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
  /** Observations are isolated by trusted controller lineage. A single global
   * observation is unsafe because another chat may observe the same tab while
   * an approved action is waiting to execute. */
  private readonly observations = new Map<string, {
    observation: Observation
    connectionGeneration: number
  }>()

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
    if (st.ui === 'offline' || st.ui === 'connecting' || st.ui === 'error') return NOT_CONNECTED
    if (st.ui === 'paired' && !st.attachedTab) {
      return TAB_NOT_SELECTED
    }
    if (!this.available()) return NOT_CONNECTED
    return null
  }

  async observe(scope: { browserTaskId: string; runId: string; tabRef?: string | null }): Promise<Observation> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    const st = bridge.getPublicState()
    const startedGeneration = Number.isSafeInteger(st.connectionGeneration)
      ? st.connectionGeneration
      : 0
    const resolved = this.resolveActionScope(scope, st)
    const snapshot = await bridge.requestObserve({
      browserTaskId: resolved.browserTaskId,
      runId: resolved.runId,
      tabRef: resolved.tabRef,
    })
    const stateAfterObserve = bridge.getPublicState()
    const completedGeneration = Number.isSafeInteger(stateAfterObserve.connectionGeneration)
      ? stateAfterObserve.connectionGeneration
      : 0
    if (completedGeneration !== startedGeneration) {
      throw new Error('соединение браузера сменилось во время observe — нужен свежий observe после reconnect')
    }
    const obs = snapshotToObservation(snapshot, resolved, this.genObsId())
    this.rememberObservation(resolved, obs, completedGeneration)
    return obs
  }

  private resolveActionScope(
    scope: Pick<BrowserActionScope, 'browserTaskId' | 'runId' | 'tabRef'> | BrowserAdapterActionScope,
    st: ReturnType<BridgeServer['getPublicState']>,
  ): {
    browserTaskId: string
    runId: string
    tabRef: string
    origin?: string | null
  } {
    const bt = String(scope?.browserTaskId || '').trim()
    const run = String(scope?.runId || '').trim()
    if (!bt || !run) {
      throw new Error('нет browserTaskId/runId в scope controller — действие остановлено (fail-closed)')
    }
    const attachedTabRef = st.attachedTab?.tabRef
    if (!attachedTabRef) {
      throw new Error(TAB_NOT_SELECTED)
    }
    const tabRef = String(scope?.tabRef || attachedTabRef).trim()
    if (!tabRef || tabRef !== attachedTabRef) {
      throw new Error('wrong tab — scope controller не совпадает с прикреплённой вкладкой')
    }
    const expectedOrigin = hostOnly('origin' in scope ? scope.origin || '' : '')
    const attachedOrigin = hostOnly(st.attachedTab?.origin || '')
    if (expectedOrigin && attachedOrigin && expectedOrigin !== attachedOrigin) {
      throw new Error(`wrong origin — scope ${expectedOrigin} ≠ attached ${attachedOrigin}`)
    }
    return {
      browserTaskId: bt,
      runId: run,
      tabRef,
      origin: 'origin' in scope ? scope.origin : null,
    }
  }

  private observationKey(scope: { browserTaskId: string; runId: string; tabRef: string }): string {
    return JSON.stringify([scope.browserTaskId, scope.runId, scope.tabRef])
  }

  private rememberObservation(
    scope: { browserTaskId: string; runId: string; tabRef: string },
    observation: Observation,
    connectionGeneration: number,
  ): void {
    const key = this.observationKey(scope)
    this.observations.delete(key)
    this.observations.set(key, { observation, connectionGeneration })
    if (this.observations.size > 64) {
      const oldest = this.observations.keys().next().value
      if (oldest) this.observations.delete(oldest)
    }
  }

  private invalidateObservation(scope: { browserTaskId: string; runId: string; tabRef: string }): void {
    this.observations.delete(this.observationKey(scope))
  }

  private validateRefContext(
    elementRef: ElementRef,
    scope: { browserTaskId: string; runId: string; tabRef: string },
    attachedOrigin?: string,
    connectionGeneration = 0,
  ) {
    const ref = String(elementRef || '').trim()
    if (!ref) throw new Error('elementRef пуст')
    if (/[{};<>]|document\.|querySelector|eval\(/i.test(ref)) {
      throw new Error('raw CSS/JS selector запрещён — только elementRef из observation')
    }
    const key = this.observationKey(scope)
    const cached = this.observations.get(key)
    if (!cached) {
      throw new Error('нет observation для task/run/tab scope — observe перед действием (elementRef map)')
    }
    if (cached.connectionGeneration !== connectionGeneration) {
      this.observations.delete(key)
      throw new Error('reconnect инвалидировал elementRef — нужен свежий observe текущего соединения')
    }
    const last = cached.observation
    if (last.browserTaskId !== scope.browserTaskId || last.runId !== scope.runId) {
      throw new Error('wrong lineage — observation принадлежит другой задаче или run')
    }
    if (last.source.tabRef && last.source.tabRef !== scope.tabRef) {
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

  async navigate(url: string, actionScope: BrowserAdapterActionScope): Promise<{ finalUrl: string; title: string }> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) {
      throw new Error(this.unavailableReason() || NOT_CONNECTED)
    }
    const st = bridge.getPublicState()
    const scope = this.resolveActionScope(actionScope, st)
    const targetUrl = String(url || '').trim()
    if (!targetUrl) throw new Error('url пуст')
    try {
      const res = await bridge.requestNavigate({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef: scope.tabRef,
        url: targetUrl,
      })
      if (!res.ok) {
        throw new Error(res.error || 'navigate failed')
      }
      return { finalUrl: res.finalUrl, title: res.title }
    } finally {
      this.invalidateObservation(scope)
    }
  }

  async back(_scope: BrowserAdapterActionScope): Promise<void> {
    throw new Error('back — используйте navigate')
  }
  async forward(_scope: BrowserAdapterActionScope): Promise<void> {
    throw new Error('forward — используйте navigate')
  }
  async reload(actionScope: BrowserAdapterActionScope): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    const scope = this.resolveActionScope(actionScope, bridge.getPublicState())
    const lastUrl = this.observations.get(this.observationKey(scope))?.observation.source.url
    if (!lastUrl) {
      throw new Error('reload невозможно — нет предшествующего observation с URL')
    }
    await this.navigate(lastUrl, actionScope)
  }

  async click(elementRef: ElementRef, actionScope: BrowserAdapterActionScope): Promise<{ finalUrl: string }> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) {
      throw new Error(this.unavailableReason() || NOT_CONNECTED)
    }
    const st = bridge.getPublicState()
    const scope = this.resolveActionScope(actionScope, st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      scope,
      st.attachedTab?.origin,
      st.connectionGeneration,
    )

    try {
      const result = await bridge.requestClick({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef: scope.tabRef,
        elementRef: ref,
        observationVersion,
        origin: st.attachedTab?.origin,
      })
      if (!result.ok) {
        throw new Error(result.error || 'click failed')
      }
      return { finalUrl: result.finalUrl || st.attachedTab?.url || '' }
    } finally {
      this.invalidateObservation(scope)
    }
  }

  async focus(elementRef: ElementRef, actionScope: BrowserAdapterActionScope): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const scope = this.resolveActionScope(actionScope, st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      scope,
      st.attachedTab?.origin,
      st.connectionGeneration,
    )
    try {
      const res = await bridge.requestFocus({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef: scope.tabRef,
        elementRef: ref,
        observationVersion,
      })
      if (!res.ok) throw new Error(res.error || 'focus failed')
    } finally {
      this.invalidateObservation(scope)
    }
  }

  async scroll(
    elementRef: ElementRef | null,
    delta: { x?: number; y?: number },
    actionScope: BrowserAdapterActionScope,
  ): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const scope = this.resolveActionScope(actionScope, st)
    let refStr: string | undefined
    if (elementRef) {
      const v = this.validateRefContext(
        elementRef,
        scope,
        st.attachedTab?.origin,
        st.connectionGeneration,
      )
      refStr = v.ref
    }
    try {
      const res = await bridge.requestScroll({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef: scope.tabRef,
        elementRef: refStr,
        delta,
      })
      if (!res.ok) throw new Error(res.error || 'scroll failed')
    } finally {
      this.invalidateObservation(scope)
    }
  }

  async selectOption(
    elementRef: ElementRef,
    value: string,
    actionScope: BrowserAdapterActionScope,
  ): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const scope = this.resolveActionScope(actionScope, st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      scope,
      st.attachedTab?.origin,
      st.connectionGeneration,
    )
    try {
      const res = await bridge.requestSelectOption({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef: scope.tabRef,
        elementRef: ref,
        observationVersion,
        value,
      })
      if (!res.ok) throw new Error(res.error || 'select_option failed')
    } finally {
      this.invalidateObservation(scope)
    }
  }

  async typeText(
    elementRef: ElementRef,
    text: string,
    opts: { clearFirst?: boolean; submitEnter?: boolean } | undefined,
    actionScope: BrowserAdapterActionScope,
  ): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const scope = this.resolveActionScope(actionScope, st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      scope,
      st.attachedTab?.origin,
      st.connectionGeneration,
    )
    try {
      const res = await bridge.requestTypeText({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef: scope.tabRef,
        elementRef: ref,
        observationVersion,
        text,
        clearFirst: opts?.clearFirst,
        submitEnter: opts?.submitEnter,
      })
      if (!res.ok) throw new Error(res.error || 'type_text failed')
    } finally {
      this.invalidateObservation(scope)
    }
  }

  async clearField(elementRef: ElementRef, actionScope: BrowserAdapterActionScope): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const scope = this.resolveActionScope(actionScope, st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      scope,
      st.attachedTab?.origin,
      st.connectionGeneration,
    )
    try {
      const res = await bridge.requestClearField({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef: scope.tabRef,
        elementRef: ref,
        observationVersion,
      })
      if (!res.ok) throw new Error(res.error || 'clear_field failed')
    } finally {
      this.invalidateObservation(scope)
    }
  }

  async toggle(elementRef: ElementRef, actionScope: BrowserAdapterActionScope): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const scope = this.resolveActionScope(actionScope, st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      scope,
      st.attachedTab?.origin,
      st.connectionGeneration,
    )
    try {
      const res = await bridge.requestToggle({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef: scope.tabRef,
        elementRef: ref,
        observationVersion,
      })
      if (!res.ok) throw new Error(res.error || 'toggle failed')
    } finally {
      this.invalidateObservation(scope)
    }
  }

  async pressKey(
    elementRef: ElementRef,
    key: string,
    actionScope: BrowserAdapterActionScope,
  ): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const scope = this.resolveActionScope(actionScope, st)
    const { ref, observationVersion } = this.validateRefContext(
      elementRef,
      scope,
      st.attachedTab?.origin,
      st.connectionGeneration,
    )
    try {
      const res = await bridge.requestPressKey({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef: scope.tabRef,
        elementRef: ref,
        observationVersion,
        key,
      })
      if (!res.ok) throw new Error(res.error || 'press_key failed')
    } finally {
      this.invalidateObservation(scope)
    }
  }

  async waitFor(condition: {
    elementRef?: ElementRef
    text?: string
    url?: string
    timeoutMs?: number
  }, actionScope: BrowserAdapterActionScope): Promise<{ ok: boolean; reason?: string }> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    if (!this.available()) throw new Error(this.unavailableReason() || NOT_CONNECTED)
    const st = bridge.getPublicState()
    const scope = this.resolveActionScope(actionScope, st)
    if (condition.elementRef) {
      this.validateRefContext(
        condition.elementRef,
        scope,
        st.attachedTab?.origin,
        st.connectionGeneration,
      )
    }
    try {
      return await bridge.requestWaitFor({
        browserTaskId: scope.browserTaskId,
        runId: scope.runId,
        tabRef: scope.tabRef,
        condition,
      })
    } finally {
      this.invalidateObservation(scope)
    }
  }

  async screenshot(actionScope: BrowserAdapterActionScope): Promise<string | null> {
    const bridge = this.getBridge()
    if (!bridge) throw new Error(NOT_CONNECTED)
    this.resolveActionScope(actionScope, bridge.getPublicState())
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
  /** Injectable live socket generation for reconnect tests. */
  getConnectionGeneration?: () => number
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
      connectionGeneration: opts.getConnectionGeneration?.() ?? 1,
      freshObservation: null,
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
