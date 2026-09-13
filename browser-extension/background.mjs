// Service worker — Connected Eyes + First Hand click (EXT-B1 / EXT-C1).
//
// • exact tab attach + side panel open from one toolbar click
// • Native Messaging bridge (pair / attach / observe_request / click_request)
// • activeTab для выбранной пользователем вкладки + optional durable origin grant
// • click: только opaque elementRef + observationVersion (no raw CSS/JS/CDP)
// • ввод/клики только по opaque elementRef; никаких cookies и clipboard-as-bridge

import {
  capturePageSnapshot,
  performClickByRef,
  performScrollByRef,
  performFocusByRef,
  performSelectByRef,
  performWaitFor,
  performTypeText,
  performClearField,
  performToggle,
  performPressKey,
} from './extractor.mjs'
import { createBridgeClient } from './bridge-client.mjs'

const SCHEME_RE = /^(chrome|chrome-extension|edge|about|devtools|view-source|file|brave|opera|vivaldi):/i

self.addEventListener('install', () => {})
self.addEventListener('activate', () => {})

const bridge = createBridgeClient()
let bridgeConnectPromise = null
let authAvailableRetryPromise = null
let bridgeReconnectTimer = null
let bridgeReconnectAttempt = 0
const BRIDGE_RECONNECT_DELAYS_MS = [250, 1000, 3000]

function isRetryableTransportError(err) {
  if (err?.code === 'desktop_offline') return true
  return /desktop offline|pipe closed|native host has exited|native disconnect|disconnected/i
    .test(String(err?.message || err || ''))
}

async function authenticateBridgeOnce() {
  const state = bridge.getState()
  if (state.connected && (state.ui === 'paired' || state.ui === 'attached')) {
    await bridge.status()
    const checked = bridge.getState()
    if (checked.ui === 'paired' || checked.ui === 'attached') return checked
  }
  if (!bridge.connect()) throw new Error(bridge.getState().lastError || 'native bridge offline')
  await bridge.hello()
  try {
    // pair() reuses the private durable credentials restored by bridge-client.
    // They must never be copied into the public state broadcast to UI pages.
    await bridge.pair()
  } catch {
    await bridge.pair(undefined, undefined, { fresh: true })
  }
  return bridge.getState()
}

async function ensureBridgeAuthenticated() {
  if (bridgeConnectPromise) return bridgeConnectPromise
  bridgeConnectPromise = (async () => {
    try {
      return await authenticateBridgeOnce()
    } catch (err) {
      if (!isRetryableTransportError(err)) throw err
      // The Native Messaging process can outlive the desktop pipe. Replace it
      // once so a Verstak restart heals without copying a new pair code.
      bridge.disconnect()
      await new Promise((resolve) => setTimeout(resolve, 150))
      return authenticateBridgeOnce()
    }
  })()
  try {
    return await bridgeConnectPromise
  } finally {
    bridgeConnectPromise = null
  }
}

function clearBridgeReconnect() {
  if (bridgeReconnectTimer) clearTimeout(bridgeReconnectTimer)
  bridgeReconnectTimer = null
  bridgeReconnectAttempt = 0
}

function scheduleBridgeReconnect(state) {
  if (state?.ui === 'paired' || state?.ui === 'attached') {
    clearBridgeReconnect()
    return
  }
  if (state?.connected) return
  // Reconnect only an already established durable pair. A fresh installation
  // still starts from the explicit toolbar action / Settings setup flow.
  if (!state?.hasPairing || bridgeReconnectTimer || bridgeReconnectAttempt >= BRIDGE_RECONNECT_DELAYS_MS.length) {
    return
  }
  const delay = BRIDGE_RECONNECT_DELAYS_MS[bridgeReconnectAttempt]
  bridgeReconnectTimer = setTimeout(() => {
    bridgeReconnectTimer = null
    const current = bridge.getState()
    if (current.ui === 'paired' || current.ui === 'attached') {
      clearBridgeReconnect()
      return
    }
    if (current.connected) return
    bridgeReconnectAttempt += 1
    ensureBridgeAuthenticated()
      .then(() => clearBridgeReconnect())
      .catch(() => scheduleBridgeReconnect(bridge.getState()))
  }, delay)
}

bridge.setAuthAvailableHandler((message) => {
  const expiresAt = Number(message?.expiresAt)
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt || authAvailableRetryPromise) return

  // If startup is still unwinding from pair_rejected, wait for its finally
  // before repeating hello+pair on this live Native Messaging connection.
  const currentAttempt = bridgeConnectPromise
  authAvailableRetryPromise = Promise.resolve(currentAttempt)
    .catch(() => {})
    .then(async () => {
      if (Date.now() >= expiresAt) return
      const state = bridge.getState()
      if (state.ui === 'paired' || state.ui === 'attached') return
      await ensureBridgeAuthenticated()
    })
    .catch((err) => console.warn('[verstak:bg] Settings auth:', err?.message || err))
    .finally(() => {
      authAvailableRetryPromise = null
    })
})

/** Last observe version per tabId — helps reject cross-tab click. */
const lastObsByTab = new Map()

async function ensureOriginPermission(url, opts = {}) {
  let originPattern
  try {
    const u = new URL(url)
    if (!/^https?:$/i.test(u.protocol)) return { ok: false, reason: 'unsupported scheme' }
    originPattern = `${u.protocol}//${u.host}/*`
  } catch {
    return { ok: false, reason: 'bad url' }
  }
  try {
    // During an action click request immediately: an awaited contains() may
    // consume Chrome's transient user activation before permissions.request().
    if (opts.userGesture === true) {
      const granted = await chrome.permissions.request({ origins: [originPattern] })
      return granted
        ? { ok: true, originPattern }
        : { ok: false, reason: 'permission denied', originPattern }
    }
    const have = await chrome.permissions.contains({ origins: [originPattern] })
    if (have) return { ok: true, originPattern }
    if (opts.request === false) {
      return { ok: false, reason: 'permission required', originPattern }
    }
    const granted = await chrome.permissions.request({ origins: [originPattern] })
    if (!granted) return { ok: false, reason: 'permission denied', originPattern }
    return { ok: true, originPattern }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err), originPattern }
  }
}

function tabIdFromRef(tabRef) {
  const m = /^tab-(\d+)$/.exec(String(tabRef || ''))
  return m ? Number(m[1]) : null
}

async function captureTabById(tabId) {
  const tab = await chrome.tabs.get(tabId)
  if (!tab || tab.id == null) throw new Error('Нет вкладки')
  if (!tab.url) {
    throw new Error('Нет доступа к вкладке — нажмите значок Verstak на нужной странице')
  }
  if (SCHEME_RE.test(tab.url)) {
    throw new Error('Служебные вкладки (chrome://, edge://, …) не читаются')
  }
  // executeScript сам применяет activeTab или сохранённый exact-origin grant.
  // Не запрашиваем permission из фонового запроса: Chrome разрешает запрос
  // новых прав только внутри непосредственного пользовательского жеста.
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: capturePageSnapshot,
    args: [{}],
  })
  const snapshot = results?.[0]?.result
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('extractor не вернул snapshot')
  }
  let origin = ''
  try { origin = new URL(tab.url).origin } catch { origin = '' }
  const tabRef = `tab-${tab.id}`
  if (snapshot.observationVersion != null) {
    lastObsByTab.set(tab.id, {
      version: snapshot.observationVersion,
      origin,
      tabRef,
    })
  }
  return {
    tab: {
      tabRef,
      url: tab.url,
      title: tab.title || '',
      origin,
    },
    snapshot,
    tabId: tab.id,
  }
}

async function captureActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const tab = Array.isArray(tabs) ? tabs[0] : null
  if (!tab || tab.id == null) throw new Error('Нет активной вкладки')
  return captureTabById(tab.id)
}

async function getActiveTabInfo(requestedTabId) {
  const explicitTabId = Number.isInteger(requestedTabId) && requestedTabId > 0
    ? requestedTabId
    : null
  const tab = explicitTabId != null
    ? await chrome.tabs.get(explicitTabId)
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  if (!tab || tab.id == null) throw new Error('Нет активной вкладки')
  if (!tab.url) {
    throw new Error('Нет доступа к данным вкладки — нажмите значок Verstak на нужной странице')
  }
  if (SCHEME_RE.test(tab.url)) {
    throw new Error('Служебные вкладки (chrome://, edge://, …) не подключаются')
  }
  let origin = ''
  try { origin = new URL(tab.url).origin } catch { /* validated by desktop */ }
  return {
    tabRef: `tab-${tab.id}`,
    url: tab.url,
    title: tab.title || '',
    origin,
  }
}

if (chrome?.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    // Call open() directly inside the action gesture. This guarantees that the
    // same callback tab is both shown and attached; no service-worker window
    // heuristic participates in the primary path.
    if (tab?.id != null && chrome?.sidePanel?.open) {
      chrome.sidePanel.open({ tabId: tab.id })
        .catch((err) => console.warn('[verstak:bg] sidePanel.open:', err?.message || err))
    }
    void (async () => {
      try {
        const safeTab = (() => {
          if (!tab || tab.id == null) throw new Error('Нет активной вкладки')
          if (!tab.url) throw new Error('Нет доступа к данным вкладки')
          if (SCHEME_RE.test(tab.url)) {
            throw new Error('Служебные вкладки (chrome://, edge://, …) не подключаются')
          }
          let origin = ''
          try { origin = new URL(tab.url).origin } catch { /* validated by desktop */ }
          return {
            tabRef: `tab-${tab.id}`,
            url: tab.url,
            title: tab.title || '',
            origin,
          }
        })()

        // Exact-origin access is requested from the toolbar click, where Chrome
        // has a real user gesture. The action itself also grants activeTab.
        await ensureOriginPermission(safeTab.url, { userGesture: true })
        await ensureBridgeAuthenticated()
        await bridge.attach(safeTab)
      } catch (err) {
        console.warn('[verstak:bg] action.onClicked attach:', err?.message || err)
      }
    })()
  })
}

bridge.onState((state) => {
  try {
    chrome.runtime.sendMessage({ type: 'bridge.stateChanged', state }).catch(() => {})
  } catch { /* side panel may be closed */ }
  scheduleBridgeReconnect(state)
})

function snapshotPayload(snapshot, tab) {
  return {
    text: snapshot.text || '',
    tables: snapshot.tables || [],
    source: {
      url: snapshot.source?.url || tab.url,
      title: snapshot.source?.title || tab.title,
      origin: tab.origin,
    },
    omissions: snapshot.omissions || [],
    truncated: snapshot.truncated || {},
    selection: snapshot.selection,
    controls: snapshot.controls || [],
    observationVersion: snapshot.observationVersion,
  }
}

bridge.setObserveRequestHandler(async (msg) => {
  try {
    const wantTabId = tabIdFromRef(msg.tabRef)
    // A request for an attached tab must never inspect another active tab.
    // Fallback is valid only when the desktop did not specify a tab at all.
    const captured = wantTabId != null
      ? await captureTabById(wantTabId)
      : await captureActiveTab()
    const { tab, snapshot } = captured
    // Wrong tab vs request: still report with requested tabRef only if match.
    const tabRef = msg.tabRef || tab.tabRef
    if (msg.tabRef && tab.tabRef !== msg.tabRef) {
      // Attached tab not current — try again with explicit id only above; if mismatch, error.
      await bridge.sendObserve({
        requestId: msg.requestId,
        browserTaskId: msg.browserTaskId,
        runId: msg.runId,
        tabRef: msg.tabRef,
        snapshot: {
          text: '',
          tables: [],
          source: { url: 'about:blank', title: 'wrong tab', origin: '' },
          omissions: [`wrong tab: attached ${msg.tabRef}, got ${tab.tabRef}`],
          truncated: { text: true },
          controls: [],
        },
      })
      return
    }
    if (snapshot.observationVersion != null && captured.tabId != null) {
      lastObsByTab.set(captured.tabId, {
        version: snapshot.observationVersion,
        origin: tab.origin,
        tabRef,
      })
    }
    await bridge.sendObserve({
      requestId: msg.requestId,
      browserTaskId: msg.browserTaskId,
      runId: msg.runId,
      tabRef,
      snapshot: snapshotPayload(snapshot, tab),
    })
  } catch (err) {
    console.warn('[verstak:bg] observe_request failed:', err?.message || err)
    try {
      await bridge.sendObserve({
        requestId: msg.requestId,
        browserTaskId: msg.browserTaskId,
        runId: msg.runId,
        tabRef: msg.tabRef,
        ok: false,
        error: String(err?.message || err),
      })
    } catch { /* ignore */ }
  }
})

bridge.setClickRequestHandler(async (msg) => {
  const base = {
    requestId: msg.requestId,
    browserTaskId: msg.browserTaskId,
    runId: msg.runId,
    tabRef: msg.tabRef,
    elementRef: msg.elementRef,
    observationVersion: msg.observationVersion,
  }
  try {
    const st = bridge.getState()
    // Must be attached to the requested tab.
    if (!st.attachedTab || st.attachedTab.tabRef !== msg.tabRef) {
      await bridge.sendClickResult({
        ...base,
        ok: false,
        error: 'wrong tab — not attached or tabRef mismatch',
      })
      return
    }
    if (msg.origin) {
      const a = String(msg.origin).replace(/^https?:\/\//, '').replace(/\/$/, '')
      const b = String(st.attachedTab.origin || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
      try {
        const ah = a.includes('://') ? new URL(msg.origin).host : a
        const bh = b.includes('://') ? new URL(st.attachedTab.origin).host : b
        if (ah && bh && ah !== bh) {
          await bridge.sendClickResult({
            ...base,
            ok: false,
            error: `wrong origin — expected ${bh}, got ${ah}`,
          })
          return
        }
      } catch { /* ignore origin parse */ }
    }

    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendClickResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const tab = await chrome.tabs.get(tabId)
    if (!tab?.url || SCHEME_RE.test(tab.url)) {
      await bridge.sendClickResult({ ...base, ok: false, error: 'unsupported tab scheme' })
      return
    }
    const lastObs = lastObsByTab.get(tabId)
    if (lastObs && lastObs.version !== msg.observationVersion) {
      await bridge.sendClickResult({
        ...base,
        ok: false,
        error: `stale observation version — expected ${lastObs.version}, got ${msg.observationVersion}`,
      })
      return
    }

    // Ensure refs stamped: if page never observed this session in SW memory,
    // still try click by data attributes (observe always stamps them).
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: performClickByRef,
      args: [msg.elementRef, msg.observationVersion],
    })
    const r = results?.[0]?.result
    if (!r || typeof r !== 'object') {
      await bridge.sendClickResult({ ...base, ok: false, error: 'click script returned empty' })
      return
    }
    if (!r.ok) {
      await bridge.sendClickResult({ ...base, ok: false, error: r.error || 'click failed' })
      return
    }
    // One-shot success — clear local obs so replay needs fresh observe.
    lastObsByTab.delete(tabId)
    await bridge.sendClickResult({
      ...base,
      ok: true,
      finalUrl: r.finalUrl || tab.url || '',
    })
  } catch (err) {
    console.warn('[verstak:bg] click_request failed:', err?.message || err)
    try {
      await bridge.sendClickResult({
        ...base,
        ok: false,
        error: String(err?.message || err),
      })
    } catch { /* ignore */ }
  }
})

bridge.setNavigateRequestHandler(async (msg) => {
  const base = { requestId: msg.requestId, browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef }
  try {
    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendNavigateResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const currentTab = await chrome.tabs.get(tabId)
    if (!currentTab?.url || SCHEME_RE.test(currentTab.url)) {
      await bridge.sendNavigateResult({ ...base, ok: false, error: 'unsupported current tab scheme' })
      return
    }
    let currentOrigin = ''
    let targetOrigin = ''
    try {
      currentOrigin = new URL(currentTab.url).origin
      targetOrigin = new URL(msg.url, currentTab.url).origin
    } catch {
      await bridge.sendNavigateResult({ ...base, ok: false, error: 'bad navigation url' })
      return
    }
    if (targetOrigin !== currentOrigin) {
      // Chrome allows permissions.request only inside a direct user gesture.
      // Agent-driven navigation therefore uses an already granted target origin
      // or stops before leaving the tab; it never opens a permission prompt in
      // the background and never pretends the navigation succeeded.
      const perm = await ensureOriginPermission(msg.url, { request: false })
      if (!perm.ok) {
        await bridge.sendNavigateResult({
          ...base,
          ok: false,
          error: 'Переход на новый сайт требует доступа: откройте его и нажмите значок Verstak на этой странице',
        })
        return
      }
    }
    await chrome.tabs.update(tabId, { url: msg.url })
    lastObsByTab.delete(tabId)
    await new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(null) }
      }, 10000)
      const listener = (id, changeInfo, tab) => {
        if (id === tabId && changeInfo.status === 'complete') {
          if (!done) { done = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(tab) }
        }
      }
      chrome.tabs.onUpdated.addListener(listener)
    })
    const updated = await chrome.tabs.get(tabId)
    await bridge.sendNavigateResult({
      ...base,
      ok: true,
      finalUrl: updated?.url || msg.url,
      title: updated?.title || '',
    })
  } catch (err) {
    await bridge.sendNavigateResult({ ...base, ok: false, error: String(err?.message || err) })
  }
})

bridge.setScrollRequestHandler(async (msg) => {
  const base = { requestId: msg.requestId, browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef }
  try {
    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendScrollResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: performScrollByRef,
      args: [msg.elementRef, msg.delta],
    })
    const r = results?.[0]?.result
    await bridge.sendScrollResult({ ...base, ok: r?.ok === true, error: r?.error })
  } catch (err) {
    await bridge.sendScrollResult({ ...base, ok: false, error: String(err?.message || err) })
  }
})

bridge.setFocusRequestHandler(async (msg) => {
  const base = { requestId: msg.requestId, browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef }
  try {
    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendFocusResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: performFocusByRef,
      args: [msg.elementRef, msg.observationVersion],
    })
    const r = results?.[0]?.result
    await bridge.sendFocusResult({ ...base, ok: r?.ok === true, error: r?.error })
  } catch (err) {
    await bridge.sendFocusResult({ ...base, ok: false, error: String(err?.message || err) })
  }
})

bridge.setSelectOptionRequestHandler(async (msg) => {
  const base = { requestId: msg.requestId, browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef }
  try {
    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendSelectOptionResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: performSelectByRef,
      args: [msg.elementRef, msg.observationVersion, msg.value],
    })
    const r = results?.[0]?.result
    await bridge.sendSelectOptionResult({ ...base, ok: r?.ok === true, error: r?.error })
  } catch (err) {
    await bridge.sendSelectOptionResult({ ...base, ok: false, error: String(err?.message || err) })
  }
})

bridge.setWaitForRequestHandler(async (msg) => {
  const base = { requestId: msg.requestId, browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef }
  try {
    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendWaitForResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const timeoutMs = Math.min(Math.max(Number(msg.condition?.timeoutMs || 10000), 100), 30000)
    const startTime = Date.now()
    let matched = false
    let lastReason = 'timeout'

    while (Date.now() - startTime < timeoutMs) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: performWaitFor,
        args: [msg.condition],
      })
      const r = results?.[0]?.result
      if (r?.ok) {
        matched = true
        break
      }
      if (r?.reason) lastReason = r.reason
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    if (matched) {
      await bridge.sendWaitForResult({ ...base, ok: true })
    } else {
      await bridge.sendWaitForResult({ ...base, ok: false, reason: lastReason })
    }
  } catch (err) {
    await bridge.sendWaitForResult({ ...base, ok: false, error: String(err?.message || err) })
  }
})

bridge.setTypeTextRequestHandler(async (msg) => {
  const base = { requestId: msg.requestId, browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef, elementRef: msg.elementRef }
  try {
    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendTypeTextResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: performTypeText,
      args: [msg.elementRef, msg.observationVersion, msg.text, msg.clearFirst, msg.submitEnter],
    })
    const r = results?.[0]?.result
    lastObsByTab.delete(tabId)
    await bridge.sendTypeTextResult({ ...base, ok: r?.ok === true, error: r?.error })
  } catch (err) {
    await bridge.sendTypeTextResult({ ...base, ok: false, error: String(err?.message || err) })
  }
})

bridge.setClearFieldRequestHandler(async (msg) => {
  const base = { requestId: msg.requestId, browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef, elementRef: msg.elementRef }
  try {
    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendClearFieldResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: performClearField,
      args: [msg.elementRef, msg.observationVersion],
    })
    const r = results?.[0]?.result
    lastObsByTab.delete(tabId)
    await bridge.sendClearFieldResult({ ...base, ok: r?.ok === true, error: r?.error })
  } catch (err) {
    await bridge.sendClearFieldResult({ ...base, ok: false, error: String(err?.message || err) })
  }
})

bridge.setToggleRequestHandler(async (msg) => {
  const base = { requestId: msg.requestId, browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef, elementRef: msg.elementRef }
  try {
    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendToggleResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: performToggle,
      args: [msg.elementRef, msg.observationVersion],
    })
    const r = results?.[0]?.result
    lastObsByTab.delete(tabId)
    await bridge.sendToggleResult({ ...base, ok: r?.ok === true, error: r?.error })
  } catch (err) {
    await bridge.sendToggleResult({ ...base, ok: false, error: String(err?.message || err) })
  }
})

bridge.setPressKeyRequestHandler(async (msg) => {
  const base = { requestId: msg.requestId, browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef, elementRef: msg.elementRef }
  try {
    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendPressKeyResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: performPressKey,
      args: [msg.elementRef, msg.observationVersion, msg.key],
    })
    const r = results?.[0]?.result
    await bridge.sendPressKeyResult({ ...base, ok: r?.ok === true, error: r?.error })
  } catch (err) {
    await bridge.sendPressKeyResult({ ...base, ok: false, error: String(err?.message || err) })
  }
})

// Real Verstak run events -> product side panel. This is the only response path;
// the side panel must not interpret prompts or fabricate action results locally.
bridge.setTaskEventHandler((msg) => {
  chrome.runtime.sendMessage({ type: 'bridge.taskEvent', payload: msg }).catch(() => {})
})

// Restore durable credentials and connect. First install receives a local session
// automatically after the allowlisted Native Messaging hello.
bridge.restoreFromStorage().then(() => {
  try {
    ensureBridgeAuthenticated()
      .catch((err) => console.warn('[verstak:bg] auto-pair:', err?.message || err))
  } catch (err) {
    console.warn('[verstak:bg] connect:', err?.message || err)
  }
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    if (!message || typeof message !== 'object') {
      return { ok: false, error: 'bad message' }
    }
    switch (message.type) {
      case 'bridge.getState':
        return { ok: true, state: bridge.getState() }
      case 'bridge.connect': {
        try {
          if (message.pairingToken) {
            if (!bridge.connect()) return { ok: false, error: bridge.getState().lastError || 'offline' }
            await bridge.hello()
            await bridge.pair(message.pairingToken, message.sessionId)
          } else {
            await ensureBridgeAuthenticated()
          }
          return { ok: true, state: bridge.getState() }
        } catch (err) {
          return { ok: false, error: err?.message || String(err), state: bridge.getState() }
        }
      }
      case 'bridge.status': {
        try {
          const res = await bridge.status()
          return { ok: true, status: res, state: bridge.getState() }
        } catch (err) {
          return { ok: false, error: err?.message || String(err), state: bridge.getState() }
        }
      }
      case 'bridge.attach': {
        try {
          // Attach records only safe tab metadata. DOM capture and optional origin
          // permission happen later, when an actual observe is requested.
          const tab = await getActiveTabInfo(message.tabId)
          const res = await bridge.attach(tab)
          return { ok: true, attach: res, tab, state: bridge.getState() }
        } catch (err) {
          return { ok: false, error: err?.message || String(err), state: bridge.getState() }
        }
      }
      case 'bridge.detach': {
        try {
          const res = await bridge.detach(message.tabRef)
          return { ok: true, detach: res, state: bridge.getState() }
        } catch (err) {
          return { ok: false, error: err?.message || String(err), state: bridge.getState() }
        }
      }
      case 'bridge.observeNow': {
        // Manual observe into current run (no clipboard).
        try {
          const { tab, snapshot } = await captureActiveTab()
          const st = bridge.getState()
          const bt = message.browserTaskId || st.browserTaskId
          const rid = message.runId || st.runId
          if (!bt || !rid) {
            return { ok: false, error: 'нет browserTaskId/runId — откройте чат в Verstak и pair', state: st }
          }
          // Ensure attached
          if (!st.attachedTab) {
            await bridge.attach(tab)
          }
          const res = await bridge.sendObserve({
            browserTaskId: bt,
            runId: rid,
            tabRef: tab.tabRef,
            snapshot: snapshotPayload(snapshot, tab),
          })
          return { ok: true, observe: res, tab, state: bridge.getState() }
        } catch (err) {
          return { ok: false, error: err?.message || String(err), state: bridge.getState() }
        }
      }
      case 'bridge.submitTask': {
        try {
          const prompt = typeof message.prompt === 'string' ? message.prompt.trim() : ''
          if (!prompt) return { ok: false, error: 'Пустая задача' }
          const st = bridge.getState()
          if (!st.attachedTab) {
            return {
              ok: false,
              error: 'Текущая вкладка не прикреплена — нажмите значок Verstak на нужной странице',
              state: st,
            }
          }
          const res = await bridge.submitTask(prompt)
          return { ok: true, task: res, state: bridge.getState() }
        } catch (err) {
          return { ok: false, error: err?.message || String(err), state: bridge.getState() }
        }
      }
      case 'bridge.resolveTaskApproval': {
        try {
          const res = await bridge.resolveTaskApproval(message.payload || {})
          return { ok: true, approval: res }
        } catch (err) {
          return { ok: false, error: err?.message || String(err) }
        }
      }
      case 'bridge.cancelTask': {
        try {
          const res = await bridge.cancelTask(message.sendId)
          return { ok: true, cancel: res }
        } catch (err) {
          return { ok: false, error: err?.message || String(err) }
        }
      }
      default:
        return { ok: false, error: `unknown ${message.type}` }
    }
  }
  handle().then(sendResponse)
  return true // async
})
