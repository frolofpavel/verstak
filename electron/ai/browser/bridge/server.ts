// server.ts — bridge endpoint внутри Verstak main process.
//
// Chrome Native Messaging host (тонкий relay) подключается к named pipe /
// unix socket. Desktop обрабатывает hello/pair/status/attach/detach/observe/click
// и отдаёт ответы. Observe/click-request от controller → extension.
//
// Security (EXT-B1-R1 + EXT-C1):
//   connected → exact hello → authenticated pair → attach → observe/click
//   Per-socket auth; persisted pairing file ≠ auto-auth for new socket.
//   Observe/click response must match expected browserTaskId/runId/tabRef/(elementRef).
//   Нет shell/exec; oversize/malformed → error. Click one-shot per requestId.

import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_PIPE_BASENAME,
  EXTENSION_ID,
  NATIVE_HOST_NAME,
} from './constants'
import {
  type BridgeInbound,
  type BridgeOutbound,
  type BridgePageSnapshot,
  type BridgeTabInfo,
  type ClickRequestMsg,
  type ObserveRequestMsg,
  NativeFrameDecoder,
  encodeNativeFrame,
  makeError,
  parseInboundMessage,
  serializeOutbound,
} from './protocol'
import {
  createBridgeSessionStore,
  tokenFingerprint,
  type BootstrapCode,
  type BridgeSessionStore,
  type BridgeSessionState,
} from './session'

export interface PendingObserve {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  resolve: (snapshot: BridgePageSnapshot) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PendingClick {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  observationVersion: number
  resolve: (result: { ok: true; finalUrl: string } | { ok: false; error: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** One-shot: response already consumed. */
  settled: boolean
}

export interface PendingNavigate {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  url: string
  resolve: (result: { ok: true; finalUrl: string; title: string } | { ok: false; error: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PendingScroll {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  resolve: (result: { ok: true } | { ok: false; error: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PendingFocus {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  resolve: (result: { ok: true } | { ok: false; error: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PendingSelect {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  resolve: (result: { ok: true } | { ok: false; error: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PendingWaitFor {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  resolve: (result: { ok: true; reason?: string } | { ok: false; reason?: string; error?: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PendingTypeText {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  resolve: (result: { ok: true } | { ok: false; error: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PendingClearField {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  resolve: (result: { ok: true } | { ok: false; error: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PendingToggle {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  resolve: (result: { ok: true } | { ok: false; error: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PendingPressKey {
  requestId: string
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  resolve: (result: { ok: true } | { ok: false; error: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Auth state machine per TCP/NM client socket — not shared across clients. */
interface SocketAuth {
  socket: Socket
  /** Exact hello with allowlisted extensionId succeeded. */
  helloOk: boolean
  /** Successful pair on THIS socket. */
  authenticated: boolean
  extensionId: string | null
}

export interface BridgeServerDeps {
  /** Каталог userData/storage для pairing file + socket path file. */
  stateDir: string
  /** Текущий active browserTaskId (из controller/main). */
  getActiveBrowserTaskId: () => string | null
  /** Текущий active runId. */
  getActiveRunId: () => string | null
  /** Persist task tab на browser task. */
  onAttach?: (browserTaskId: string, tab: BridgeTabInfo) => void
  onDetach?: (browserTaskId: string) => void
  /** Когда extension прислал observe push (не response) — optional hook. */
  onObservePush?: (input: {
    browserTaskId: string
    runId: string
    tabRef: string
    snapshot: BridgePageSnapshot
  }) => void
  onTaskSubmit?: (prompt: string) => Promise<{ sendId: number; browserTaskId: string; chatId: number }>
  onTaskApproval?: (input: {
    actionId: string
    approvalDigest: string
    browserTaskId: string
    runId: string
    sendId: number
    approved: boolean
  }) => void
  onTaskCancel?: (sendId: number) => void
  log?: (event: string, detail?: Record<string, unknown>) => void
  observeTimeoutMs?: number
}

export interface BridgeServer {
  start(): Promise<string>
  stop(): Promise<void>
  getEndpointPath(): string | null
  getSession(): BridgeSessionStore
  getPublicState(): BridgeSessionState
  /** Controller → extension: request observe, wait for snapshot. */
  requestObserve(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    timeoutMs?: number
  }): Promise<BridgePageSnapshot>
  /**
   * Controller → extension: one DOM click by elementRef (after approval).
   * Response must match browserTaskId/runId/tabRef/elementRef. Replay of same
   * requestId is ignored (one-shot).
   */
  requestClick(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
    origin?: string
    timeoutMs?: number
  }): Promise<{ ok: true; finalUrl: string } | { ok: false; error: string }>
  requestNavigate(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    url: string
    timeoutMs?: number
  }): Promise<{ ok: true; finalUrl: string; title: string } | { ok: false; error: string }>
  requestScroll(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef?: string
    delta?: { x?: number; y?: number }
    timeoutMs?: number
  }): Promise<{ ok: true } | { ok: false; error: string }>
  requestFocus(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
    timeoutMs?: number
  }): Promise<{ ok: true } | { ok: false; error: string }>
  requestSelectOption(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
    value: string
    timeoutMs?: number
  }): Promise<{ ok: true } | { ok: false; error: string }>
  requestWaitFor(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    condition: { elementRef?: string; text?: string; url?: string; timeoutMs?: number }
    timeoutMs?: number
  }): Promise<{ ok: true; reason?: string } | { ok: false; reason?: string; error?: string }>
  requestTypeText(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
    text: string
    clearFirst?: boolean
    submitEnter?: boolean
    timeoutMs?: number
  }): Promise<{ ok: true } | { ok: false; error: string }>
  requestClearField(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
    timeoutMs?: number
  }): Promise<{ ok: true } | { ok: false; error: string }>
  requestToggle(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
    timeoutMs?: number
  }): Promise<{ ok: true } | { ok: false; error: string }>
  requestPressKey(input: {
    browserTaskId: string
    runId: string
    tabRef: string
    elementRef: string
    observationVersion: number
    key: string
    timeoutMs?: number
  }): Promise<{ ok: true } | { ok: false; error: string }>
  isExtensionConnected(): boolean
  /** True only when current socket completed hello+pair. */
  isExtensionAuthenticated(): boolean
  pushTaskEvent(input: { requestId: string; sendId: number; event: unknown }): void
  setActiveLineage(browserTaskId: string | null, runId: string | null): void
  /**
   * Выдать одноразовый bootstrap code для первого pair.
   * Полный code возвращается caller'у (UI); в logs — только fingerprint.
   */
  issuePairingCode(opts?: { ttlMs?: number }): BootstrapCode
  getActivePairingCode(): BootstrapCode | null
}

function pipePath(stateDir: string): string {
  if (process.platform === 'win32') {
    const slug = Buffer.from(stateDir).toString('base64url').slice(0, 24)
    return `\\\\.\\pipe\\${BRIDGE_PIPE_BASENAME}-${slug}`
  }
  const sock = join(stateDir, `${BRIDGE_PIPE_BASENAME}.sock`)
  return sock
}

/** Normalize origin/host for compare (strip scheme, trailing slash). */
function normalizeOrigin(raw: string): string {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).host
  } catch { /* fallthrough */ }
  return s.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export function createBridgeServer(deps: BridgeServerDeps): BridgeServer {
  const session = createBridgeSessionStore({ stateDir: deps.stateDir })
  // Не auto-auth: durable file может существовать, но socket стартует unauthenticated.
  session.setDesktopOnline(true)

  let server: Server | null = null
  let endpoint: string | null = null
  let client: Socket | null = null
  let socketAuth: SocketAuth | null = null
  const decoder = new NativeFrameDecoder()
  const pendingObserves = new Map<string, PendingObserve>()
  const pendingClicks = new Map<string, PendingClick>()
  const pendingNavigates = new Map<string, PendingNavigate>()
  const pendingScrolls = new Map<string, PendingScroll>()
  const pendingFocuses = new Map<string, PendingFocus>()
  const pendingSelects = new Map<string, PendingSelect>()
  const pendingWaitFors = new Map<string, PendingWaitFor>()
  const pendingTypeTexts = new Map<string, PendingTypeText>()
  const pendingClearFields = new Map<string, PendingClearField>()
  const pendingToggles = new Map<string, PendingToggle>()
  const pendingPressKeys = new Map<string, PendingPressKey>()
  const observeTimeout = deps.observeTimeoutMs ?? 15_000
  const clickTimeout = 12_000
  const log = deps.log ?? (() => {})

  function send(msg: BridgeOutbound): void {
    if (!client || client.destroyed) return
    try {
      const json = serializeOutbound(msg)
      client.write(encodeNativeFrame(json))
    } catch (err) {
      log('bridge.send_fail', { err: err instanceof Error ? err.message : String(err) })
    }
  }

  function requireHello(requestId: string): boolean {
    if (!socketAuth?.helloOk) {
      send(makeError(requestId, 'not_hello', 'сначала hello с exact extensionId'))
      return false
    }
    return true
  }

  function requireAuth(requestId: string): boolean {
    if (!requireHello(requestId)) return false
    if (!socketAuth?.authenticated) {
      send(makeError(requestId, 'not_paired', 'сначала pair на этом соединении'))
      return false
    }
    return true
  }

  function lineageMatches(
    expected: { browserTaskId: string; runId: string; tabRef: string },
    got: { browserTaskId: string; runId: string; tabRef: string },
  ): boolean {
    return (
      expected.browserTaskId === got.browserTaskId
      && expected.runId === got.runId
      && expected.tabRef === got.tabRef
    )
  }

  function handleInbound(msg: BridgeInbound): void {
    switch (msg.type) {
      case 'hello': {
        // Fail-closed: missing OR foreign extensionId → reject.
        if (!msg.extensionId) {
          send(makeError(msg.requestId, 'forbidden_extension', 'extensionId обязателен'))
          return
        }
        if (msg.extensionId !== EXTENSION_ID) {
          send(makeError(
            msg.requestId,
            'forbidden_extension',
            `extension id ${msg.extensionId} не в allowlist`,
          ))
          return
        }
        if (!socketAuth || socketAuth.socket !== client) {
          send(makeError(msg.requestId, 'no_socket', 'нет активного socket'))
          return
        }
        socketAuth.helloOk = true
        socketAuth.extensionId = msg.extensionId
        // hello ≠ pair: live auth still cleared.
        socketAuth.authenticated = false
        session.setConnected(true)
        session.setError(null)
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'hello',
          requestId: msg.requestId,
          ok: true,
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          hostName: NATIVE_HOST_NAME,
          desktopOnline: true,
        })
        return
      }
      case 'pair': {
        if (!requireHello(msg.requestId)) return
        const verified = session.verifyPairing(msg.pairingToken, msg.sessionId)
        if (!verified.ok) {
          session.setError(verified.reason)
          send(makeError(msg.requestId, 'pair_rejected', verified.reason))
          return
        }
        session.markPaired(verified.session)
        if (socketAuth) socketAuth.authenticated = true
        const bt = deps.getActiveBrowserTaskId()
        const run = deps.getActiveRunId()
        session.setActiveRun(bt, run)
        const st = session.getState()
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'pair',
          requestId: msg.requestId,
          ok: true,
          sessionId: verified.session.sessionId,
          // Durable credential for extension storage — not logged.
          pairingToken: verified.session.pairingToken,
          browserTaskId: st.browserTaskId,
          runId: st.runId,
          state: st.ui,
        })
        log('bridge.paired', {
          sessionId: verified.session.sessionId,
          isBootstrap: verified.isBootstrap,
          tokenFp: tokenFingerprint(verified.session.pairingToken),
        })
        return
      }
      case 'status': {
        // Pre-pair: no lineage leak.
        if (!socketAuth?.authenticated) {
          send({
            v: BRIDGE_PROTOCOL_VERSION,
            type: 'status',
            requestId: msg.requestId,
            ok: true,
            state: session.getState().desktopOnline
              ? (socketAuth?.helloOk ? 'connecting' : 'connecting')
              : 'offline',
            desktopOnline: true,
            sessionId: null,
            browserTaskId: null,
            runId: null,
            attachedTab: null,
            error: session.getState().lastError,
          })
          return
        }
        const st = session.getState()
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'status',
          requestId: msg.requestId,
          ok: true,
          state: st.ui,
          desktopOnline: true,
          sessionId: st.sessionId,
          browserTaskId: st.browserTaskId ?? deps.getActiveBrowserTaskId(),
          runId: st.runId ?? deps.getActiveRunId(),
          attachedTab: st.attachedTab,
          error: st.lastError,
        })
        return
      }
      case 'task_submit': {
        if (!requireAuth(msg.requestId)) return
        if (!deps.onTaskSubmit) {
          send(makeError(msg.requestId, 'task_unavailable', 'Запуск задач из браузера не подключён'))
          return
        }
        void deps.onTaskSubmit(msg.prompt).then((result) => {
          send({
            v: BRIDGE_PROTOCOL_VERSION,
            type: 'task_submit',
            requestId: msg.requestId,
            ok: true,
            ...result,
          })
        }).catch((err) => {
          send(makeError(msg.requestId, 'task_start_failed', err instanceof Error ? err.message : String(err)))
        })
        return
      }
      case 'task_approval': {
        if (!requireAuth(msg.requestId)) return
        deps.onTaskApproval?.(msg)
        send({ v: BRIDGE_PROTOCOL_VERSION, type: 'task_approval', requestId: msg.requestId, ok: true })
        return
      }
      case 'task_cancel': {
        if (!requireAuth(msg.requestId)) return
        deps.onTaskCancel?.(msg.sendId)
        send({ v: BRIDGE_PROTOCOL_VERSION, type: 'task_cancel', requestId: msg.requestId, ok: true })
        return
      }
      case 'attach': {
        if (!requireAuth(msg.requestId)) return
        // Prefer explicit browserTaskId from msg or active desktop lineage.
        // Never invent attach auth from global file alone (already gated by requireAuth).
        const bt =
          msg.browserTaskId
          || deps.getActiveBrowserTaskId()
          || session.getState().browserTaskId
          || `bt-ext-${randomUUID().slice(0, 8)}`
        session.attachTab(msg.tab, bt)
        try {
          deps.onAttach?.(bt, msg.tab)
        } catch (err) {
          log('bridge.on_attach_fail', { err: String(err) })
        }
        const st = session.getState()
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'attach',
          requestId: msg.requestId,
          ok: true,
          browserTaskId: bt,
          tabRef: msg.tab.tabRef,
          state: st.ui,
        })
        log('bridge.attach', { browserTaskId: bt, tabRef: msg.tab.tabRef, origin: msg.tab.origin })
        return
      }
      case 'detach': {
        if (!requireAuth(msg.requestId)) return
        const st0 = session.getState()
        const bt = msg.browserTaskId || st0.browserTaskId
        session.detachTab()
        if (bt) {
          try { deps.onDetach?.(bt) } catch { /* ignore */ }
        }
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'detach',
          requestId: msg.requestId,
          ok: true,
          state: session.getState().ui,
        })
        log('bridge.detach', { browserTaskId: bt })
        return
      }
      case 'observe': {
        if (!requireAuth(msg.requestId)) return

        const pending = pendingObserves.get(msg.requestId)
        if (pending) {
          if (!lineageMatches(pending, msg)) {
            // Mismatch: do NOT resolve pending, do NOT pass snapshot to agent.
            send(makeError(
              msg.requestId,
              'lineage_mismatch',
              'observe browserTaskId/runId/tabRef не совпали с ожидаемыми (fail-closed)',
            ))
            log('bridge.observe_lineage_mismatch', {
              expected: {
                browserTaskId: pending.browserTaskId,
                runId: pending.runId,
                tabRef: pending.tabRef,
              },
              got: {
                browserTaskId: msg.browserTaskId,
                runId: msg.runId,
                tabRef: msg.tabRef,
              },
            })
            return
          }
          clearTimeout(pending.timer)
          pendingObserves.delete(msg.requestId)
          pending.resolve(msg.snapshot)
          send({
            v: BRIDGE_PROTOCOL_VERSION,
            type: 'observe',
            requestId: msg.requestId,
            ok: true,
            observationId: `obs-${Date.now()}`,
            observationVersion: 0,
            browserTaskId: msg.browserTaskId,
            runId: msg.runId,
          })
          return
        }

        // Unsolicited observe: only authenticated+attached + active lineage.
        const st = session.getState()
        if (!st.attachedTab) {
          send(makeError(msg.requestId, 'not_attached', 'unsolicited observe без attach'))
          return
        }
        const activeBt = st.browserTaskId ?? deps.getActiveBrowserTaskId()
        const activeRun = st.runId ?? deps.getActiveRunId()
        const activeTab = st.attachedTab.tabRef
        if (!activeBt || !activeRun || !activeTab) {
          send(makeError(msg.requestId, 'no_lineage', 'нет active lineage для unsolicited observe'))
          return
        }
        if (!lineageMatches(
          { browserTaskId: activeBt, runId: activeRun, tabRef: activeTab },
          msg,
        )) {
          send(makeError(
            msg.requestId,
            'lineage_mismatch',
            'unsolicited observe lineage mismatch (fail-closed)',
          ))
          return
        }
        try {
          deps.onObservePush?.({
            browserTaskId: msg.browserTaskId,
            runId: msg.runId,
            tabRef: msg.tabRef,
            snapshot: msg.snapshot,
          })
        } catch { /* ignore */ }
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'observe',
          requestId: msg.requestId,
          ok: true,
          observationId: `obs-push-${Date.now()}`,
          observationVersion: 0,
          browserTaskId: msg.browserTaskId,
          runId: msg.runId,
        })
        return
      }
      case 'click': {
        if (!requireAuth(msg.requestId)) return
        const pending = pendingClicks.get(msg.requestId)
        if (!pending) {
          // Unsolicited click result or replay after settle — ignore, no second execute.
          send(makeError(msg.requestId, 'no_pending_click', 'нет pending click / already settled'))
          log('bridge.click_unsolicited_or_replay', { requestId: msg.requestId })
          return
        }
        if (pending.settled) {
          send(makeError(msg.requestId, 'click_replay', 'click already settled (one-shot)'))
          return
        }
        if (
          !lineageMatches(pending, msg)
          || pending.elementRef !== msg.elementRef
        ) {
          send(makeError(
            msg.requestId,
            'lineage_mismatch',
            'click browserTaskId/runId/tabRef/elementRef mismatch (fail-closed)',
          ))
          log('bridge.click_lineage_mismatch', {
            expected: {
              browserTaskId: pending.browserTaskId,
              runId: pending.runId,
              tabRef: pending.tabRef,
              elementRef: pending.elementRef,
            },
            got: {
              browserTaskId: msg.browserTaskId,
              runId: msg.runId,
              tabRef: msg.tabRef,
              elementRef: msg.elementRef,
            },
          })
          return
        }
        pending.settled = true
        clearTimeout(pending.timer)
        pendingClicks.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true, finalUrl: msg.finalUrl || '' })
          send({
            v: BRIDGE_PROTOCOL_VERSION,
            type: 'click',
            requestId: msg.requestId,
            ok: true,
            browserTaskId: msg.browserTaskId,
            runId: msg.runId,
            tabRef: msg.tabRef,
            elementRef: msg.elementRef,
          })
        } else {
          pending.resolve({ ok: false, error: msg.error || 'click failed' })
          send(makeError(msg.requestId, 'click_failed', msg.error || 'click failed'))
        }
        return
      }
      case 'navigate': {
        if (!requireAuth(msg.requestId)) return
        const pending = pendingNavigates.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingNavigates.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true, finalUrl: msg.finalUrl || pending.url, title: msg.title || '' })
        } else {
          pending.resolve({ ok: false, error: msg.error || 'navigate failed' })
        }
        return
      }
      case 'scroll': {
        if (!requireAuth(msg.requestId)) return
        const pending = pendingScrolls.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingScrolls.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true })
        } else {
          pending.resolve({ ok: false, error: msg.error || 'scroll failed' })
        }
        return
      }
      case 'focus': {
        if (!requireAuth(msg.requestId)) return
        const pending = pendingFocuses.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingFocuses.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true })
        } else {
          pending.resolve({ ok: false, error: msg.error || 'focus failed' })
        }
        return
      }
      case 'select_option': {
        if (!requireAuth(msg.requestId)) return
        const pending = pendingSelects.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingSelects.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true })
        } else {
          pending.resolve({ ok: false, error: msg.error || 'select_option failed' })
        }
        return
      }
      case 'wait_for': {
        if (!requireAuth(msg.requestId)) return
        const pending = pendingWaitFors.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingWaitFors.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true, reason: msg.reason })
        } else {
          pending.resolve({ ok: false, reason: msg.reason, error: msg.error || 'wait_for failed' })
        }
        return
      }
      case 'type_text': {
        if (!requireAuth(msg.requestId)) return
        const pending = pendingTypeTexts.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingTypeTexts.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true })
        } else {
          pending.resolve({ ok: false, error: msg.error || 'type_text failed' })
        }
        return
      }
      case 'clear_field': {
        if (!requireAuth(msg.requestId)) return
        const pending = pendingClearFields.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingClearFields.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true })
        } else {
          pending.resolve({ ok: false, error: msg.error || 'clear_field failed' })
        }
        return
      }
      case 'toggle': {
        if (!requireAuth(msg.requestId)) return
        const pending = pendingToggles.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingToggles.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true })
        } else {
          pending.resolve({ ok: false, error: msg.error || 'toggle failed' })
        }
        return
      }
      case 'press_key': {
        if (!requireAuth(msg.requestId)) return
        const pending = pendingPressKeys.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingPressKeys.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true })
        } else {
          pending.resolve({ ok: false, error: msg.error || 'press_key failed' })
        }
        return
      }
      case 'error': {
        session.setError(msg.message)
        log('bridge.client_error', { code: msg.code, message: msg.message })
        return
      }
    }
  }

  function onSocketData(chunk: Buffer): void {
    const frames = decoder.push(chunk)
    for (const frame of frames) {
      if (!frame.ok) {
        send(makeError(undefined, frame.code, frame.message))
        continue
      }
      const parsed = parseInboundMessage(frame.json)
      if (!parsed.ok) {
        send(makeError(undefined, parsed.code, parsed.message))
        continue
      }
      handleInbound(parsed.msg)
    }
  }

  function rejectPending(reason: string): void {
    for (const [id, p] of pendingObserves) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
      pendingObserves.delete(id)
    }
    for (const [id, p] of pendingClicks) {
      clearTimeout(p.timer)
      if (!p.settled) p.reject(new Error(reason))
      pendingClicks.delete(id)
    }
  }

  function detachClient(): void {
    if (client) {
      client.removeAllListeners()
      try { client.destroy() } catch { /* ignore */ }
      client = null
    }
    socketAuth = null
    session.setConnected(false)
    // New socket must re-pair; attach/action state does not survive disconnect.
    session.clearLiveAuth()
    rejectPending('bridge: extension disconnected')
  }

  return {
    async start(): Promise<string> {
      if (server) return endpoint!

      mkdirSync(deps.stateDir, { recursive: true })
      const path = pipePath(deps.stateDir)
      endpoint = path

      if (process.platform !== 'win32' && existsSync(path)) {
        try { unlinkSync(path) } catch { /* ignore */ }
      }

      server = createServer((socket) => {
        // One authenticated client at a time — second client rejected.
        if (client && !client.destroyed) {
          try { socket.destroy() } catch { /* ignore */ }
          log('bridge.second_client_rejected', {})
          return
        }
        client = socket
        // Fresh unauthenticated state — persisted pairing does NOT authorize.
        socketAuth = {
          socket,
          helloOk: false,
          authenticated: false,
          extensionId: null,
        }
        session.setConnected(true)
        session.setError(null)
        // clearLiveAuth already ensures no inherited attach from previous client.
        session.clearLiveAuth()
        log('bridge.client_connected', {})
        socket.on('data', onSocketData)
        socket.on('error', (err) => {
          log('bridge.socket_error', { err: err.message })
          detachClient()
        })
        socket.on('close', () => {
          log('bridge.client_closed', {})
          detachClient()
        })
      })

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(path, () => {
          server!.off('error', reject)
          resolve()
        })
      })

      writeFileSync(
        join(deps.stateDir, 'browser-bridge-endpoint.json'),
        JSON.stringify({ path, hostName: NATIVE_HOST_NAME, pid: process.pid, at: Date.now() }, null, 2),
        'utf8',
      )
      log('bridge.server_started', { path })
      return path
    },

    async stop(): Promise<void> {
      detachClient()
      session.setDesktopOnline(false)
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve())
        })
        server = null
      }
      if (process.platform !== 'win32' && endpoint && existsSync(endpoint)) {
        try { unlinkSync(endpoint) } catch { /* ignore */ }
      }
      endpoint = null
    },

    getEndpointPath() {
      return endpoint
    },

    pushTaskEvent(input) {
      if (!socketAuth?.authenticated) return
      send({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'task_event',
        requestId: input.requestId,
        sendId: input.sendId,
        event: input.event,
      })
    },

    getSession() {
      return session
    },

    getPublicState() {
      return session.getState()
    },

    isExtensionConnected() {
      return !!(client && !client.destroyed && session.getState().connected)
    },

    isExtensionAuthenticated() {
      return !!(socketAuth?.authenticated && client && !client.destroyed)
    },

    setActiveLineage(btId, rId) {
      session.setActiveRun(btId, rId)
    },

    issuePairingCode(opts) {
      const code = session.issueBootstrapCode(opts)
      log('bridge.bootstrap_issued', {
        fp: tokenFingerprint(code.code),
        expiresAt: code.expiresAt,
      })
      return code
    },

    getActivePairingCode() {
      return session.getActiveBootstrapCode()
    },

    requestClick(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) {
        return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      }
      if (st.attachedTab && st.attachedTab.tabRef !== tabRef) {
        return Promise.reject(new Error('wrong tab — click только на attached tab'))
      }
      if (input.origin && st.attachedTab?.origin) {
        const a = normalizeOrigin(input.origin)
        const b = normalizeOrigin(st.attachedTab.origin)
        if (a && b && a !== b) {
          return Promise.reject(new Error(`wrong origin — expected ${b}, got ${a}`))
        }
      }
      const elementRef = String(input.elementRef || '').trim()
      if (!elementRef) {
        return Promise.reject(new Error('elementRef пуст'))
      }
      // Reject raw CSS/JS masquerading as ref.
      if (/[{};<>]|document\.|querySelector|eval\(/i.test(elementRef)) {
        return Promise.reject(new Error('elementRef looks like raw CSS/JS — rejected'))
      }

      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? clickTimeout

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const p = pendingClicks.get(requestId)
          if (p && !p.settled) {
            p.settled = true
            pendingClicks.delete(requestId)
            // Uncertain — no auto-retry.
            reject(new Error(`click timeout ${timeoutMs}ms (uncertain, no auto-retry)`))
          }
        }, timeoutMs)
        pendingClicks.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef,
          observationVersion: input.observationVersion,
          resolve,
          reject,
          timer,
          settled: false,
        })
        const req: ClickRequestMsg = {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'click_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef,
          observationVersion: input.observationVersion,
          origin: input.origin,
        }
        send(req)
        log('bridge.click_request', {
          requestId,
          browserTaskId: input.browserTaskId,
          tabRef,
          elementRef,
          observationVersion: input.observationVersion,
        })
      })
    },

    requestObserve(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) {
        return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      }

      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? observeTimeout

      return new Promise<BridgePageSnapshot>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingObserves.delete(requestId)
          reject(new Error(`observe timeout ${timeoutMs}ms`))
        }, timeoutMs)
        pendingObserves.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          resolve,
          reject,
          timer,
        })
        const req: ObserveRequestMsg = {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'observe_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
        }
        send(req)
      })
    },

    requestNavigate(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? observeTimeout
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingNavigates.delete(requestId)
          reject(new Error(`navigate timeout ${timeoutMs}ms`))
        }, timeoutMs)
        pendingNavigates.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          url: input.url,
          resolve,
          reject,
          timer,
        })
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'navigate_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          url: input.url,
        })
      })
    },

    requestScroll(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? clickTimeout
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingScrolls.delete(requestId)
          reject(new Error(`scroll timeout ${timeoutMs}ms`))
        }, timeoutMs)
        pendingScrolls.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          resolve,
          reject,
          timer,
        })
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'scroll_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          delta: input.delta,
        })
      })
    },

    requestFocus(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? clickTimeout
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingFocuses.delete(requestId)
          reject(new Error(`focus timeout ${timeoutMs}ms`))
        }, timeoutMs)
        pendingFocuses.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          resolve,
          reject,
          timer,
        })
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'focus_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          observationVersion: input.observationVersion,
        })
      })
    },

    requestSelectOption(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? clickTimeout
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingSelects.delete(requestId)
          reject(new Error(`select_option timeout ${timeoutMs}ms`))
        }, timeoutMs)
        pendingSelects.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          resolve,
          reject,
          timer,
        })
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'select_option_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          observationVersion: input.observationVersion,
          value: input.value,
        })
      })
    },

    requestWaitFor(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? Math.max(Number(input.condition?.timeoutMs || 15000), 1000)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingWaitFors.delete(requestId)
          resolve({ ok: false, reason: 'timeout' })
        }, timeoutMs + 2000)
        pendingWaitFors.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          resolve,
          reject,
          timer,
        })
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'wait_for_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          condition: input.condition,
        })
      })
    },

    requestTypeText(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? clickTimeout
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingTypeTexts.delete(requestId)
          reject(new Error(`type_text timeout ${timeoutMs}ms`))
        }, timeoutMs)
        pendingTypeTexts.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          resolve,
          reject,
          timer,
        })
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'type_text_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          observationVersion: input.observationVersion,
          text: input.text,
          clearFirst: input.clearFirst,
          submitEnter: input.submitEnter,
        })
      })
    },

    requestClearField(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? clickTimeout
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingClearFields.delete(requestId)
          reject(new Error(`clear_field timeout ${timeoutMs}ms`))
        }, timeoutMs)
        pendingClearFields.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          resolve,
          reject,
          timer,
        })
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'clear_field_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          observationVersion: input.observationVersion,
        })
      })
    },

    requestToggle(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? clickTimeout
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingToggles.delete(requestId)
          reject(new Error(`toggle timeout ${timeoutMs}ms`))
        }, timeoutMs)
        pendingToggles.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          resolve,
          reject,
          timer,
        })
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'toggle_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          observationVersion: input.observationVersion,
        })
      })
    },

    requestPressKey(input) {
      if (!client || client.destroyed) {
        return Promise.reject(new Error('chrome-extension bridge offline (нет соединения с extension)'))
      }
      if (!socketAuth?.authenticated) {
        return Promise.reject(new Error('chrome-extension не paired — pair из side panel'))
      }
      const st = session.getState()
      const tabRef = input.tabRef || st.attachedTab?.tabRef
      if (!tabRef) return Promise.reject(new Error('нет прикреплённой вкладки — attach tab в side panel'))
      const requestId = randomUUID()
      const timeoutMs = input.timeoutMs ?? clickTimeout
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingPressKeys.delete(requestId)
          reject(new Error(`press_key timeout ${timeoutMs}ms`))
        }, timeoutMs)
        pendingPressKeys.set(requestId, {
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          resolve,
          reject,
          timer,
        })
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'press_key_request',
          requestId,
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef,
          elementRef: input.elementRef,
          observationVersion: input.observationVersion,
          key: input.key,
        })
      })
    },
  }
}
