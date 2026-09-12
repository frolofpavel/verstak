// bridge-client.mjs — Native Messaging client (extension side).
//
// Протокол v1: hello/pair/status/attach/detach/observe/click + observe_request/click_request.
// Нет clipboard fallback. Нет shell. Fail-closed offline.

export const NATIVE_HOST_NAME = 'ru.verstak.browser_bridge'
export const BRIDGE_PROTOCOL_VERSION = 1
export const EXTENSION_ID_EXPECTED = 'jbhddmgcngdchlgmilphmbbcccfigadb'

/**
 * @typedef {'offline'|'connecting'|'paired'|'attached'|'error'} BridgeUiState
 */

export function makeRequestId() {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function createBridgeClient(opts = {}) {
  const hostName = opts.hostName || NATIVE_HOST_NAME
  const extensionId = opts.extensionId || (typeof chrome !== 'undefined' && chrome.runtime?.id) || EXTENSION_ID_EXPECTED

  /** @type {chrome.runtime.Port | null} */
  let port = null
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map()
  /** @type {BridgeUiState} */
  let uiState = 'offline'
  let sessionId = null
  let pairingToken = null
  let browserTaskId = null
  let runId = null
  let attachedTab = null
  let lastError = null
  /** @type {Array<(s: any) => void>} */
  const listeners = []
  let connectAttempts = 0

  function emit() {
    const snap = getState()
    for (const fn of listeners) {
      try { fn(snap) } catch { /* ignore */ }
    }
  }

  function getState() {
    return {
      ui: uiState,
      sessionId,
      pairingToken,
      browserTaskId,
      runId,
      attachedTab,
      lastError,
      connected: !!port,
    }
  }

  function setError(msg) {
    lastError = msg
    uiState = 'error'
    emit()
  }

  function clearPending(err) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err || new Error('bridge closed'))
      pending.delete(id)
    }
  }

  function sendRaw(msg) {
    if (!port) throw new Error('native port offline')
    port.postMessage(msg)
  }

  function request(msg, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!port) {
        reject(new Error('native port offline'))
        return
      }
      const requestId = msg.requestId || makeRequestId()
      const full = { ...msg, v: BRIDGE_PROTOCOL_VERSION, requestId }
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`timeout ${full.type}`))
      }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      try {
        sendRaw(full)
      } catch (err) {
        clearTimeout(timer)
        pending.delete(requestId)
        reject(err)
      }
    })
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    const requestId = msg.requestId
    if (msg.type === 'task_event') {
      if (typeof opts.onTaskEvent === 'function') {
        try { opts.onTaskEvent(msg) } catch { /* ignore */ }
      }
      return
    }
    if (msg.type === 'observe_request') {
      // Handled by external handler (background sets it).
      if (typeof opts.onObserveRequest === 'function') {
        Promise.resolve(opts.onObserveRequest(msg)).catch(() => {})
      }
      return
    }
    if (msg.type === 'click_request') {
      if (typeof opts.onClickRequest === 'function') {
        Promise.resolve(opts.onClickRequest(msg)).catch(() => {})
      }
      return
    }
    if (msg.type === 'navigate_request') {
      if (typeof opts.onNavigateRequest === 'function') {
        Promise.resolve(opts.onNavigateRequest(msg)).catch(() => {})
      }
      return
    }
    if (msg.type === 'scroll_request') {
      if (typeof opts.onScrollRequest === 'function') {
        Promise.resolve(opts.onScrollRequest(msg)).catch(() => {})
      }
      return
    }
    if (msg.type === 'focus_request') {
      if (typeof opts.onFocusRequest === 'function') {
        Promise.resolve(opts.onFocusRequest(msg)).catch(() => {})
      }
      return
    }
    if (msg.type === 'select_option_request') {
      if (typeof opts.onSelectOptionRequest === 'function') {
        Promise.resolve(opts.onSelectOptionRequest(msg)).catch(() => {})
      }
      return
    }
    if (msg.type === 'wait_for_request') {
      if (typeof opts.onWaitForRequest === 'function') {
        Promise.resolve(opts.onWaitForRequest(msg)).catch(() => {})
      }
      return
    }
    if (msg.type === 'type_text_request') {
      if (typeof opts.onTypeTextRequest === 'function') {
        Promise.resolve(opts.onTypeTextRequest(msg)).catch(() => {})
      }
      return
    }
    if (msg.type === 'clear_field_request') {
      if (typeof opts.onClearFieldRequest === 'function') {
        Promise.resolve(opts.onClearFieldRequest(msg)).catch(() => {})
      }
      return
    }
    if (msg.type === 'toggle_request') {
      if (typeof opts.onToggleRequest === 'function') {
        Promise.resolve(opts.onToggleRequest(msg)).catch(() => {})
      }
      return
    }
    if (msg.type === 'press_key_request') {
      if (typeof opts.onPressKeyRequest === 'function') {
        Promise.resolve(opts.onPressKeyRequest(msg)).catch(() => {})
      }
      return
    }
    if (requestId && pending.has(requestId)) {
      const p = pending.get(requestId)
      pending.delete(requestId)
      clearTimeout(p.timer)
      if (msg.type === 'error' && !msg.ok) {
        p.reject(new Error(msg.message || msg.code || 'error'))
        return
      }
      p.resolve(msg)
      return
    }
    if (msg.type === 'error') {
      setError(msg.message || msg.code || 'error')
    }
  }

  function disconnect() {
    if (port) {
      try { port.disconnect() } catch { /* ignore */ }
      port = null
    }
    uiState = 'offline'
    clearPending(new Error('disconnected'))
    emit()
  }

  let lastConnectTime = 0

  function connect() {
    if (port) return true
    const now = Date.now()
    if (connectAttempts > 3 && now - lastConnectTime < Math.min(30000, 1000 * Math.pow(2, connectAttempts - 3))) {
      lastError = `backoff подключения (${Math.ceil((Math.min(30000, 1000 * Math.pow(2, connectAttempts - 3)) - (now - lastConnectTime))/1000)}s)`
      uiState = 'offline'
      emit()
      return false
    }
    lastConnectTime = now
    if (typeof chrome === 'undefined' || !chrome.runtime?.connectNative) {
      uiState = 'offline'
      lastError = 'nativeMessaging API недоступен'
      emit()
      return false
    }
    uiState = 'connecting'
    lastError = null
    connectAttempts += 1
    emit()
    try {
      port = chrome.runtime.connectNative(hostName)
    } catch (err) {
      port = null
      uiState = 'offline'
      lastError = err?.message || String(err)
      emit()
      return false
    }
    port.onMessage.addListener(onMessage)
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message
      port = null
      uiState = 'offline'
      if (err) lastError = err
      clearPending(new Error(err || 'native disconnect'))
      emit()
    })
    return true
  }

  async function hello() {
    if (!connect()) throw new Error(lastError || 'offline')
    const res = await request({
      type: 'hello',
      client: 'chrome-extension',
      extensionId,
    })
    if (res.type === 'error') throw new Error(res.message)
    return res
  }

  async function pair(token, sid) {
    if (!connect()) throw new Error(lastError || 'offline')
    const useToken = token || pairingToken || undefined
    const useSid = sid || sessionId || undefined
    // Empty pair is rejected by desktop (fail-closed). Require bootstrap or durable creds.
    if (!useToken && !useSid) {
      throw new Error('нужен pairing code с desktop или сохранённые credentials')
    }
    const res = await request({
      type: 'pair',
      pairingToken: useToken,
      sessionId: useSid,
    })
    if (res.type === 'error' || res.ok === false) {
      throw new Error(res.message || 'pair failed')
    }
    sessionId = res.sessionId || sessionId
    // Durable credential from desktop — store, never log full value.
    if (typeof res.pairingToken === 'string' && res.pairingToken) {
      pairingToken = res.pairingToken
    }
    browserTaskId = res.browserTaskId ?? browserTaskId
    runId = res.runId ?? runId
    if (res.state) uiState = res.state
    else uiState = 'paired'
    lastError = null
    connectAttempts = 0
    // Persist for restart restore (pairing only — no auto browser action).
    try {
      await chrome.storage.local.set({
        verstakSessionId: sessionId,
        verstakPairingToken: pairingToken,
        verstakBrowserTaskId: browserTaskId,
        verstakRunId: runId,
      })
    } catch { /* storage may be denied in tests */ }
    emit()
    return res
  }

  async function status() {
    if (!connect()) {
      return { state: 'offline', desktopOnline: false }
    }
    try {
      const res = await request({ type: 'status' })
      if (res.ok) {
        uiState = res.state || uiState
        sessionId = res.sessionId ?? sessionId
        browserTaskId = res.browserTaskId ?? browserTaskId
        runId = res.runId ?? runId
        attachedTab = res.attachedTab ?? attachedTab
        lastError = res.error || null
        emit()
      }
      return res
    } catch (err) {
      uiState = 'offline'
      lastError = err?.message || String(err)
      emit()
      throw err
    }
  }

  async function attach(tab) {
    const res = await request({ type: 'attach', tab, browserTaskId: browserTaskId || undefined })
    if (res.ok) {
      attachedTab = tab
      browserTaskId = res.browserTaskId || browserTaskId
      uiState = res.state || 'attached'
      lastError = null
      emit()
    }
    return res
  }

  async function detach(tabRef) {
    const res = await request({
      type: 'detach',
      tabRef: tabRef || attachedTab?.tabRef,
      browserTaskId: browserTaskId || undefined,
    })
    if (res.ok) {
      attachedTab = null
      uiState = res.state || 'paired'
      emit()
    }
    return res
  }

  async function sendObserve(payload) {
    return request({
      type: 'observe',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      snapshot: payload.snapshot,
    }, 20000)
  }

  async function sendClickResult(payload) {
    return request({
      type: 'click',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      elementRef: payload.elementRef,
      observationVersion: payload.observationVersion,
      ok: payload.ok === true,
      finalUrl: payload.finalUrl,
      error: payload.error,
    }, 15000)
  }

  async function sendNavigateResult(payload) {
    return request({
      type: 'navigate',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      ok: payload.ok === true,
      finalUrl: payload.finalUrl,
      title: payload.title,
      error: payload.error,
    }, 15000)
  }

  async function sendScrollResult(payload) {
    return request({
      type: 'scroll',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      ok: payload.ok === true,
      error: payload.error,
    }, 15000)
  }

  async function sendFocusResult(payload) {
    return request({
      type: 'focus',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      ok: payload.ok === true,
      error: payload.error,
    }, 15000)
  }

  async function sendSelectOptionResult(payload) {
    return request({
      type: 'select_option',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      ok: payload.ok === true,
      error: payload.error,
    }, 15000)
  }

  async function sendWaitForResult(payload) {
    return request({
      type: 'wait_for',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      ok: payload.ok === true,
      reason: payload.reason,
      error: payload.error,
    }, 35000)
  }

  async function sendTypeTextResult(payload) {
    return request({
      type: 'type_text',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      elementRef: payload.elementRef,
      ok: payload.ok === true,
      error: payload.error,
    }, 15000)
  }

  async function sendClearFieldResult(payload) {
    return request({
      type: 'clear_field',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      elementRef: payload.elementRef,
      ok: payload.ok === true,
      error: payload.error,
    }, 15000)
  }

  async function sendToggleResult(payload) {
    return request({
      type: 'toggle',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      elementRef: payload.elementRef,
      ok: payload.ok === true,
      error: payload.error,
    }, 15000)
  }

  async function sendPressKeyResult(payload) {
    return request({
      type: 'press_key',
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      tabRef: payload.tabRef,
      elementRef: payload.elementRef,
      ok: payload.ok === true,
      error: payload.error,
    }, 15000)
  }

  async function submitTask(prompt) {
    return request({ type: 'task_submit', prompt }, 30_000)
  }

  async function resolveTaskApproval(payload) {
    return request({
      type: 'task_approval',
      actionId: payload.actionId,
      approvalDigest: payload.approvalDigest,
      browserTaskId: payload.browserTaskId,
      runId: payload.runId,
      sendId: payload.sendId,
      approved: payload.approved === true,
    })
  }

  async function cancelTask(sendId) {
    return request({ type: 'task_cancel', sendId })
  }

  async function restoreFromStorage() {
    try {
      const data = await chrome.storage.local.get([
        'verstakSessionId',
        'verstakPairingToken',
        'verstakBrowserTaskId',
        'verstakRunId',
      ])
      if (data.verstakSessionId) sessionId = data.verstakSessionId
      if (data.verstakPairingToken) pairingToken = data.verstakPairingToken
      if (data.verstakBrowserTaskId) browserTaskId = data.verstakBrowserTaskId
      if (data.verstakRunId) runId = data.verstakRunId
    } catch { /* ignore */ }
  }

  function setPairingToken(t) {
    pairingToken = t
  }

  function onState(fn) {
    listeners.push(fn)
    return () => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    }
  }

  return {
    getState,
    connect,
    disconnect,
    hello,
    pair,
    status,
    attach,
    detach,
    sendObserve,
    sendClickResult,
    sendNavigateResult,
    sendScrollResult,
    sendFocusResult,
    sendSelectOptionResult,
    sendWaitForResult,
    sendTypeTextResult,
    sendClearFieldResult,
    sendToggleResult,
    sendPressKeyResult,
    submitTask,
    resolveTaskApproval,
    cancelTask,
    restoreFromStorage,
    setPairingToken,
    onState,
    setObserveRequestHandler(fn) {
      opts.onObserveRequest = fn
    },
    setClickRequestHandler(fn) {
      opts.onClickRequest = fn
    },
    setNavigateRequestHandler(fn) {
      opts.onNavigateRequest = fn
    },
    setScrollRequestHandler(fn) {
      opts.onScrollRequest = fn
    },
    setFocusRequestHandler(fn) {
      opts.onFocusRequest = fn
    },
    setSelectOptionRequestHandler(fn) {
      opts.onSelectOptionRequest = fn
    },
    setWaitForRequestHandler(fn) {
      opts.onWaitForRequest = fn
    },
    setTypeTextRequestHandler(fn) {
      opts.onTypeTextRequest = fn
    },
    setClearFieldRequestHandler(fn) {
      opts.onClearFieldRequest = fn
    },
    setToggleRequestHandler(fn) {
      opts.onToggleRequest = fn
    },
    setPressKeyRequestHandler(fn) {
      opts.onPressKeyRequest = fn
    },
    setTaskEventHandler(fn) {
      opts.onTaskEvent = fn
    },
  }
}
