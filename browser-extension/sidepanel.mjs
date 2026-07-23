// sidepanel.mjs — Product AI Employee UI for Verstak (EXT-PRODUCT-RESET).

import { capturePageSnapshot } from './extractor.mjs'
import { formatSnapshotForVerstak } from './format-prompt.mjs'

const els = {
  // Product UX Elements
  statusPill: document.getElementById('vsk-status-pill'),
  pageTitle: document.getElementById('vsk-page-title'),
  pageDomain: document.getElementById('vsk-page-domain'),
  chatFeed: document.getElementById('vsk-chat-feed'),
  approvalArea: document.getElementById('vsk-approval-area'),
  approvalDesc: document.getElementById('vsk-approval-desc'),
  approvalChange: document.getElementById('vsk-approval-change'),
  approveBtn: document.getElementById('vsk-approve-btn'),
  rejectBtn: document.getElementById('vsk-reject-btn'),
  form: document.getElementById('vsk-form'),
  promptInput: document.getElementById('vsk-prompt-input'),
  sendBtn: document.getElementById('vsk-send-btn'),
  stopBtn: document.getElementById('vsk-stop-btn'),

  // Technical / Debug Elements (Backward Compatibility)
  pair: document.getElementById('vsk-pair'),
  pairCode: document.getElementById('vsk-pair-code'),
  attach: document.getElementById('vsk-attach'),
  detach: document.getElementById('vsk-detach'),
  observe: document.getElementById('vsk-observe'),
  capture: document.getElementById('vsk-capture'),
  copyVerstak: document.getElementById('vsk-copy-verstak'),
  copyJson: document.getElementById('vsk-copy-json'),
  status: document.getElementById('vsk-status'),
  meta: document.getElementById('vsk-meta'),
  metaSource: document.getElementById('vsk-meta-source'),
  metaTextLen: document.getElementById('vsk-meta-textlen'),
  metaTables: document.getElementById('vsk-meta-tables'),
  metaTruncWrap: document.getElementById('vsk-meta-trunc-wrap'),
  metaTrunc: document.getElementById('vsk-meta-trunc'),
  metaOmissionsWrap: document.getElementById('vsk-meta-omissions-wrap'),
  metaOmissions: document.getElementById('vsk-meta-omissions'),
  output: document.getElementById('vsk-output'),
  connState: document.getElementById('vsk-conn-state'),
  connTask: document.getElementById('vsk-conn-task'),
  connRun: document.getElementById('vsk-conn-run'),
  connTab: document.getElementById('vsk-conn-tab'),
}

let lastSnapshot = null
let lastFormatted = ''
let activeTabInfo = null
let pendingApproval = null
let activeSendId = null
let streamText = ''
let streamNode = null

let bridgeState = {
  ui: 'offline',
  sessionId: null,
  browserTaskId: null,
  runId: null,
  attachedTab: null,
  lastError: null,
  connected: false,
}

function setStatus(kind, text) {
  if (!els.status) return
  els.status.classList.remove('is-error', 'is-warn', 'is-success')
  if (kind === 'error') els.status.classList.add('is-error')
  else if (kind === 'warn') els.status.classList.add('is-warn')
  else if (kind === 'success') els.status.classList.add('is-success')
  els.status.textContent = text
}

function updateStatusPill(state, text) {
  if (!els.statusPill) return
  els.statusPill.className = 'vsk-pill is-' + state
  els.statusPill.textContent = text
}

function addMessage(role, lines) {
  if (!els.chatFeed) return
  const wrap = document.createElement('div')
  wrap.className = 'vsk-msg is-' + role
  const avatar = document.createElement('div')
  avatar.className = 'vsk-avatar'
  avatar.textContent = role === 'user' ? '👤' : '🤖'
  const bubble = document.createElement('div')
  bubble.className = 'vsk-bubble'

  const items = Array.isArray(lines) ? lines : [lines]
  for (const item of items) {
    const p = document.createElement('p')
    if (typeof item === 'object' && item !== null) {
      if (item.subtext) p.className = 'vsk-subtext'
      p.textContent = item.text
    } else {
      p.textContent = String(item)
    }
    bubble.appendChild(p)
  }

  wrap.appendChild(avatar)
  wrap.appendChild(bubble)
  els.chatFeed.appendChild(wrap)
  els.chatFeed.scrollTop = els.chatFeed.scrollHeight
}

function addStepCard(text) {
  if (!els.chatFeed) return
  const card = document.createElement('div')
  card.className = 'vsk-step-card'
  const spin = document.createElement('span')
  spin.className = 'vsk-spin'
  spin.textContent = '⏳'
  const label = document.createElement('span')
  label.textContent = ' ' + text
  card.appendChild(spin)
  card.appendChild(label)
  els.chatFeed.appendChild(card)
  els.chatFeed.scrollTop = els.chatFeed.scrollHeight
  return card
}

function appendAssistantText(text) {
  if (!streamNode) {
    const wrap = document.createElement('div')
    wrap.className = 'vsk-msg is-assistant'
    const avatar = document.createElement('div')
    avatar.className = 'vsk-avatar'
    avatar.textContent = 'В'
    const bubble = document.createElement('div')
    bubble.className = 'vsk-bubble'
    streamNode = document.createElement('p')
    bubble.appendChild(streamNode)
    wrap.appendChild(avatar)
    wrap.appendChild(bubble)
    els.chatFeed?.appendChild(wrap)
  }
  streamText += text
  streamNode.textContent = streamText
  if (els.chatFeed) els.chatFeed.scrollTop = els.chatFeed.scrollHeight
}

function renderResult(snapshot) {
  lastSnapshot = snapshot
  lastFormatted = formatSnapshotForVerstak(snapshot)
  if (els.output) els.output.value = lastFormatted

  const src = (snapshot && snapshot.source) || {}
  if (els.metaSource) {
    els.metaSource.textContent = (src.url || '(без URL)') + (src.title ? ' · ' + src.title : '')
  }
  if (els.metaTextLen) els.metaTextLen.textContent = String((snapshot.text || '').length)
  if (els.metaTables) {
    els.metaTables.textContent = String(Array.isArray(snapshot.tables) ? snapshot.tables.length : 0)
  }

  const trunc = snapshot.truncated || {}
  const truncParts = []
  if (trunc.text) truncParts.push('текст')
  if (trunc.selection) truncParts.push('выделение')
  if (trunc.tables) truncParts.push('таблицы')
  if (truncParts.length && els.metaTrunc && els.metaTruncWrap) {
    els.metaTrunc.textContent = truncParts.join(', ')
    els.metaTruncWrap.classList.remove('vsk-hidden')
  } else if (els.metaTruncWrap) {
    els.metaTruncWrap.classList.add('vsk-hidden')
  }

  const omissions = Array.isArray(snapshot.omissions) ? snapshot.omissions.filter(Boolean) : []
  if (omissions.length && els.metaOmissions && els.metaOmissionsWrap) {
    els.metaOmissions.textContent = String(omissions.length) + ' шт.'
    els.metaOmissionsWrap.classList.remove('vsk-hidden')
  } else if (els.metaOmissionsWrap) {
    els.metaOmissionsWrap.classList.add('vsk-hidden')
  }

  if (els.meta) els.meta.classList.remove('vsk-hidden')
  if (els.copyVerstak) els.copyVerstak.disabled = false
  if (els.copyJson) els.copyJson.disabled = false
}

function paintConn(state) {
  bridgeState = state || bridgeState
  const ui = bridgeState.ui || 'offline'
  if (els.connState) {
    els.connState.textContent = ui
    els.connState.className = 'vsk-conn-badge is-' + ui
  }
  if (els.connTask) els.connTask.textContent = bridgeState.browserTaskId || '—'
  if (els.connRun) els.connRun.textContent = bridgeState.runId || '—'
  if (els.connTab) {
    const t = bridgeState.attachedTab
    els.connTab.textContent = t
      ? ((t.title || t.url || t.tabRef || '').slice(0, 80))
      : 'не прикреплена'
  }

  if (ui === 'attached') {
    updateStatusPill('attached', '● Подключено')
  } else if (ui === 'paired') {
    updateStatusPill('connected', '● Вкладка готова')
  } else {
    updateStatusPill('offline', '○ Авто-подключение')
  }
}

async function queryBridgeState() {
  try {
    if (!chrome?.runtime?.sendMessage) return
    const res = await chrome.runtime.sendMessage({ type: 'bridge.getState' })
    if (res && res.ok && res.state) {
      paintConn(res.state)
    }
  } catch (err) {
    console.warn('[vsk:sidepanel] queryBridgeState:', err)
  }
}

async function autoConnectAndAttach() {
  if (!chrome?.tabs?.query) return
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (tab) {
      activeTabInfo = tab
      if (els.pageTitle) els.pageTitle.textContent = tab.title || 'Текущая страница'
      try {
        const u = new URL(tab.url || '')
        if (els.pageDomain) els.pageDomain.textContent = u.host || u.protocol
      } catch {
        if (els.pageDomain) els.pageDomain.textContent = tab.url || ''
      }
    }

    // Auto connect bridge
    const connRes = await chrome.runtime.sendMessage({ type: 'bridge.connect' })
    if (connRes && connRes.state) {
      paintConn(connRes.state)
    }

    // Auto attach active tab
    const attachRes = await chrome.runtime.sendMessage({ type: 'bridge.attach' })
    if (attachRes && attachRes.state) {
      paintConn(attachRes.state)
      setStatus('success', 'Автоматически подключено к текущей странице')
    }
  } catch (err) {
    setStatus('warn', 'Подключение к странице: ' + (err?.message || err))
  }
}

// ── User Prompt Execution (Product Loop) ─────────────────────────────────────

async function processUserPrompt(promptText) {
  const p = promptText.trim()
  if (!p) return

  addMessage('user', [p])
  if (els.promptInput) els.promptInput.value = ''

  streamText = ''
  streamNode = null
  const stepCard = addStepCard('Передаю задачу в Verstak...')
  const res = await chrome.runtime.sendMessage({ type: 'bridge.submitTask', prompt: p })
  if (stepCard?.parentNode) stepCard.parentNode.removeChild(stepCard)
  if (!res?.ok) {
    addMessage('assistant', ['Не удалось запустить задачу: ' + (res?.error || 'неизвестная ошибка')])
    return
  }
  activeSendId = res.task?.sendId ?? activeSendId
}

function showApprovalCard(payload) {
  if (els.approvalDesc) els.approvalDesc.textContent = payload.snapshot?.label || payload.reason || 'Действие в браузере'
  if (els.approvalChange) els.approvalChange.textContent = `Риск ${payload.risk || 'R3'} · действие будет выполнено один раз`
  if (els.approvalArea) els.approvalArea.classList.remove('vsk-hidden')
  pendingApproval = payload
}

function hideApprovalCard() {
  if (els.approvalArea) els.approvalArea.classList.add('vsk-hidden')
}

// ── ActiveTab Error Flow (Scenario 16) ───────────────────────────────────────

async function onCapture() {
  setStatus('warn', 'Чтение...')
  if (!chrome || !chrome.tabs || typeof chrome.tabs.query !== 'function') {
    setStatus('error', 'Ошибка среды: chrome.tabs недоступен.')
    return
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tabs || tabs.length === 0) {
      setStatus('error', 'Ошибка: нет активной вкладки в текущем окне.')
      return
    }

    const tab = tabs[0]
    if (tab.id === undefined || tab.id === null) {
      setStatus('error', 'Ошибка: у активной вкладки отсутствует идентификатор.')
      return
    }

    if (tab.url) {
      const u = String(tab.url).trim().toLowerCase()
      if (
        u.startsWith('chrome://') ||
        u.startsWith('chrome-extension://') ||
        u.startsWith('edge://') ||
        u.startsWith('about:')
      ) {
        setStatus('error', 'Системная страница Chrome недоступна для чтения расширением.')
        return
      }
    }

    if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
      setStatus('error', 'Ошибка среды: chrome.scripting.executeScript недоступен.')
      return
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: capturePageSnapshot,
      args: [{ maxTextLength: 40000, maxTables: 10, maxTableRows: 50 }],
    })

    if (!results || !Array.isArray(results) || results.length === 0) {
      setStatus('error', 'Не удалось извлечь содержимое страницы.')
      return
    }

    const first = results[0]
    const snapshot = first ? first.result : null
    if (!snapshot) {
      setStatus('error', 'Страница не вернула данных.')
      return
    }

    renderResult(snapshot)
    setStatus('success', 'Снимок успешно сохранён в превью.')
  } catch (err) {
    const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err)
    if (msg.includes('Cannot access contents') || msg.includes('manifest must request permission')) {
      setStatus('error', 'Нет доступа к вкладке: нажмите иконку расширения для выдачи разрешения activeTab.')
    } else {
      setStatus('error', 'Ошибка выполнения: ' + msg)
    }
  }
}

// ── Event Handlers & Initialization ──────────────────────────────────────────

if (els.form) {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (els.promptInput) {
      processUserPrompt(els.promptInput.value)
    }
  })
}

if (els.promptInput) {
  els.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      processUserPrompt(els.promptInput.value)
    }
  })
}

if (els.approveBtn) {
  els.approveBtn.addEventListener('click', async () => {
    if (!pendingApproval) return
    const payload = pendingApproval
    pendingApproval = null
    hideApprovalCard()
    await chrome.runtime.sendMessage({
      type: 'bridge.resolveTaskApproval',
      payload: { ...payload, approved: true, sendId: payload.sendId || activeSendId },
    })
  })
}

if (els.rejectBtn) {
  els.rejectBtn.addEventListener('click', async () => {
    if (!pendingApproval) return
    const payload = pendingApproval
    pendingApproval = null
    hideApprovalCard()
    await chrome.runtime.sendMessage({
      type: 'bridge.resolveTaskApproval',
      payload: { ...payload, approved: false, sendId: payload.sendId || activeSendId },
    })
  })
}

if (els.stopBtn) {
  els.stopBtn.addEventListener('click', async () => {
    if (!activeSendId) return
    await chrome.runtime.sendMessage({ type: 'bridge.cancelTask', sendId: activeSendId })
  })
}

chrome.runtime.onMessage?.addListener((message) => {
  if (message?.type !== 'bridge.taskEvent') return
  const packet = message.payload || {}
  const event = packet.event || {}
  activeSendId = packet.sendId || activeSendId
  if (event.type === 'text' && typeof event.text === 'string') {
    appendAssistantText(event.text)
  } else if (event.type === 'agent-progress') {
    updateStatusPill('working', event.title || 'Работаю')
  } else if (event.type === 'pending-browser-action') {
    showApprovalCard({ ...event, sendId: packet.sendId })
  } else if (event.type === 'error') {
    addMessage('assistant', [event.message || 'Ошибка выполнения'])
    updateStatusPill('error', 'Ошибка')
    activeSendId = null
  } else if (event.type === 'done') {
    updateStatusPill('ready', 'Готово')
    activeSendId = null
  }
})

if (els.capture) {
  els.capture.addEventListener('click', () => {
    onCapture()
  })
}

if (els.pair) {
  els.pair.addEventListener('click', async () => {
    const code = (els.pairCode && els.pairCode.value ? els.pairCode.value.trim() : '')
    const res = await chrome.runtime.sendMessage({ type: 'bridge.connect', pairingToken: code })
    if (res && res.state) paintConn(res.state)
  })
}

if (els.attach) {
  els.attach.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'bridge.attach' })
    if (res && res.state) paintConn(res.state)
  })
}

if (els.detach) {
  els.detach.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'bridge.detach' })
    if (res && res.state) paintConn(res.state)
  })
}

if (els.observe) {
  els.observe.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'bridge.observeNow' })
    if (res && res.observe && res.observe.snapshot) {
      renderResult(res.observe.snapshot)
      setStatus('success', 'Observe отправлен в run!')
    }
  })
}

// Auto init on load
queryBridgeState()
autoConnectAndAttach()
