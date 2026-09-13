// sidepanel.mjs — Product AI Employee UI for Verstak (EXT-PRODUCT-RESET).

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
  status: document.getElementById('vsk-status'),
}

let pendingApproval = null
let activeSendId = null
let streamText = ''
let streamNode = null
let promptSubmitting = false
let approvalSubmitting = false
let submitSequence = 0
let activeSubmitSequence = null
let activeStepCard = null
const retiredSendIds = new Set()
const SETTINGS_CONNECTION_HELP =
  'Откройте Verstak → Настройки → Интеграции → Браузер, нажмите «Подключить браузер», затем снова нажмите значок Verstak на этой странице'

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

function updatePromptAvailability() {
  const attached = bridgeState.ui === 'attached' && !!bridgeState.attachedTab
  const enabled = attached && !promptSubmitting && !activeSendId
  if (els.promptInput) {
    els.promptInput.disabled = !enabled
    els.promptInput.placeholder = attached
      ? 'Что сделать на этой странице?'
      : 'Сначала подключите вкладку'
  }
  if (els.sendBtn) els.sendBtn.disabled = !enabled
  if (els.stopBtn) {
    els.stopBtn.classList.toggle('vsk-hidden', !activeSendId)
    els.stopBtn.disabled = !activeSendId || promptSubmitting
  }
}

function normalizeSendId(value) {
  const sendId = Number(value)
  return Number.isSafeInteger(sendId) && sendId > 0 ? sendId : null
}

function rememberRetiredSendId(sendId) {
  if (!sendId) return
  retiredSendIds.add(sendId)
  if (retiredSendIds.size > 32) {
    retiredSendIds.delete(retiredSendIds.values().next().value)
  }
}

function removeActiveStepCard() {
  if (activeStepCard?.parentNode) {
    activeStepCard.parentNode.removeChild(activeStepCard)
  }
  activeStepCard = null
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

function paintConn(state) {
  bridgeState = state || bridgeState
  const ui = bridgeState.ui || 'offline'
  const tab = bridgeState.attachedTab
  if ((ui === 'offline' || ui === 'error') && (activeSendId || promptSubmitting)) {
    rememberRetiredSendId(activeSendId)
    activeSendId = null
    activeSubmitSequence = null
    promptSubmitting = false
    pendingApproval = null
    removeActiveStepCard()
    hideApprovalCard()
    addMessage('assistant', [
      '⚠️ Связь с Verstak прервалась.',
      'Проверьте результат в основном чате перед повтором действия.',
    ])
  }
  if (tab) {
    if (els.pageTitle) els.pageTitle.textContent = tab.title || 'Текущая страница'
    try {
      const u = new URL(tab.url || '')
      if (els.pageDomain) els.pageDomain.textContent = u.host || u.protocol
    } catch {
      if (els.pageDomain) els.pageDomain.textContent = ''
    }
  }
  if (ui === 'attached') {
    updateStatusPill('attached', '● Подключено')
    setStatus('success', 'Текущая вкладка подключена')
  } else if (ui === 'paired') {
    updateStatusPill('connecting', '● Связь готова')
  } else {
    updateStatusPill('offline', '○ Авто-подключение')
  }
  updatePromptAvailability()
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

async function autoConnect() {
  try {
    const connRes = await chrome.runtime.sendMessage({ type: 'bridge.connect' })
    if (connRes && connRes.state) {
      paintConn(connRes.state)
    }
    if (!connRes?.ok) {
      setStatus('warn', SETTINGS_CONNECTION_HELP)
    }
  } catch {
    setStatus('warn', SETTINGS_CONNECTION_HELP)
  }
}

// ── User Prompt Execution (Product Loop) ─────────────────────────────────────

async function processUserPrompt(promptText) {
  const p = promptText.trim()
  if (!p) return
  if (bridgeState.ui !== 'attached' || !bridgeState.attachedTab) {
    setStatus('warn', 'Сначала нажмите значок Verstak на нужной странице')
    return
  }
  if (promptSubmitting || activeSendId) return

  addMessage('user', [p])
  if (els.promptInput) els.promptInput.value = ''

  streamText = ''
  streamNode = null
  const stepCard = addStepCard('Передаю задачу в Verstak...')
  activeStepCard = stepCard
  const submitId = ++submitSequence
  activeSubmitSequence = submitId
  promptSubmitting = true
  updatePromptAvailability()

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'bridge.submitTask',
      prompt: p,
    })

    // A disconnected request may settle after a later request already started.
    // Its response belongs to the old bridge generation and must not take over UI.
    if (activeSubmitSequence !== submitId) return

    if (!res?.ok) {
      const err = String(res?.error || 'offline')
      if (err.includes('offline') || err.includes('native port') || err.includes('not found')) {
        addMessage('assistant', [
          '🔴 Verstak Desktop оффлайн',
          'Для связи с AI-сотрудником запустите приложение Verstak на ПК.',
        ])
      } else {
        addMessage('assistant', ['⚠️ Не удалось запустить задачу: ' + err])
      }
      return
    }
    const returnedSendId = normalizeSendId(res.task?.sendId)
    if (returnedSendId && !retiredSendIds.has(returnedSendId)) {
      activeSendId = returnedSendId
    }
  } catch (err) {
    if (activeSubmitSequence === submitId) {
      addMessage('assistant', ['⚠️ Не удалось запустить задачу: ' + (err?.message || err)])
    }
  } finally {
    if (activeSubmitSequence === submitId) {
      if (stepCard?.parentNode) stepCard.parentNode.removeChild(stepCard)
      if (activeStepCard === stepCard) activeStepCard = null
      activeSubmitSequence = null
      promptSubmitting = false
      updatePromptAvailability()
    }
  }
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

async function resolvePendingApproval(approved) {
  if (!pendingApproval || approvalSubmitting) return
  const payload = pendingApproval
  approvalSubmitting = true
  if (els.approveBtn) els.approveBtn.disabled = true
  if (els.rejectBtn) els.rejectBtn.disabled = true
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'bridge.resolveTaskApproval',
      payload: { ...payload, approved, sendId: payload.sendId || activeSendId },
    })
    if (!res?.ok) throw new Error(res?.error || 'решение не доставлено')
    if (pendingApproval === payload) {
      pendingApproval = null
      hideApprovalCard()
    }
  } catch (err) {
    setStatus('warn', 'Не удалось отправить решение: ' + (err?.message || err))
  } finally {
    approvalSubmitting = false
    if (els.approveBtn) els.approveBtn.disabled = false
    if (els.rejectBtn) els.rejectBtn.disabled = false
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
    await resolvePendingApproval(true)
  })
}

if (els.rejectBtn) {
  els.rejectBtn.addEventListener('click', async () => {
    await resolvePendingApproval(false)
  })
}

if (els.stopBtn) {
  els.stopBtn.addEventListener('click', async () => {
    if (!activeSendId) return
    const stoppedSendId = activeSendId
    els.stopBtn.disabled = true
    try {
      const res = await chrome.runtime.sendMessage({ type: 'bridge.cancelTask', sendId: stoppedSendId })
      if (!res?.ok) throw new Error(res?.error || 'остановка не доставлена')
      rememberRetiredSendId(stoppedSendId)
      if (activeSendId === stoppedSendId) {
        activeSendId = null
        activeSubmitSequence = null
        promptSubmitting = false
        removeActiveStepCard()
        pendingApproval = null
        hideApprovalCard()
        setStatus('success', 'Остановлено')
        updatePromptAvailability()
      }
    } catch (err) {
      setStatus('warn', 'Не удалось остановить задачу: ' + (err?.message || err))
      els.stopBtn.disabled = false
    }
  })
}

chrome.runtime.onMessage?.addListener((message) => {
  if (message?.type === 'bridge.stateChanged') {
    paintConn(message.state)
    return
  }
  if (message?.type !== 'bridge.taskEvent') return
  const packet = message.payload || {}
  const event = packet.event || {}
  const eventSendId = normalizeSendId(packet.sendId)
  if (!eventSendId || retiredSendIds.has(eventSendId)) return
  if (activeSendId && activeSendId !== eventSendId) return
  activeSendId = eventSendId
  updatePromptAvailability()
  if (event.type === 'text' && typeof event.text === 'string') {
    appendAssistantText(event.text)
  } else if (event.type === 'agent-progress') {
    updateStatusPill('working', event.title || 'Работаю')
  } else if (event.type === 'pending-browser-action') {
    showApprovalCard({ ...event, sendId: packet.sendId })
  } else if (event.type === 'error') {
    addMessage('assistant', [event.message || 'Ошибка выполнения'])
    updateStatusPill('error', 'Ошибка')
    rememberRetiredSendId(eventSendId)
    activeSendId = null
    activeSubmitSequence = null
    promptSubmitting = false
    removeActiveStepCard()
    pendingApproval = null
    hideApprovalCard()
    updatePromptAvailability()
  } else if (event.type === 'done') {
    updateStatusPill('ready', 'Готово')
    rememberRetiredSendId(eventSendId)
    activeSendId = null
    activeSubmitSequence = null
    promptSubmitting = false
    removeActiveStepCard()
    pendingApproval = null
    hideApprovalCard()
    updatePromptAvailability()
  }
})

// Auto init on load
queryBridgeState()
autoConnect()
