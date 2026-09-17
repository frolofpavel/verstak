// Narrow, versioned JSON-lines protocol for the Windows Computer Use helper.
// The helper accepts only the operations declared here: there is no shell,
// path, script or arbitrary-command escape hatch.

export const COMPUTER_PROTOCOL_VERSION = 1 as const
export const COMPUTER_HELPER_VERSION = '2.8.2' as const
export const MAX_COMPUTER_MESSAGE_BYTES = 64 * 1024
export const MAX_COMPUTER_STDERR_BYTES = 8 * 1024
export const MAX_COMPUTER_CANDIDATES = 128
export const MAX_COMPUTER_ELEMENTS = 300
export const MAX_COMPUTER_TEXT_BYTES = 32 * 1024
export const MAX_COMPUTER_SCREENSHOT_BYTES = 16 * 1024
export const MAX_COMPUTER_SCREENSHOT_WIDTH = 512
export const MAX_COMPUTER_SCREENSHOT_HEIGHT = 384

export interface ComputerWindowIdentity {
  pid: number
  processStartTime100ns: string
  hwnd: string
}

export interface ComputerGeometry {
  left: number
  top: number
  width: number
  height: number
}

export interface ComputerWindowProbe {
  identity: ComputerWindowIdentity
  title: string
  /** Complete normalized Win32 title digest; title itself is display-clipped. */
  titleFingerprint: string
  geometry: ComputerGeometry
  dpi: number
  foreground: boolean
  screenLocked: boolean
  userInputEpoch: number
  elevated?: boolean
  protectedProcess?: boolean
  secureSurface?: boolean
  destroyed?: boolean
  occluded?: boolean
  hitTestOwnWindow?: boolean
}

export interface ComputerCandidate {
  /** Fresh helper-issued lease. Main-process only; never exposed to the renderer. */
  candidateToken: string
  identity: ComputerWindowIdentity
  processName: string
  productName?: string
  topLevelClassName?: string
  title: string
  titleFingerprint: string
  elevated: boolean
  protectedProcess: boolean
  secureSurface: boolean
}

export type ComputerSupportedAction = 'click' | 'type' | 'key' | 'scroll'

export type ComputerExpectedElementTransition =
  | { kind: 'toggle'; before: 'off'; after: 'on' }
  | { kind: 'toggle'; before: 'on'; after: 'off' }
  | { kind: 'selection'; before: 'not-selected'; after: 'selected' }

export interface ComputerValueState {
  fingerprint: string
  scalarLength: number
}

export interface ComputerScrollState {
  horizontalPercent: number
  verticalPercent: number
}

export interface ComputerObservedElement {
  backendRef: string
  /** Backend-only stable digest used to match the same UIA control across observations. */
  semanticFingerprint: string
  role: string
  label: string
  state?: string
  bounds?: ComputerGeometry
  isPassword: boolean
  supportedActions: ComputerSupportedAction[]
  valueState?: ComputerValueState
  scrollState?: ComputerScrollState
}

export interface ComputerObservation {
  probe: ComputerWindowProbe
  elements: ComputerObservedElement[]
  text?: string
  screenshotDataUrl?: string
  omissions: string[]
  observationId?: string
  observationVersion?: number
}

export type ComputerAction =
  | { kind: 'click' }
  | { kind: 'type' }
  | { kind: 'key'; key?: string }
  | { kind: 'scroll'; deltaX?: number; deltaY?: number }

export interface ComputerExpectedState {
  title: string
  titleFingerprint: string
  geometry: ComputerGeometry
  dpi: number
  userInputEpoch: number
  foreground: boolean
  screenLocked: boolean
}

export interface ComputerPrepareActionInput {
  attemptId: string
  identity: ComputerWindowIdentity
  action: ComputerAction
  resolvedElement?: {
    backendRef: string
    expectedTransition?: ComputerExpectedElementTransition
    expectedValueState?: ComputerValueState
    expectedScrollState?: ComputerScrollState
  }
  fallbackPoint?: { x: number; y: number }
  /** Raw text exists only in this request and helper memory. Each chunk <=16 Unicode scalars. */
  textChunks?: string[]
  key?: string
  scroll?: { deltaX?: number; deltaY?: number }
  expected: ComputerExpectedState
  signal?: AbortSignal
}

export interface ComputerPreparedAction {
  preparedId: string
  attemptId: string
  method: 'uia' | 'coordinates' | 'send-input'
  identity: ComputerWindowIdentity
  requiresHitTest: boolean
  targetCheckIntervalMs?: number
  chunkGuards?: 'controller-callback' | 'backend-enforced'
  expectedAfterValueState?: ComputerValueState
}

export interface ComputerCommitResult {
  readback: {
    /** The exact target identity/geometry/DPI remained current after dispatch. */
    matched: boolean
    /** The selected OS/UIA dispatch API returned without rejecting the action. */
    dispatchAccepted: boolean
    /** An action-specific, non-secret postcondition proved a real state change. */
    effectMatched: boolean
    detail?: string
    postUserInputEpoch?: number
  }
}

export interface ComputerHelperEvent {
  type: 'hardware-input' | 'focus-lost' | 'screen-locked' | 'target-destroyed' | 'helper-crashed'
  identity?: ComputerWindowIdentity
  detail?: string
}

export type ComputerRequestType =
  | 'hello'
  | 'ping'
  | 'list_candidates'
  | 'probe_binding'
  | 'observe'
  | 'prepare_action'
  | 'commit_action'
  | 'cancel'
  | 'stop'
  | 'shutdown'

export type ComputerResponseType = ComputerRequestType | 'event' | 'error'

export interface ComputerWireBase {
  v: typeof COMPUTER_PROTOCOL_VERSION
  type: ComputerResponseType
  requestId: string
}

export interface ComputerWireResponse extends ComputerWireBase {
  ok?: boolean
  code?: string
  message?: string
  [key: string]: unknown
}

export type ComputerParseResult =
  | { ok: true; message: ComputerWireResponse }
  | { ok: false; code: string; message: string }

const RESPONSE_TYPES = new Set<ComputerResponseType>([
  'hello', 'ping', 'list_candidates', 'probe_binding', 'observe',
  'prepare_action', 'commit_action', 'cancel', 'stop', 'shutdown',
  'event', 'error',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 160
    && /^[A-Za-z0-9:._-]+$/.test(value)
}

/** Parse one complete stdout JSONL message. Any ambiguity is fail-closed. */
export function parseComputerMessage(raw: string | Buffer): ComputerParseResult {
  const byteLength = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length
  if (byteLength <= 0) return { ok: false, code: 'empty', message: 'пустое сообщение' }
  if (byteLength > MAX_COMPUTER_MESSAGE_BYTES) {
    return { ok: false, code: 'oversize', message: `message ${byteLength} > ${MAX_COMPUTER_MESSAGE_BYTES}` }
  }

  let data: unknown
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
  } catch {
    return { ok: false, code: 'malformed_json', message: 'невалидный JSON' }
  }
  if (!isPlainObject(data)) return { ok: false, code: 'malformed', message: 'ожидался объект' }
  if (data.v !== COMPUTER_PROTOCOL_VERSION) {
    return { ok: false, code: 'bad_version', message: `expected v=${COMPUTER_PROTOCOL_VERSION}` }
  }
  if (typeof data.type !== 'string' || !RESPONSE_TYPES.has(data.type as ComputerResponseType)) {
    return { ok: false, code: 'unknown_type', message: `unknown type ${String(data.type)}` }
  }
  if (!validRequestId(data.requestId)) {
    return { ok: false, code: 'bad_request_id', message: 'requestId required' }
  }

  for (const forbidden of ['shell', 'exec', 'script', 'command', 'powershell', 'argv', 'environment']) {
    if (forbidden in data) {
      return { ok: false, code: 'forbidden_field', message: `field ${forbidden} forbidden` }
    }
  }
  if (data.type !== 'event' && data.type !== 'error' && typeof data.ok !== 'boolean') {
    return { ok: false, code: 'bad_response', message: 'ok boolean required' }
  }
  if (data.type === 'error') {
    if (data.ok !== false || typeof data.code !== 'string' || typeof data.message !== 'string') {
      return { ok: false, code: 'bad_error', message: 'typed error required' }
    }
  }
  return { ok: true, message: data as ComputerWireResponse }
}

export function makeComputerRequest(
  type: ComputerRequestType,
  requestId: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!validRequestId(requestId)) throw new Error('invalid computer helper requestId')
  // Callers cannot replace routing/version identity through a payload spread.
  return { ...payload, v: COMPUTER_PROTOCOL_VERSION, type, requestId }
}

export function serializeComputerRequest(message: Record<string, unknown>): string {
  const serialized = JSON.stringify(message)
  const byteLength = Buffer.byteLength(serialized, 'utf8')
  if (byteLength > MAX_COMPUTER_MESSAGE_BYTES) {
    throw new Error(`computer helper request ${byteLength} > ${MAX_COMPUTER_MESSAGE_BYTES}`)
  }
  return `${serialized}\n`
}
