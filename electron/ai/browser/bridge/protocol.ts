// protocol.ts — versioned wire-протокол Native Messaging (EXT-B1 + EXT-C1 click).
//
// Сообщения: hello / pair / status / attach / detach / observe / click / error.
// Никаких shell/JS-команд, произвольных payload-exec, cookie/token/session.
// Fail-closed: unknown type, wrong version, oversize, malformed → error.
// Click: только elementRef + lineage; raw CSS/JS/CDP запрещены.

import {
  BRIDGE_PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  type BridgeUiState,
} from './constants'

export type BridgeMsgType =
  | 'hello'
  | 'pair'
  | 'status'
  | 'attach'
  | 'detach'
  | 'observe'
  | 'observe_request'
  | 'click'
  | 'click_request'
  | 'navigate'
  | 'navigate_request'
  | 'scroll'
  | 'scroll_request'
  | 'focus'
  | 'focus_request'
  | 'select_option'
  | 'select_option_request'
  | 'type_text'
  | 'type_text_request'
  | 'clear_field'
  | 'clear_field_request'
  | 'toggle'
  | 'toggle_request'
  | 'press_key'
  | 'press_key_request'
  | 'wait_for'
  | 'wait_for_request'
  | 'task_submit'
  | 'task_event'
  | 'task_approval'
  | 'task_cancel'
  | 'error'

export interface BridgeTabInfo {
  tabRef: string
  url: string
  title: string
  origin: string
}

/** Interactive control from observation map (no passwords/secrets). */
export interface BridgeControl {
  elementRef: string
  role: string
  label: string
  state?: string
  observationVersion: number
}

/** Снимок страницы от Sensor Core (extractor) — без cookies/passwords. */
export interface BridgePageSnapshot {
  text: string
  tables: Array<{ caption: string; rows: string[][] }>
  source: { url: string; title: string; origin?: string }
  omissions?: string[]
  truncated?: { text?: boolean; selection?: boolean; tables?: boolean }
  selection?: string
  /** Limited map of buttons/links for click (EXT-C1). */
  controls?: BridgeControl[]
  observationVersion?: number
}

export interface BridgeBase {
  v: typeof BRIDGE_PROTOCOL_VERSION
  type: BridgeMsgType
  requestId: string
}

export interface HelloMsg extends BridgeBase {
  type: 'hello'
  client: 'chrome-extension'
  extensionId?: string
}

export interface PairMsg extends BridgeBase {
  type: 'pair'
  /** Одноразовый/durable pairing token, выданный desktop. */
  pairingToken?: string
  /** Восстановление после restart — session id прошлой пары. */
  sessionId?: string
}

export interface StatusMsg extends BridgeBase {
  type: 'status'
}

export interface AttachMsg extends BridgeBase {
  type: 'attach'
  tab: BridgeTabInfo
  browserTaskId?: string
}

export interface DetachMsg extends BridgeBase {
  type: 'detach'
  tabRef?: string
  browserTaskId?: string
}

/** Extension → desktop: результат observe (после observe_request или push). */
export interface ObserveMsg extends BridgeBase {
  type: 'observe'
  browserTaskId: string
  runId: string
  tabRef: string
  snapshot: BridgePageSnapshot
}

/** Desktop → extension: запросить observe активной/прикреплённой вкладки. */
export interface ObserveRequestMsg extends BridgeBase {
  type: 'observe_request'
  browserTaskId: string
  runId: string
  tabRef: string
}

/** Desktop → extension: один DOM click по elementRef (после approval). */
export interface ClickRequestMsg extends BridgeBase {
  type: 'click_request'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  /** Observation version that minted this elementRef; stale → reject. */
  observationVersion: number
  origin?: string
}

/** Extension → desktop: результат одного click. */
export interface ClickResultMsg extends BridgeBase {
  type: 'click'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  observationVersion: number
  ok: boolean
  finalUrl?: string
  error?: string
}

export interface NavigateRequestMsg extends BridgeBase {
  type: 'navigate_request'
  browserTaskId: string
  runId: string
  tabRef: string
  url: string
}

export interface NavigateResultMsg extends BridgeBase {
  type: 'navigate'
  browserTaskId: string
  runId: string
  tabRef: string
  ok: boolean
  finalUrl?: string
  title?: string
  error?: string
}

export interface ScrollRequestMsg extends BridgeBase {
  type: 'scroll_request'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef?: string
  delta?: { x?: number; y?: number }
}

export interface ScrollResultMsg extends BridgeBase {
  type: 'scroll'
  browserTaskId: string
  runId: string
  tabRef: string
  ok: boolean
  error?: string
}

export interface FocusRequestMsg extends BridgeBase {
  type: 'focus_request'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  observationVersion: number
}

export interface FocusResultMsg extends BridgeBase {
  type: 'focus'
  browserTaskId: string
  runId: string
  tabRef: string
  ok: boolean
  error?: string
}

export interface SelectOptionRequestMsg extends BridgeBase {
  type: 'select_option_request'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  observationVersion: number
  value: string
}

export interface SelectOptionResultMsg extends BridgeBase {
  type: 'select_option'
  browserTaskId: string
  runId: string
  tabRef: string
  ok: boolean
  error?: string
}

export interface WaitForRequestMsg extends BridgeBase {
  type: 'wait_for_request'
  browserTaskId: string
  runId: string
  tabRef: string
  condition: { elementRef?: string; text?: string; url?: string; timeoutMs?: number }
}

export interface WaitForResultMsg extends BridgeBase {
  type: 'wait_for'
  browserTaskId: string
  runId: string
  tabRef: string
  ok: boolean
  reason?: string
  error?: string
}

export interface TypeTextRequestMsg extends BridgeBase {
  type: 'type_text_request'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  observationVersion: number
  text: string
  clearFirst?: boolean
  submitEnter?: boolean
}

export interface TypeTextResultMsg extends BridgeBase {
  type: 'type_text'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  ok: boolean
  error?: string
}

export interface ClearFieldRequestMsg extends BridgeBase {
  type: 'clear_field_request'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  observationVersion: number
}

export interface ClearFieldResultMsg extends BridgeBase {
  type: 'clear_field'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  ok: boolean
  error?: string
}

export interface ToggleRequestMsg extends BridgeBase {
  type: 'toggle_request'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  observationVersion: number
}

export interface ToggleResultMsg extends BridgeBase {
  type: 'toggle'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  ok: boolean
  error?: string
}

export interface PressKeyRequestMsg extends BridgeBase {
  type: 'press_key_request'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  observationVersion: number
  key: string
}

export interface PressKeyResultMsg extends BridgeBase {
  type: 'press_key'
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
  ok: boolean
  error?: string
}

export interface ErrorMsg extends BridgeBase {
  type: 'error'
  code: string
  message: string
}

export interface TaskSubmitMsg extends BridgeBase {
  type: 'task_submit'
  prompt: string
}

export interface TaskApprovalMsg extends BridgeBase {
  type: 'task_approval'
  actionId: string
  approvalDigest: string
  browserTaskId: string
  runId: string
  sendId: number
  approved: boolean
}

export interface TaskCancelMsg extends BridgeBase {
  type: 'task_cancel'
  sendId: number
}

export interface TaskSubmitOkMsg extends BridgeBase {
  type: 'task_submit'
  ok: true
  sendId: number
  browserTaskId: string
  chatId: number
}

export interface TaskEventMsg extends BridgeBase {
  type: 'task_event'
  sendId: number
  event: unknown
}

export interface TaskApprovalOkMsg extends BridgeBase {
  type: 'task_approval'
  ok: true
}

export interface TaskCancelOkMsg extends BridgeBase {
  type: 'task_cancel'
  ok: true
}

export type BridgeInbound =
  | HelloMsg
  | PairMsg
  | StatusMsg
  | AttachMsg
  | DetachMsg
  | ObserveMsg
  | ClickResultMsg
  | NavigateResultMsg
  | ScrollResultMsg
  | FocusResultMsg
  | SelectOptionResultMsg
  | WaitForResultMsg
  | TypeTextResultMsg
  | ClearFieldResultMsg
  | ToggleResultMsg
  | PressKeyResultMsg
  | TaskSubmitMsg
  | TaskApprovalMsg
  | TaskCancelMsg
  | ErrorMsg

export type BridgeOutbound =
  | HelloOkMsg
  | PairOkMsg
  | StatusOkMsg
  | AttachOkMsg
  | DetachOkMsg
  | ObserveOkMsg
  | ObserveRequestMsg
  | ClickRequestMsg
  | ClickOkMsg
  | NavigateRequestMsg
  | ScrollRequestMsg
  | FocusRequestMsg
  | SelectOptionRequestMsg
  | WaitForRequestMsg
  | TypeTextRequestMsg
  | ClearFieldRequestMsg
  | ToggleRequestMsg
  | PressKeyRequestMsg
  | TaskSubmitOkMsg
  | TaskEventMsg
  | TaskApprovalOkMsg
  | TaskCancelOkMsg
  | ErrorMsg

export interface ClickOkMsg extends BridgeBase {
  type: 'click'
  ok: true
  browserTaskId: string
  runId: string
  tabRef: string
  elementRef: string
}

export interface HelloOkMsg extends BridgeBase {
  type: 'hello'
  ok: true
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION
  hostName: string
  desktopOnline: boolean
}

export interface PairOkMsg extends BridgeBase {
  type: 'pair'
  ok: true
  sessionId: string
  /**
   * Durable session credential for extension storage.
   * Returned once on successful pair; never log the full value.
   */
  pairingToken: string
  browserTaskId: string | null
  runId: string | null
  state: BridgeUiState
}

export interface StatusOkMsg extends BridgeBase {
  type: 'status'
  ok: true
  state: BridgeUiState
  desktopOnline: boolean
  sessionId: string | null
  browserTaskId: string | null
  runId: string | null
  attachedTab: BridgeTabInfo | null
  error?: string | null
}

export interface AttachOkMsg extends BridgeBase {
  type: 'attach'
  ok: true
  browserTaskId: string
  tabRef: string
  state: BridgeUiState
}

export interface DetachOkMsg extends BridgeBase {
  type: 'detach'
  ok: true
  state: BridgeUiState
}

export interface ObserveOkMsg extends BridgeBase {
  type: 'observe'
  ok: true
  observationId: string
  observationVersion: number
  browserTaskId: string
  runId: string
}

export type ParseResult =
  | { ok: true; msg: BridgeInbound }
  | { ok: false; code: string; message: string }

const ALLOWED_INBOUND = new Set<string>([
  'hello', 'pair', 'status', 'attach', 'detach', 'observe', 'click',
  'navigate', 'scroll', 'focus', 'select_option', 'wait_for',
  'type_text', 'clear_field', 'toggle', 'press_key', 'error',
  'task_submit', 'task_approval', 'task_cancel',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmptyString(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t.length > max) return null
  return t
}

function optionalString(v: unknown, max = 2000): string | undefined {
  if (v == null) return undefined
  if (typeof v !== 'string') return undefined
  if (v.length > max) return undefined
  return v
}

/** Валидация сырого буфера/строки → inbound message. Fail-closed. */
export function parseInboundMessage(raw: string | Buffer): ParseResult {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length
  if (bytes <= 0) {
    return { ok: false, code: 'empty', message: 'пустое сообщение' }
  }
  if (bytes > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      code: 'oversize',
      message: `сообщение ${bytes} байт > лимита ${MAX_MESSAGE_BYTES}`,
    }
  }

  let data: unknown
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8')
    data = JSON.parse(text)
  } catch {
    return { ok: false, code: 'malformed_json', message: 'невалидный JSON' }
  }

  if (!isPlainObject(data)) {
    return { ok: false, code: 'malformed', message: 'ожидался объект' }
  }

  if (data.v !== BRIDGE_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'bad_version',
      message: `ожидалась v=${BRIDGE_PROTOCOL_VERSION}, получено ${String(data.v)}`,
    }
  }

  const type = data.type
  if (typeof type !== 'string' || !ALLOWED_INBOUND.has(type)) {
    return { ok: false, code: 'unknown_type', message: `неизвестный type: ${String(type)}` }
  }

  const requestId = nonEmptyString(data.requestId, 128)
  if (!requestId) {
    return { ok: false, code: 'bad_request_id', message: 'requestId обязателен' }
  }

  // Запрет произвольных exec-полей.
  for (const forbidden of ['cmd', 'shell', 'exec', 'script', 'eval', 'command', 'js', 'code']) {
    if (forbidden in data) {
      return { ok: false, code: 'forbidden_field', message: `поле "${forbidden}" запрещено` }
    }
  }

  switch (type) {
    case 'hello': {
      if (data.client !== 'chrome-extension') {
        return { ok: false, code: 'bad_client', message: 'client должен быть chrome-extension' }
      }
      const msg: HelloMsg = {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'hello',
        requestId,
        client: 'chrome-extension',
        extensionId: optionalString(data.extensionId, 64),
      }
      return { ok: true, msg }
    }
    case 'pair': {
      const msg: PairMsg = {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'pair',
        requestId,
        pairingToken: optionalString(data.pairingToken, 256),
        sessionId: optionalString(data.sessionId, 128),
      }
      return { ok: true, msg }
    }
    case 'status': {
      return {
        ok: true,
        msg: { v: BRIDGE_PROTOCOL_VERSION, type: 'status', requestId },
      }
    }
    case 'task_submit': {
      const prompt = nonEmptyString(data.prompt, 20_000)
      if (!prompt) return { ok: false, code: 'bad_prompt', message: 'task_submit.prompt обязателен' }
      return { ok: true, msg: { v: BRIDGE_PROTOCOL_VERSION, type: 'task_submit', requestId, prompt } }
    }
    case 'task_approval': {
      const actionId = nonEmptyString(data.actionId, 128)
      const approvalDigest = nonEmptyString(data.approvalDigest, 256)
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const sendId = typeof data.sendId === 'number' && Number.isInteger(data.sendId) ? data.sendId : 0
      if (!actionId || !approvalDigest || !browserTaskId || !runId || sendId <= 0) {
        return { ok: false, code: 'bad_approval', message: 'task_approval scope невалиден' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION, type: 'task_approval', requestId,
          actionId, approvalDigest, browserTaskId, runId, sendId,
          approved: data.approved === true,
        },
      }
    }
    case 'task_cancel': {
      const sendId = typeof data.sendId === 'number' && Number.isInteger(data.sendId) ? data.sendId : 0
      if (sendId <= 0) return { ok: false, code: 'bad_send_id', message: 'task_cancel.sendId невалиден' }
      return { ok: true, msg: { v: BRIDGE_PROTOCOL_VERSION, type: 'task_cancel', requestId, sendId } }
    }
    case 'attach': {
      const tab = parseTab(data.tab)
      if (!tab) {
        return { ok: false, code: 'bad_tab', message: 'attach.tab невалиден' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'attach',
          requestId,
          tab,
          browserTaskId: optionalString(data.browserTaskId, 128),
        },
      }
    }
    case 'detach': {
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'detach',
          requestId,
          tabRef: optionalString(data.tabRef, 256),
          browserTaskId: optionalString(data.browserTaskId, 128),
        },
      }
    }
    case 'observe': {
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      if (!browserTaskId || !runId || !tabRef) {
        return {
          ok: false,
          code: 'bad_observe_ids',
          message: 'observe требует browserTaskId, runId, tabRef',
        }
      }
      const snapshot = parseSnapshot(data.snapshot)
      if (!snapshot) {
        return { ok: false, code: 'bad_snapshot', message: 'observe.snapshot невалиден' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'observe',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          snapshot,
        },
      }
    }
    case 'click': {
      // Extension → desktop click result (after click_request). Not a free-form CDP.
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      const elementRef = nonEmptyString(data.elementRef, 200)
      if (!browserTaskId || !runId || !tabRef || !elementRef) {
        return {
          ok: false,
          code: 'bad_click_ids',
          message: 'click требует browserTaskId, runId, tabRef, elementRef',
        }
      }
      // Reject raw selector/CSS/JS payloads — only opaque elementRef.
      for (const forbidden of ['selector', 'css', 'xpath', 'js', 'script', 'cdp']) {
        if (forbidden in data) {
          return { ok: false, code: 'forbidden_field', message: `поле "${forbidden}" запрещено в click` }
        }
      }
      const observationVersion =
        typeof data.observationVersion === 'number' && Number.isFinite(data.observationVersion)
          ? Math.floor(data.observationVersion)
          : 0
      const ok = data.ok === true
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'click',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          elementRef,
          observationVersion,
          ok,
          finalUrl: optionalString(data.finalUrl, 2048),
          error: optionalString(data.error, 1000),
        },
      }
    }
    case 'navigate': {
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      if (!browserTaskId || !runId || !tabRef) {
        return { ok: false, code: 'bad_ids', message: 'navigate требует browserTaskId, runId, tabRef' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'navigate',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          ok: data.ok === true,
          finalUrl: optionalString(data.finalUrl, 2048),
          title: optionalString(data.title, 500),
          error: optionalString(data.error, 1000),
        },
      }
    }
    case 'scroll': {
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      if (!browserTaskId || !runId || !tabRef) {
        return { ok: false, code: 'bad_ids', message: 'scroll требует browserTaskId, runId, tabRef' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'scroll',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          ok: data.ok === true,
          error: optionalString(data.error, 1000),
        },
      }
    }
    case 'focus': {
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      if (!browserTaskId || !runId || !tabRef) {
        return { ok: false, code: 'bad_ids', message: 'focus требует browserTaskId, runId, tabRef' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'focus',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          ok: data.ok === true,
          error: optionalString(data.error, 1000),
        },
      }
    }
    case 'select_option': {
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      if (!browserTaskId || !runId || !tabRef) {
        return { ok: false, code: 'bad_ids', message: 'select_option требует browserTaskId, runId, tabRef' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'select_option',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          ok: data.ok === true,
          error: optionalString(data.error, 1000),
        },
      }
    }
    case 'wait_for': {
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      if (!browserTaskId || !runId || !tabRef) {
        return { ok: false, code: 'bad_ids', message: 'wait_for требует browserTaskId, runId, tabRef' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'wait_for',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          ok: data.ok === true,
          reason: optionalString(data.reason, 200),
          error: optionalString(data.error, 1000),
        },
      }
    }
    case 'type_text': {
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      const elementRef = nonEmptyString(data.elementRef, 200)
      if (!browserTaskId || !runId || !tabRef || !elementRef) {
        return { ok: false, code: 'bad_ids', message: 'type_text требует browserTaskId, runId, tabRef, elementRef' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'type_text',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          elementRef,
          ok: data.ok === true,
          error: optionalString(data.error, 1000),
        },
      }
    }
    case 'clear_field': {
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      const elementRef = nonEmptyString(data.elementRef, 200)
      if (!browserTaskId || !runId || !tabRef || !elementRef) {
        return { ok: false, code: 'bad_ids', message: 'clear_field требует browserTaskId, runId, tabRef, elementRef' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'clear_field',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          elementRef,
          ok: data.ok === true,
          error: optionalString(data.error, 1000),
        },
      }
    }
    case 'toggle': {
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      const elementRef = nonEmptyString(data.elementRef, 200)
      if (!browserTaskId || !runId || !tabRef || !elementRef) {
        return { ok: false, code: 'bad_ids', message: 'toggle требует browserTaskId, runId, tabRef, elementRef' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'toggle',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          elementRef,
          ok: data.ok === true,
          error: optionalString(data.error, 1000),
        },
      }
    }
    case 'press_key': {
      const browserTaskId = nonEmptyString(data.browserTaskId, 128)
      const runId = nonEmptyString(data.runId, 128)
      const tabRef = nonEmptyString(data.tabRef, 256)
      const elementRef = nonEmptyString(data.elementRef, 200)
      if (!browserTaskId || !runId || !tabRef || !elementRef) {
        return { ok: false, code: 'bad_ids', message: 'press_key требует browserTaskId, runId, tabRef, elementRef' }
      }
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'press_key',
          requestId,
          browserTaskId,
          runId,
          tabRef,
          elementRef,
          ok: data.ok === true,
          error: optionalString(data.error, 1000),
        },
      }
    }
    case 'error': {
      const code = nonEmptyString(data.code, 64) ?? 'error'
      const message = nonEmptyString(data.message, 2000) ?? 'error'
      return {
        ok: true,
        msg: {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'error',
          requestId,
          code,
          message,
        },
      }
    }
    default:
      return { ok: false, code: 'unknown_type', message: `type ${type}` }
  }
}

function parseTab(raw: unknown): BridgeTabInfo | null {
  if (!isPlainObject(raw)) return null
  const tabRef = nonEmptyString(raw.tabRef, 256)
  const url = nonEmptyString(raw.url, 2048)
  const title = typeof raw.title === 'string' ? raw.title.slice(0, 500) : ''
  let origin = typeof raw.origin === 'string' ? raw.origin.slice(0, 500) : ''
  if (!tabRef || !url) return null
  if (!origin) {
    try { origin = new URL(url).origin } catch { origin = '' }
  }
  // chrome:// и служебные схемы — reject
  if (/^(chrome|chrome-extension|edge|about|devtools|view-source|file):/i.test(url)) {
    return null
  }
  return { tabRef, url, title, origin }
}

function parseSnapshot(raw: unknown): BridgePageSnapshot | null {
  if (!isPlainObject(raw)) return null
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 50_000) : ''
  if (!isPlainObject(raw.source)) return null
  const url = typeof raw.source.url === 'string' ? raw.source.url.slice(0, 2048) : ''
  const title = typeof raw.source.title === 'string' ? raw.source.title.slice(0, 500) : ''
  if (!url) return null
  let origin = typeof raw.source.origin === 'string' ? raw.source.origin.slice(0, 500) : ''
  if (!origin) {
    try { origin = new URL(url).origin } catch { origin = '' }
  }
  const tables: BridgePageSnapshot['tables'] = []
  if (Array.isArray(raw.tables)) {
    for (const t of raw.tables.slice(0, 5)) {
      if (!isPlainObject(t)) continue
      const caption = typeof t.caption === 'string' ? t.caption.slice(0, 200) : ''
      const rows: string[][] = []
      if (Array.isArray(t.rows)) {
        for (const row of t.rows.slice(0, 50)) {
          if (!Array.isArray(row)) continue
          rows.push(row.slice(0, 20).map((c) => String(c ?? '').slice(0, 500)))
        }
      }
      tables.push({ caption, rows })
    }
  }
  const omissions = Array.isArray(raw.omissions)
    ? raw.omissions.filter((x): x is string => typeof x === 'string').slice(0, 50)
    : undefined
  let truncated: BridgePageSnapshot['truncated']
  if (isPlainObject(raw.truncated)) {
    truncated = {
      text: !!raw.truncated.text,
      selection: !!raw.truncated.selection,
      tables: !!raw.truncated.tables,
    }
  }
  const controls: BridgeControl[] = []
  if (Array.isArray(raw.controls)) {
    for (const c of raw.controls.slice(0, 40)) {
      if (!isPlainObject(c)) continue
      const elementRef = nonEmptyString(c.elementRef, 200)
      const role = nonEmptyString(c.role, 40)
      const label = typeof c.label === 'string' ? c.label.slice(0, 120) : ''
      if (!elementRef || !role) continue
      const observationVersion =
        typeof c.observationVersion === 'number' && Number.isFinite(c.observationVersion)
          ? Math.floor(c.observationVersion)
          : 0
      controls.push({
        elementRef,
        role,
        label,
        state: typeof c.state === 'string' ? c.state.slice(0, 40) : undefined,
        observationVersion,
      })
    }
  }
  const observationVersion =
    typeof raw.observationVersion === 'number' && Number.isFinite(raw.observationVersion)
      ? Math.floor(raw.observationVersion)
      : undefined
  return {
    text,
    tables,
    source: { url, title, origin },
    omissions,
    truncated,
    selection: typeof raw.selection === 'string' ? raw.selection.slice(0, 5000) : undefined,
    controls: controls.length ? controls : undefined,
    observationVersion,
  }
}

/** Собрать error-ответ. */
export function makeError(
  requestId: string | undefined,
  code: string,
  message: string,
): ErrorMsg {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'error',
    requestId: requestId ?? 'none',
    code,
    message: message.slice(0, 2000),
  }
}

/** Сериализация outbound с hard-cap. */
export function serializeOutbound(msg: BridgeOutbound): string {
  const json = JSON.stringify(msg)
  if (Buffer.byteLength(json, 'utf8') > MAX_MESSAGE_BYTES) {
    return JSON.stringify(makeError(
      'requestId' in msg ? msg.requestId : undefined,
      'oversize_response',
      'ответ превышает MAX_MESSAGE_BYTES',
    ))
  }
  return json
}

/** Chrome Native Messaging frame: 4-byte LE length + UTF-8 JSON. */
export function encodeNativeFrame(json: string): Buffer {
  const body = Buffer.from(json, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

/**
 * Разбор потока stdin: накапливает буфер, отдаёт готовые JSON-строки.
 * Oversize length → error (не пытаемся читать тело).
 */
export class NativeFrameDecoder {
  private buf = Buffer.alloc(0)

  push(chunk: Buffer): Array<{ ok: true; json: string } | { ok: false; code: string; message: string }> {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: Array<{ ok: true; json: string } | { ok: false; code: string; message: string }> = []
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0)
      if (len > MAX_MESSAGE_BYTES) {
        out.push({
          ok: false,
          code: 'oversize',
          message: `frame length ${len} > ${MAX_MESSAGE_BYTES}`,
        })
        // fail-closed: сбрасываем поток
        this.buf = Buffer.alloc(0)
        break
      }
      if (this.buf.length < 4 + len) break
      const body = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      out.push({ ok: true, json: body.toString('utf8') })
    }
    return out
  }
}
