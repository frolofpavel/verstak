// Service worker — Connected Eyes + First Hand click (EXT-B1 / EXT-C1).
//
// • side panel open-on-action
// • Native Messaging bridge (pair / attach / observe_request / click_request)
// • optional host permission только для origin прикреплённой вкладки
// • click: только opaque elementRef + observationVersion (no raw CSS/JS/CDP)
// • никаких type_text, cookies, clipboard-as-bridge

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

try {
  if (chrome?.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[verstak:bg] setPanelBehavior:', chrome.runtime.lastError.message)
      }
    })
  }
} catch (err) {
  console.warn('[verstak:bg] sidePanel init failed:', err?.message ?? err)
}

if (chrome?.action?.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    try {
      if (tab?.windowId && chrome?.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: tab.windowId })
      }
    } catch (err) {
      console.warn('[verstak:bg] action.onClicked open panel:', err)
    }
  })
}

const bridge = createBridgeClient()

/** Last observe version per tabId — helps reject cross-tab click. */
const lastObsByTab = new Map()

async function ensureOriginPermission(url) {
  let originPattern
  try {
    const u = new URL(url)
    if (!/^https?:$/i.test(u.protocol)) return { ok: false, reason: 'unsupported scheme' }
    originPattern = `${u.protocol}//${u.host}/*`
  } catch {
    return { ok: false, reason: 'bad url' }
  }
  try {
    const have = await chrome.permissions.contains({ origins: [originPattern] })
    if (have) return { ok: true, originPattern }
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
  if (!tab.url || SCHEME_RE.test(tab.url)) {
    throw new Error('Служебные вкладки (chrome://, edge://, …) не читаются')
  }
  const perm = await ensureOriginPermission(tab.url)
  if (!perm.ok) {
    throw new Error(`Нет host permission для домена: ${perm.reason}`)
  }
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
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = Array.isArray(tabs) ? tabs[0] : null
  if (!tab || tab.id == null) throw new Error('Нет активной вкладки')
  return captureTabById(tab.id)
}

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
    let captured
    if (wantTabId != null) {
      try {
        captured = await captureTabById(wantTabId)
      } catch {
        // Fallback active if attached tab gone.
        captured = await captureActiveTab()
      }
    } else {
      captured = await captureActiveTab()
    }
    const { tab, snapshot } = captured
    // Wrong tab vs request: still report with requested tabRef only if match.
    const tabRef = msg.tabRef || tab.tabRef
    if (msg.tabRef && tab.tabRef !== msg.tabRef) {
      // Attached tab not current — try again with explicit id only above; if mismatch, error.
      await bridge.sendObserve({
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
      browserTaskId: msg.browserTaskId,
      runId: msg.runId,
      tabRef,
      snapshot: snapshotPayload(snapshot, tab),
    })
  } catch (err) {
    console.warn('[verstak:bg] observe_request failed:', err?.message || err)
    try {
      await bridge.sendObserve({
        browserTaskId: msg.browserTaskId,
        runId: msg.runId,
        tabRef: msg.tabRef,
        snapshot: {
          text: '',
          tables: [],
          source: { url: 'about:blank', title: 'observe failed', origin: '' },
          omissions: [String(err?.message || err)],
          truncated: { text: true },
          controls: [],
        },
      })
    } catch { /* ignore */ }
  }
})

bridge.setClickRequestHandler(async (msg) => {
  const base = {
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
    const perm = await ensureOriginPermission(tab.url)
    if (!perm.ok) {
      await bridge.sendClickResult({ ...base, ok: false, error: `no host permission: ${perm.reason}` })
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
  const base = { browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef }
  try {
    const tabId = tabIdFromRef(msg.tabRef)
    if (tabId == null) {
      await bridge.sendNavigateResult({ ...base, ok: false, error: 'bad tabRef' })
      return
    }
    const perm = await ensureOriginPermission(msg.url)
    if (!perm.ok) {
      await bridge.sendNavigateResult({ ...base, ok: false, error: `no host permission: ${perm.reason}` })
      return
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
  const base = { browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef }
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
  const base = { browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef }
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
  const base = { browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef }
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
  const base = { browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef }
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
  const base = { browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef, elementRef: msg.elementRef }
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
  const base = { browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef, elementRef: msg.elementRef }
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
  const base = { browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef, elementRef: msg.elementRef }
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
  const base = { browserTaskId: msg.browserTaskId, runId: msg.runId, tabRef: msg.tabRef, elementRef: msg.elementRef }
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

// Restore durable credentials only (not auto-continue actions / attach).
// Auto re-pair only when durable token or sessionId already stored.
// First pair requires explicit bootstrap code from side panel (fail-closed).
bridge.restoreFromStorage().then(() => {
  try {
    const st = bridge.getState()
    if (!st.pairingToken && !st.sessionId) return
    if (bridge.connect()) {
      bridge.hello()
        .then(() => bridge.pair(st.pairingToken, st.sessionId))
        .catch((err) => console.warn('[verstak:bg] auto-pair:', err?.message || err))
    }
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
        const ok = bridge.connect()
        if (!ok) return { ok: false, error: bridge.getState().lastError || 'offline' }
        try {
          await bridge.hello()
          await bridge.pair(message.pairingToken, message.sessionId)
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
          const { tab } = await captureActiveTab()
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
