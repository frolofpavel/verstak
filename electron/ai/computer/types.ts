// Narrow, provider-independent contract for the Windows Computer Employee.
//
// Raw window identity and backend element handles never cross the controller's
// public boundary. A renderer can choose only an opaque candidateId produced by
// listCandidates(); PID/HWND/process creation time stay in main-process memory.

export type ComputerAction = 'observe' | 'wait_for' | 'click' | 'type' | 'key' | 'scroll'
export type ComputerKey = 'Enter' | 'Tab' | 'Escape' | 'ArrowUp' | 'ArrowDown'
export type ComputerExecutionMethod = 'uia' | 'coordinates' | 'send-input'

export interface ComputerIdentity {
  pid: number
  /** GetProcessTimes creation FILETIME, serialized losslessly. */
  processStartTime100ns: string
  /** Native HWND serialized as an opaque integer/hex string. */
  hwnd: string
}

export interface WindowGeometry {
  left: number
  top: number
  width: number
  height: number
}

export interface BackendCandidate {
  /** Fresh, one-shot helper lease. It must stay behind the controller boundary. */
  candidateToken: string
  identity: ComputerIdentity
  processName: string
  /** Main-private executable product metadata used for browser deny classification. */
  productName?: string
  /** Main-private Win32 top-level class used for browser deny classification. */
  topLevelClassName?: string
  /** SHA-256 of the complete bounded normalized Win32 title; never renderer-visible. */
  titleFingerprint: string
  geometry: WindowGeometry
  visible: boolean
  foreground: boolean
  title: string
  elevated: boolean
  protectedProcess: boolean
  secureSurface: boolean
}

export interface ComputerCandidate {
  candidateId: string
  processName: string
  title: string
  blockedReason?: 'elevated' | 'protected-process' | 'secure-surface'
}

export interface ComputerProbe {
  identity: ComputerIdentity
  /** Normalized current top-level title; part of the selected document invariant. */
  title: string
  /** SHA-256 of the complete bounded normalized title; title may be display-clipped. */
  titleFingerprint: string
  geometry: WindowGeometry
  dpi: number
  foreground: boolean
  screenLocked: boolean
  userInputEpoch: number
  destroyed?: boolean
  occluded?: boolean
  hitTestOwnWindow?: boolean
  elevated?: boolean
  protectedProcess?: boolean
  secureSurface?: boolean
}

export type ComputerElementAction = 'click' | 'type' | 'key' | 'scroll'

export type ComputerExpectedElementTransition =
  | { kind: 'toggle'; before: 'off'; after: 'on' }
  | { kind: 'toggle'; before: 'on'; after: 'off' }
  | { kind: 'selection'; before: 'not-selected'; after: 'selected' }

export interface ComputerValueState {
  /** Per-helper-process salted SHA-256; never renderer/model/durable-visible. */
  fingerprint: string
  scalarLength: number
}

export interface ComputerScrollState {
  horizontalPercent: number
  verticalPercent: number
}

export interface BackendObservedElement {
  /** Helper-private handle. Never returned by ComputerController. */
  backendRef: string
  /** Stable, non-secret digest for the same semantic UIA control across snapshots. */
  semanticFingerprint: string
  role: string
  label: string
  state?: string
  bounds?: WindowGeometry
  isPassword: boolean
  supportedActions: ComputerElementAction[]
  /** Opaque helper state used only to reject stale ValuePattern append. */
  valueState?: ComputerValueState
  /** Exact helper-private ScrollPattern percentages at observation time. */
  scrollState?: ComputerScrollState
}

export interface BackendObservation {
  probe: ComputerProbe
  elements: BackendObservedElement[]
  text?: string
  screenshotDataUrl?: string | null
  omissions: string[]
}

export interface ComputerObservedElement {
  /** Snapshot- and binding-generation-scoped opaque reference. */
  elementRef: string
  role: string
  label: string
  state?: string
  bounds?: WindowGeometry
  supportedActions: ComputerElementAction[]
}

export interface ComputerObservation {
  observationId: string
  observationVersion: number
  capturedAt: number
  browserTaskId: string
  runId: string
  bindingGeneration: number
  targetFingerprint: string
  processName: string
  /** Display value and selected-document invariant within the exact HWND. */
  title: string
  geometry: WindowGeometry
  dpi: number
  foreground: boolean
  screenLocked: boolean
  userInputEpoch: number
  elements: ComputerObservedElement[]
  text: string
  screenshotDataUrl: string | null
  omissions: string[]
}

export interface ComputerPrepareRequest {
  attemptId: string
  identity: ComputerIdentity
  action:
    | { kind: 'click' }
    | { kind: 'type' }
    | { kind: 'key'; key: ComputerKey }
    | { kind: 'scroll'; deltaX: number; deltaY: number }
  resolvedElement?: {
    backendRef: string
    bounds?: WindowGeometry
    /** Helper-owned commit guard derived from the exact observed UIA state. */
    expectedTransition?: ComputerExpectedElementTransition
    expectedValueState?: ComputerValueState
    expectedScrollState?: ComputerScrollState
  }
  fallbackPoint?: { x: number; y: number }
  textChunks?: string[]
  /** If true, falling back to SendInput/coordinates is a controller violation. */
  uiaRequired: boolean
  expected: {
    title: string
    titleFingerprint: string
    geometry: WindowGeometry
    dpi: number
    foreground: true
    screenLocked: false
    userInputEpoch: number
  }
  signal: AbortSignal
}

export interface ComputerPreparedAction {
  preparedId: string
  attemptId: string
  method: ComputerExecutionMethod
  identity: ComputerIdentity
  requiresHitTest: boolean
  /** Long-input target checks must be enforced by the native helper. */
  chunkGuards?: 'controller-callback' | 'backend-enforced'
  /** Target contract only; the controller does not claim hard real-time. */
  targetCheckIntervalMs?: number
  /** Main-private token calculated effect-free by the helper during prepare. */
  expectedAfterValueState?: ComputerValueState
}

export interface ComputerCommitOptions {
  signal: AbortSignal
  /** Called immediately after the commit request was successfully transferred. */
  onTransferred(): void
  /** Required only when prepared.chunkGuards === 'controller-callback'. */
  beforeChunk?(index: number): Promise<void>
}

export interface ComputerCommitResult {
  attemptId?: string
  /** Independent helper-side post-action readback; false/missing is uncertain. */
  readback: {
    /** Exact target and safety state still match. */
    matched: boolean
    /** The backend accepted and attempted this exact prepared dispatch. */
    dispatchAccepted: boolean
    /** The requested semantic effect, not merely dispatch, was observed. */
    effectMatched: boolean
    detail?: string
    postUserInputEpoch?: number
  }
}

export type ComputerBackendEvent =
  | { type: 'hardware-input' }
  | { type: 'focus-lost' }
  | { type: 'screen-locked' }
  | { type: 'target-destroyed' }
  | { type: 'helper-crashed' }

export interface ComputerBackend {
  listCandidates(): Promise<BackendCandidate[]>
  probeBinding(identity: ComputerIdentity, candidateToken?: string): Promise<ComputerProbe>
  /** Bring the already bound exact HWND to the foreground and return a fresh probe. */
  focusBinding(identity: ComputerIdentity): Promise<ComputerProbe>
  observe(identity: ComputerIdentity): Promise<BackendObservation>
  /** Must be effect-free. */
  prepareAction(request: ComputerPrepareRequest): Promise<ComputerPreparedAction>
  /**
   * On a successful transport write, onTransferred must run before the first
   * async suspension. If the method rejects before that callback, the backend
   * guarantees the request was not written and cannot be transferred later.
   */
  commitAction(prepared: ComputerPreparedAction, options: ComputerCommitOptions): Promise<ComputerCommitResult>
  cancel(attemptId: string): void | Promise<unknown>
  stop(): void | Promise<unknown>
  shutdown(): void | Promise<void>
  onEvent(listener: (event: ComputerBackendEvent) => void): () => void
}

export interface ComputerDispatchInput {
  actionId?: string
  browserTaskId: string
  runId: string
  action: ComputerAction
  observationId?: string
  elementRef?: string
  text?: string
  clearFirst?: boolean
  key?: ComputerKey
  deltaX?: number
  deltaY?: number
  waitFor?: { elementRef?: string; text?: string }
  timeoutMs?: number
}

export type ComputerResultStatus = 'verified' | 'uncertain' | 'failed' | 'blocked' | 'cancelled'

export interface ComputerDispatchResult {
  ok: boolean
  actionId: string
  status: ComputerResultStatus
  reason?: string
  detail: string
  observation?: ComputerObservation
}

export interface ComputerBindingResult {
  ok: boolean
  bindingGeneration?: number
  targetFingerprint?: string
  processName?: string
  title?: string
  error?: string
}

export interface ComputerBindingView {
  bindingGeneration: number
  source: 'manual' | 'automatic'
  targetFingerprint: string
  processName: string
  title: string
  expiresAt: number | null
  reconciliationRequired: boolean
  /** True only when the selected exact target owns an uncertain (not live
   * executing) durable effect and main may offer a native human confirmation. */
  reconciliationAcknowledgementAvailable: boolean
}

export interface ComputerStopAck {
  acknowledged: true
  targetAckMs: 500
  realTimeGuaranteed: false
}
