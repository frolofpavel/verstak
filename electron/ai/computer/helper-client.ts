import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { realpathSync, statSync } from 'node:fs'
import { win32 } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  COMPUTER_HELPER_VERSION,
  COMPUTER_PROTOCOL_VERSION,
  MAX_COMPUTER_CANDIDATES,
  MAX_COMPUTER_ELEMENTS,
  MAX_COMPUTER_MESSAGE_BYTES,
  MAX_COMPUTER_SCREENSHOT_BYTES,
  MAX_COMPUTER_SCREENSHOT_HEIGHT,
  MAX_COMPUTER_SCREENSHOT_WIDTH,
  MAX_COMPUTER_STDERR_BYTES,
  MAX_COMPUTER_TEXT_BYTES,
  makeComputerRequest,
  parseComputerMessage,
  serializeComputerRequest,
  type ComputerCandidate,
  type ComputerGeometry,
  type ComputerCommitResult,
  type ComputerHelperEvent,
  type ComputerObservation,
  type ComputerPrepareActionInput,
  type ComputerPreparedAction,
  type ComputerValueState,
  type ComputerWindowIdentity,
  type ComputerWindowProbe,
  type ComputerWireResponse,
  type ComputerRequestType,
} from './protocol'

export interface ComputerHelperChild extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals | number): boolean
}

type SpawnComputerHelper = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] },
) => ComputerHelperChild

export interface ComputerHelperClientOptions {
  helperPath: string
  appVersion: string
  spawn?: SpawnComputerHelper
  requestTimeoutMs?: number
  stopAckTimeoutMs?: number
  shutdownTimeoutMs?: number
  stderrLimitBytes?: number
  requestIdFactory?: () => string
  ownerPid?: number
  resolveOwnerStartTime100ns?: (ownerPid: number) => string
}

export class ComputerHelperProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComputerHelperProtocolError'
  }
}

export class ComputerHelperRemoteError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ComputerHelperRemoteError'
    this.code = code
  }
}

export class ComputerHelperCancelledError extends Error {
  constructor(message = 'Computer helper request cancelled before effect transfer') {
    super(message)
    this.name = 'ComputerHelperCancelledError'
  }
}

/** The action may have happened. It is forbidden to retry it automatically. */
export class ComputerUnknownEffectError extends Error {
  readonly attemptId: string | null

  constructor(message: string, attemptId: string | null = null) {
    super(message)
    this.name = 'ComputerUnknownEffectError'
    this.attemptId = attemptId
  }
}

interface PendingRequest {
  requestId: string
  type: ComputerRequestType
  generation: number
  attemptId: string | null
  effectTransferred: boolean
  settled: boolean
  resolve: (message: ComputerWireResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  abortSignal?: AbortSignal
  abortListener?: () => void
}

interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
  attemptId?: string
  effectfulCommit?: boolean
  onTransferred?: () => void
  skipHello?: boolean
  exactChild?: ComputerHelperChild
  exactGeneration?: number
}

type HelperHello = {
  ok: true
  protocolVersion: number
  helperVersion: string
  appVersion: string
  inputMonitorReady: true
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_STOP_ACK_TIMEOUT_MS = 500
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000
// A canonical System32 PowerShell cold start can exceed one second while the
// packaged/full suite is under load. This remains a small, fail-closed bound
// for the read-only owner identity query; no helper is spawned on timeout.
const OWNER_IDENTITY_QUERY_TIMEOUT_MS = 3_000
const OWNER_IDENTITY_QUERY_MAX_BYTES = 4_096
const CANDIDATE_TOKEN_PATTERN = /^candidate-lease:[a-f0-9]{24}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CANONICAL_FILETIME_PATTERN = /^[1-9][0-9]*$/
const SYSTEM_POWERSHELL_PARTS = [
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
] as const
const SYSTEM_ROOT_AT_MODULE_LOAD = process.platform === 'win32' ? process.env.SystemRoot : undefined

function requireCanonicalOwnerStartTime100ns(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_FILETIME_PATTERN.test(value)) {
    throw new ComputerHelperProtocolError('owner process creation identity is unavailable')
  }
  return value
}

export function requireSystemPowerShellPath(value: unknown): string {
  if (process.platform !== 'win32' || typeof value !== 'string' || !win32.isAbsolute(value)) {
    throw new ComputerHelperProtocolError('system PowerShell path is unavailable')
  }
  const rawSystemRoot = SYSTEM_ROOT_AT_MODULE_LOAD
  if (!rawSystemRoot || !win32.isAbsolute(rawSystemRoot)) {
    throw new ComputerHelperProtocolError('system PowerShell path is unavailable')
  }
  try {
    const canonicalSystemRoot = realpathSync.native(rawSystemRoot)
    if (win32.normalize(rawSystemRoot).toLocaleLowerCase('en-US')
      !== win32.normalize(canonicalSystemRoot).toLocaleLowerCase('en-US')) {
      throw new ComputerHelperProtocolError('system PowerShell path is not canonical')
    }
    const systemDirectory = win32.join(canonicalSystemRoot, 'System32')
    const expected = realpathSync.native(win32.join(canonicalSystemRoot, ...SYSTEM_POWERSHELL_PARTS))
    const relative = win32.relative(systemDirectory, expected)
    if (!relative || relative.startsWith('..') || win32.isAbsolute(relative)
      || win32.normalize(value).toLocaleLowerCase('en-US')
        !== win32.normalize(expected).toLocaleLowerCase('en-US')
      || !statSync(expected).isFile()) {
      throw new ComputerHelperProtocolError('system PowerShell path is not canonical')
    }
    return expected
  } catch (error) {
    if (error instanceof ComputerHelperProtocolError) throw error
    throw new ComputerHelperProtocolError('system PowerShell path is unavailable')
  }
}

export function resolveSystemPowerShellPath(): string {
  const systemRoot = SYSTEM_ROOT_AT_MODULE_LOAD
  if (!systemRoot) throw new ComputerHelperProtocolError('system PowerShell path is unavailable')
  return requireSystemPowerShellPath(win32.join(systemRoot, ...SYSTEM_POWERSHELL_PARTS))
}

export function queryOwnerStartTime100ns(
  ownerPid: number,
  spawnSyncImpl: typeof nodeSpawnSync = nodeSpawnSync,
): string {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid > 2_147_483_647) {
    throw new ComputerHelperProtocolError('owner PID is invalid')
  }
  const command = [
    `$owner = Get-Process -Id ${String(ownerPid)} -ErrorAction Stop`,
    "if ($owner.HasExited) { throw 'owner unavailable' }",
    '$start = $owner.StartTime.ToFileTimeUtc()',
    "if ($owner.HasExited) { throw 'owner unavailable' }",
    '[Console]::Out.Write($start.ToString([System.Globalization.CultureInfo]::InvariantCulture))',
  ].join('; ')
  let result: ReturnType<typeof nodeSpawnSync>
  try {
    result = spawnSyncImpl(resolveSystemPowerShellPath(), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: OWNER_IDENTITY_QUERY_TIMEOUT_MS,
      maxBuffer: OWNER_IDENTITY_QUERY_MAX_BYTES,
    })
  } catch {
    throw new ComputerHelperProtocolError('owner process creation identity query failed')
  }
  if (result.error || result.status !== 0 || result.signal != null) {
    throw new ComputerHelperProtocolError('owner process creation identity query failed')
  }
  return requireCanonicalOwnerStartTime100ns(String(result.stdout).trim())
}

function normalizeWindowTitle(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, 300)
}

function validScrollPercent(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && (value === -1 || (value >= 0 && value <= 100))
}

function asValueState(value: unknown, errorMessage: string): ComputerValueState {
  if (!isPlainObject(value)
    || typeof value.fingerprint !== 'string'
    || !SHA256_PATTERN.test(value.fingerprint)
    || typeof value.scalarLength !== 'number'
    || !Number.isSafeInteger(value.scalarLength)
    || value.scalarLength < 0) {
    throw new ComputerHelperProtocolError(errorMessage)
  }
  return { fingerprint: value.fingerprint, scalarLength: value.scalarLength }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readScreenshotDataUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const prefix = 'data:image/png;base64,'
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw new ComputerHelperProtocolError('helper screenshot must be a bounded PNG data URL')
  }
  const encoded = value.slice(prefix.length)
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new ComputerHelperProtocolError('helper screenshot base64 is invalid')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length === 0
    || bytes.length > MAX_COMPUTER_SCREENSHOT_BYTES
    || bytes.toString('base64') !== encoded) {
    throw new ComputerHelperProtocolError('helper screenshot exceeds the byte limit')
  }
  if (bytes.length < 24
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13
    || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new ComputerHelperProtocolError('helper screenshot PNG header is invalid')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 1 || width > MAX_COMPUTER_SCREENSHOT_WIDTH
    || height < 1 || height > MAX_COMPUTER_SCREENSHOT_HEIGHT) {
    throw new ComputerHelperProtocolError('helper screenshot dimensions exceed the limit')
  }
  return value
}

function asIdentity(value: unknown): ComputerWindowIdentity {
  if (!isPlainObject(value)
    || typeof value.pid !== 'number'
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || typeof value.processStartTime100ns !== 'string'
    || !/^\d+$/.test(value.processStartTime100ns)
    || typeof value.hwnd !== 'string'
    || !/^\d+$/.test(value.hwnd)) {
    throw new ComputerHelperProtocolError('helper returned invalid window identity')
  }
  return {
    pid: value.pid,
    processStartTime100ns: value.processStartTime100ns,
    hwnd: value.hwnd,
  }
}

function readGeometry(value: unknown): ComputerGeometry {
  if (!isPlainObject(value)) throw new ComputerHelperProtocolError('helper geometry invalid')
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new ComputerHelperProtocolError('helper geometry invalid')
    }
  }
  if ((value.width as number) <= 0 || (value.height as number) <= 0) {
    throw new ComputerHelperProtocolError('helper geometry invalid')
  }
  return {
    left: value.left as number,
    top: value.top as number,
    width: value.width as number,
    height: value.height as number,
  }
}

function validateTextChunks(chunks: string[] | undefined): void {
  if (!chunks) return
  let totalBytes = 0
  for (const chunk of chunks) {
    if (typeof chunk !== 'string' || [...chunk].length > 16) {
      throw new ComputerHelperProtocolError('type chunk must contain at most 16 Unicode scalars')
    }
    totalBytes += Buffer.byteLength(chunk, 'utf8')
  }
  if (totalBytes > MAX_COMPUTER_TEXT_BYTES) {
    throw new ComputerHelperProtocolError(`type payload exceeds ${MAX_COMPUTER_TEXT_BYTES} bytes`)
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/\b(token|secret|password|passwd|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|pk|key)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
}

function capUtf8Tail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const points = [...value]
  let bytes = 0
  let start = points.length
  while (start > 0) {
    const nextBytes = Buffer.byteLength(points[start - 1], 'utf8')
    if (bytes + nextBytes > maxBytes) break
    bytes += nextBytes
    start -= 1
  }
  return points.slice(start).join('')
}

export class ComputerHelperClient {
  private readonly options: Required<Pick<ComputerHelperClientOptions,
    'requestTimeoutMs' | 'stopAckTimeoutMs' | 'shutdownTimeoutMs' | 'stderrLimitBytes'>>
    & Omit<ComputerHelperClientOptions,
      'requestTimeoutMs' | 'stopAckTimeoutMs' | 'shutdownTimeoutMs' | 'stderrLimitBytes'>
  private readonly spawnImpl: SpawnComputerHelper
  private systemPowerShellPath: string | null = null
  private child: ComputerHelperChild | null = null
  private terminatingChild: ComputerHelperChild | null = null
  private generation = 0
  private requestSequence = 0
  private stdoutBuffer = Buffer.alloc(0)
  private stderrBuffer = ''
  private stderrPendingLine = ''
  private helloResult: HelperHello | null = null
  private helloPromise: Promise<HelperHello> | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: ComputerHelperEvent) => void>()
  private intentionallyClosing = false

  constructor(options: ComputerHelperClientOptions) {
    if (!options.helperPath) throw new Error('Computer helper path is required')
    if (!options.appVersion) throw new Error('Computer helper appVersion is required')
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      stopAckTimeoutMs: Math.min(options.stopAckTimeoutMs ?? DEFAULT_STOP_ACK_TIMEOUT_MS, 500),
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      stderrLimitBytes: Math.min(options.stderrLimitBytes ?? MAX_COMPUTER_STDERR_BYTES, MAX_COMPUTER_STDERR_BYTES),
    }
    this.spawnImpl = options.spawn ?? (nodeSpawn as unknown as SpawnComputerHelper)
  }

  onEvent(listener: (event: ComputerHelperEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  getRedactedStderr(): string {
    const pending = this.stderrPendingLine
      ? redactDiagnostic(this.stderrPendingLine)
      : ''
    return capUtf8Tail(`${this.stderrBuffer}${pending}`, this.options.stderrLimitBytes)
  }

  async hello(): Promise<HelperHello> {
    if (this.helloResult) return this.helloResult
    if (this.helloPromise) return this.helloPromise
    const exactChild = this.ensureChild()
    const helloGeneration = this.generation
    const promise = this.request('hello', {
      appVersion: this.options.appVersion,
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
    }, {
      skipHello: true,
      exactChild,
      exactGeneration: helloGeneration,
    }).then(message => {
      const protocolVersion = message.protocolVersion
      const helperVersion = message.helperVersion
      const appVersion = message.appVersion
      const inputMonitorReady = message.inputMonitorReady
      if (protocolVersion !== COMPUTER_PROTOCOL_VERSION
        || helperVersion !== COMPUTER_HELPER_VERSION
        || appVersion !== this.options.appVersion
        || inputMonitorReady !== true) {
        throw new ComputerHelperProtocolError(
          `computer helper version mismatch: protocol=${String(protocolVersion)} helper=${String(helperVersion)} app=${String(appVersion)}`,
        )
      }
      const result: HelperHello = {
        ok: true,
        protocolVersion,
        helperVersion,
        appVersion,
        inputMonitorReady: true,
      }
      this.helloResult = result
      return result
    }).catch(error => {
      this.terminateExactChild(helloGeneration)
      throw error
    }).finally(() => {
      if (this.helloPromise === promise) this.helloPromise = null
    })
    this.helloPromise = promise
    return promise
  }

  async ping(): Promise<ComputerWireResponse> {
    return this.request('ping')
  }

  async listCandidates(): Promise<ComputerCandidate[]> {
    const response = await this.request('list_candidates')
    if (!Array.isArray(response.candidates)) {
      throw new ComputerHelperProtocolError('helper candidates array missing')
    }
    if (response.candidates.length > MAX_COMPUTER_CANDIDATES) {
      throw new ComputerHelperProtocolError('helper candidate limit exceeded')
    }
    return response.candidates.map(value => {
      if (!isPlainObject(value)
        || typeof value.candidateToken !== 'string'
        || !CANDIDATE_TOKEN_PATTERN.test(value.candidateToken)
        || typeof value.processName !== 'string'
        || typeof value.title !== 'string'
        || !value.title
        || value.title !== normalizeWindowTitle(value.title)
        || typeof value.titleFingerprint !== 'string'
        || !SHA256_PATTERN.test(value.titleFingerprint)
        || !isPlainObject(value.geometry)
        || typeof value.visible !== 'boolean'
        || typeof value.foreground !== 'boolean'
        || (value.productName !== undefined && (
          typeof value.productName !== 'string'
          || value.productName.length > 160
          || /[\r\n]/u.test(value.productName)
        ))
        || (value.topLevelClassName !== undefined && (
          typeof value.topLevelClassName !== 'string'
          || value.topLevelClassName.length === 0
          || value.topLevelClassName.length > 160
          || /[\r\n]/u.test(value.topLevelClassName)
        ))) {
        throw new ComputerHelperProtocolError('helper candidate invalid')
      }
      return {
        candidateToken: value.candidateToken,
        identity: asIdentity(value.identity),
        processName: value.processName,
        ...(typeof value.productName === 'string' ? { productName: value.productName } : {}),
        ...(typeof value.topLevelClassName === 'string'
          ? { topLevelClassName: value.topLevelClassName }
          : {}),
        title: value.title,
        titleFingerprint: value.titleFingerprint,
        geometry: readGeometry(value.geometry),
        visible: value.visible,
        foreground: value.foreground,
        elevated: value.elevated === true,
        protectedProcess: value.protectedProcess === true,
        secureSurface: value.secureSurface === true,
      }
    })
  }

  async probeBinding(identity: ComputerWindowIdentity, candidateToken?: string): Promise<ComputerWindowProbe> {
    if (candidateToken != null && !CANDIDATE_TOKEN_PATTERN.test(candidateToken)) {
      throw new ComputerHelperProtocolError('helper candidate token invalid')
    }
    const response = await this.request('probe_binding', {
      identity,
      ...(candidateToken ? { candidateToken } : {}),
    })
    return this.readProbe(response.probe)
  }

  async focusBinding(identity: ComputerWindowIdentity): Promise<ComputerWindowProbe> {
    const response = await this.request('focus_binding', { identity })
    return this.readProbe(response.probe)
  }

  async observe(
    identity: ComputerWindowIdentity,
    context: { observationId?: string; observationVersion?: number } = {},
  ): Promise<ComputerObservation> {
    const response = await this.request('observe', { identity, context })
    if (!isPlainObject(response.observation) || !Array.isArray(response.observation.elements)) {
      throw new ComputerHelperProtocolError('helper observation invalid')
    }
    const observation = response.observation
    const rawElements = observation.elements as unknown[]
    if (rawElements.length > MAX_COMPUTER_ELEMENTS) {
      throw new ComputerHelperProtocolError('helper observation element limit exceeded')
    }
    const elements = rawElements.map((value: unknown) => {
      if (!isPlainObject(value)
        || typeof value.backendRef !== 'string'
        || typeof value.semanticFingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.semanticFingerprint)
        || typeof value.role !== 'string'
        || typeof value.label !== 'string'
        || typeof value.isPassword !== 'boolean'
        || !Array.isArray(value.supportedActions)
        || value.supportedActions.some(action => !['click', 'type', 'key', 'scroll'].includes(String(action)))) {
        throw new ComputerHelperProtocolError('helper observation element invalid')
      }
      let valueState: ComputerObservation['elements'][number]['valueState']
      if (value.valueState !== undefined && value.valueState !== null) {
        if (!isPlainObject(value.valueState)
          || typeof value.valueState.fingerprint !== 'string'
          || !SHA256_PATTERN.test(value.valueState.fingerprint)
          || typeof value.valueState.scalarLength !== 'number'
          || !Number.isSafeInteger(value.valueState.scalarLength)
          || value.valueState.scalarLength < 0) {
          throw new ComputerHelperProtocolError('helper ValuePattern state invalid')
        }
        valueState = {
          fingerprint: value.valueState.fingerprint,
          scalarLength: value.valueState.scalarLength,
        }
      }
      let scrollState: ComputerObservation['elements'][number]['scrollState']
      if (value.scrollState !== undefined && value.scrollState !== null) {
        if (!isPlainObject(value.scrollState)
          || !validScrollPercent(value.scrollState.horizontalPercent)
          || !validScrollPercent(value.scrollState.verticalPercent)) {
          throw new ComputerHelperProtocolError('helper ScrollPattern state invalid')
        }
        scrollState = {
          horizontalPercent: value.scrollState.horizontalPercent,
          verticalPercent: value.scrollState.verticalPercent,
        }
      }
      // JSON `null` means the helper could not expose this optional state. Do
      // not leak the raw nullable wire fields into the stricter controller
      // contract, where optional state is represented only by `undefined`.
      const { valueState: _wireValueState, scrollState: _wireScrollState, ...element } = value
      return {
        ...(element as unknown as ComputerObservation['elements'][number]),
        ...(valueState ? { valueState } : {}),
        ...(scrollState ? { scrollState } : {}),
      }
    })
    return {
      probe: this.readProbe(observation.probe),
      elements,
      text: typeof observation.text === 'string' ? observation.text : undefined,
      screenshotDataUrl: readScreenshotDataUrl(observation.screenshotDataUrl),
      omissions: Array.isArray(observation.omissions)
        ? observation.omissions.filter((value): value is string => typeof value === 'string')
        : [],
      observationId: typeof observation.observationId === 'string' ? observation.observationId : undefined,
      observationVersion: typeof observation.observationVersion === 'number'
        ? observation.observationVersion
        : undefined,
    }
  }

  async prepareAction(input: ComputerPrepareActionInput): Promise<ComputerPreparedAction> {
    if (input.signal?.aborted) throw new ComputerHelperCancelledError()
    validateTextChunks(input.textChunks)
    const { signal: _signal, ...wireInput } = input
    const response = await this.request('prepare_action', wireInput as unknown as Record<string, unknown>, {
      signal: input.signal,
      attemptId: input.attemptId,
    })
    const method = response.method
    if (typeof response.preparedId !== 'string'
      || response.attemptId !== input.attemptId
      || (method !== 'uia' && method !== 'coordinates' && method !== 'send-input')) {
      throw new ComputerHelperProtocolError('helper prepared response invalid')
    }
    const expectedAfterValueState = response.expectedAfterValueState === undefined
      ? undefined
      : asValueState(response.expectedAfterValueState, 'helper prepared ValuePattern state invalid')
    return {
      preparedId: response.preparedId,
      attemptId: input.attemptId,
      method,
      identity: asIdentity(response.identity),
      requiresHitTest: response.requiresHitTest === true,
      targetCheckIntervalMs: typeof response.targetCheckIntervalMs === 'number'
        ? response.targetCheckIntervalMs
        : undefined,
      chunkGuards: response.chunkGuards === 'backend-enforced'
        ? 'backend-enforced'
        : response.chunkGuards === 'controller-callback' ? 'controller-callback' : undefined,
      ...(expectedAfterValueState ? { expectedAfterValueState } : {}),
    }
  }

  async commitAction(
    prepared: ComputerPreparedAction,
    options: { signal?: AbortSignal; onTransferred?: () => void; beforeChunk?: () => Promise<void> } = {},
  ): Promise<ComputerCommitResult> {
    if (options.signal?.aborted) throw new ComputerHelperCancelledError()
    const response = await this.request('commit_action', {
      preparedId: prepared.preparedId,
      attemptId: prepared.attemptId,
    }, {
      signal: options.signal,
      attemptId: prepared.attemptId,
      effectfulCommit: true,
      onTransferred: options.onTransferred,
    })
    if (!isPlainObject(response.readback)
      || typeof response.readback.matched !== 'boolean'
      || typeof response.readback.dispatchAccepted !== 'boolean'
      || typeof response.readback.effectMatched !== 'boolean') {
      throw new ComputerUnknownEffectError('Computer action response has no trustworthy readback', prepared.attemptId)
    }
    return {
      readback: {
        matched: response.readback.matched,
        dispatchAccepted: response.readback.dispatchAccepted,
        effectMatched: response.readback.effectMatched,
        detail: typeof response.readback.detail === 'string' ? response.readback.detail : undefined,
        postUserInputEpoch: typeof response.readback.postUserInputEpoch === 'number'
          && Number.isSafeInteger(response.readback.postUserInputEpoch)
          && response.readback.postUserInputEpoch >= 0
          ? response.readback.postUserInputEpoch
          : undefined,
      },
    }
  }

  async cancel(attemptId: string): Promise<{ cancelled: boolean }> {
    const response = await this.request('cancel', { attemptId })
    return { cancelled: response.cancelled === true }
  }

  async stop(): Promise<{ stopped: boolean }> {
    const exactChild = this.child
    if (!exactChild) {
      // A timed-out request retires its generation before SIGTERM is confirmed.
      // Stop/unbind must not ACK while that exact process can still own input.
      await this.waitForTerminatingExactChild()
      return { stopped: true }
    }
    const generation = this.generation
    if (exactChild.exitCode != null || exactChild.signalCode != null) {
      this.terminateExactChild(generation)
      return { stopped: true }
    }
    const totalBudgetMs = Math.min(
      500,
      this.options.stopAckTimeoutMs + Math.min(this.options.shutdownTimeoutMs, 50),
    )
    const terminationReserveMs = Math.min(
      this.options.shutdownTimeoutMs,
      50,
      Math.max(0, totalBudgetMs - 1),
    )
    const stopRequestTimeoutMs = Math.max(
      1,
      Math.min(this.options.stopAckTimeoutMs, totalBudgetMs - terminationReserveMs),
    )
    const deadline = Date.now() + totalBudgetMs
    try {
      const stopRequest = this.request('stop', {}, {
        timeoutMs: stopRequestTimeoutMs,
        skipHello: true,
        exactChild,
        exactGeneration: generation,
      })
      const response = await stopRequest
      if (response.stopped !== true) {
        throw new ComputerHelperProtocolError('computer helper returned malformed Stop ACK')
      }
      return { stopped: true }
    } catch (error) {
      const exactChildExit = this.waitForExactChildExit(exactChild)
      let exitConfirmed = await this.terminateExactChildAndWait(
        exactChild,
        generation,
        Math.max(0, deadline - Date.now()),
      )
      if (!exitConfirmed) {
        // 500ms is the supported-matrix target, not permission to reopen the
        // successor while the exact failed child can still own desktop input.
        await exactChildExit
        exitConfirmed = true
      }
      throw new ComputerHelperProtocolError(
        `Stop ACK not received within ${totalBudgetMs}ms total budget; exact child exit ${exitConfirmed ? 'confirmed' : 'unconfirmed'}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async shutdown(): Promise<void> {
    const exactChild = this.child
    if (!exactChild) {
      await this.waitForTerminatingExactChild()
      return
    }
    const generation = this.generation
    this.intentionallyClosing = true
    try {
      if (exactChild.exitCode == null && exactChild.signalCode == null) {
        await this.request('shutdown', {}, {
          timeoutMs: this.options.shutdownTimeoutMs,
          skipHello: true,
          exactChild,
          exactGeneration: generation,
        })
      }
    } catch {
      // Shutdown is best effort, but termination stays scoped to this child.
    } finally {
      const exactChildExit = this.waitForExactChildExit(exactChild)
      const exitConfirmed = await this.terminateExactChildAndWait(
        exactChild,
        generation,
        this.options.shutdownTimeoutMs,
      )
      // shutdownTimeoutMs is an operational target, not evidence that the
      // process stopped. Keep shutdown (and app teardown) fail-closed until the
      // exact helper can no longer own input.
      if (!exitConfirmed) await exactChildExit
      this.intentionallyClosing = false
    }
  }

  private readProbe(value: unknown): ComputerWindowProbe {
    if (!isPlainObject(value) || !isPlainObject(value.geometry)) {
      throw new ComputerHelperProtocolError('helper window probe invalid')
    }
    const geometry = value.geometry
    for (const key of ['left', 'top', 'width', 'height'] as const) {
      if (typeof geometry[key] !== 'number' || !Number.isFinite(geometry[key])) {
        throw new ComputerHelperProtocolError('helper geometry invalid')
      }
    }
    if (typeof value.title !== 'string'
      || !value.title
      || value.title !== normalizeWindowTitle(value.title)
      || typeof value.titleFingerprint !== 'string'
      || !SHA256_PATTERN.test(value.titleFingerprint)
      || typeof value.dpi !== 'number'
      || typeof value.userInputEpoch !== 'number') {
      throw new ComputerHelperProtocolError('helper probe metadata invalid')
    }
    return {
      identity: asIdentity(value.identity),
      title: value.title,
      titleFingerprint: value.titleFingerprint,
      geometry: {
        left: geometry.left as number,
        top: geometry.top as number,
        width: geometry.width as number,
        height: geometry.height as number,
      },
      dpi: value.dpi,
      foreground: value.foreground === true,
      screenLocked: value.screenLocked === true,
      userInputEpoch: value.userInputEpoch,
      elevated: value.elevated === true,
      protectedProcess: value.protectedProcess === true,
      secureSurface: value.secureSurface === true,
      destroyed: value.destroyed === true || undefined,
      occluded: value.occluded === true || undefined,
      hitTestOwnWindow: value.hitTestOwnWindow === true || undefined,
    }
  }

  private async request(
    type: ComputerRequestType,
    payload: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<ComputerWireResponse> {
    if (!options.skipHello && type !== 'hello') await this.hello()
    let child: ComputerHelperChild
    let generation: number
    if (options.exactChild) {
      generation = options.exactGeneration ?? this.generation
      if (this.child !== options.exactChild
        || this.generation !== generation
        || options.exactChild.exitCode != null
        || options.exactChild.signalCode != null) {
        throw new ComputerHelperProtocolError('exact computer helper child is no longer available')
      }
      child = options.exactChild
    } else {
      child = this.ensureChild()
      generation = this.generation
    }
    const requestId = this.nextRequestId()
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs
    if (options.signal?.aborted) throw new ComputerHelperCancelledError()
    const wire = serializeComputerRequest(makeComputerRequest(type, requestId, payload))

    return new Promise<ComputerWireResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        requestId,
        type,
        generation,
        attemptId: options.attemptId ?? null,
        effectTransferred: false,
        settled: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.settlePending(pending, null, this.transportError(
            pending,
            `computer helper ${type} timeout after ${timeoutMs}ms`,
          ))
          // A response timeout makes the whole exact protocol generation
          // unusable, even before an effect. The error classification above
          // remains safe/unknown according to the transfer boundary, while the
          // child is retired unconditionally so late work cannot overlap a
          // successor.
          this.terminateExactChild(generation)
        }, timeoutMs),
        abortSignal: options.signal,
      }
      if (options.signal) {
        pending.abortListener = () => {
          const error = pending.effectTransferred
            ? new ComputerUnknownEffectError('Computer action aborted after commit transfer', pending.attemptId)
            : new ComputerHelperCancelledError()
          this.settlePending(pending, null, error)
        }
        options.signal.addEventListener('abort', pending.abortListener, { once: true })
      }
      this.pending.set(requestId, pending)
      try {
        if (child.stdin.destroyed || !child.stdin.writable) {
          throw new Error('helper stdin is not writable')
        }
        child.stdin.write(wire)
        if (options.effectfulCommit && generation === this.generation) {
          // This is the semantic uncertainty boundary: bytes were accepted by
          // the exact child stdin. No transport failure beyond it is retryable.
          pending.effectTransferred = true
          try {
            options.onTransferred?.()
          } catch {
            // Observer callbacks cannot alter action transport semantics.
          }
        }
      } catch (error) {
        this.settlePending(
          pending,
          null,
          pending.effectTransferred
            ? this.transportError(pending, 'computer helper stdin failed after commit transfer')
            : new ComputerHelperProtocolError(error instanceof Error ? error.message : String(error)),
        )
      }
    })
  }

  private ensureChild(): ComputerHelperChild {
    if (this.child && this.child.exitCode == null && this.child.signalCode == null) return this.child
    if (this.terminatingChild) {
      if (this.terminatingChild.exitCode == null && this.terminatingChild.signalCode == null) {
        throw new ComputerHelperProtocolError('previous computer helper child is still terminating')
      }
      this.terminatingChild = null
    }
    this.generation += 1
    const generation = this.generation
    this.stdoutBuffer = Buffer.alloc(0)
    this.stderrBuffer = ''
    this.stderrPendingLine = ''
    this.helloResult = null
    const ownerPid = this.options.ownerPid ?? process.pid
    const ownerStartTime100ns = requireCanonicalOwnerStartTime100ns(
      this.options.resolveOwnerStartTime100ns
        ? this.options.resolveOwnerStartTime100ns(ownerPid)
        : queryOwnerStartTime100ns(ownerPid),
    )
    this.systemPowerShellPath ??= resolveSystemPowerShellPath()
    const child = this.spawnImpl(this.systemPowerShellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.options.helperPath,
      '-OwnerPid',
      String(ownerPid),
      '-OwnerStartTime100ns',
      ownerStartTime100ns,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.on('data', (chunk: Buffer | string) => this.onStdout(generation, chunk))
    child.stderr.on('data', (chunk: Buffer | string) => this.onStderr(generation, chunk))
    child.stdin.on('error', (error: Error) => this.onChildTransportError(generation, error))
    child.stdout.on('error', (error: Error) => this.onChildTransportError(generation, error))
    child.on('error', (error: Error) => this.onChildTransportError(generation, error))
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.onChildExit(
        generation,
        child,
        new Error(`computer helper exited code=${String(code)} signal=${String(signal)}`),
      )
    })
    return child
  }

  private nextRequestId(): string {
    this.requestSequence += 1
    const logical = this.options.requestIdFactory?.() ?? 'desktop'
    const safe = logical.replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, 80) || 'desktop'
    // Sequence + helper generation prevents a late response from ever sharing
    // the wire id of a successor, even with a broken injected id factory.
    return `${safe}:${this.generation}:${this.requestSequence}`
  }

  private onStdout(generation: number, chunk: Buffer | string): void {
    if (generation !== this.generation) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes])
    if (this.stdoutBuffer.length > MAX_COMPUTER_MESSAGE_BYTES && this.stdoutBuffer.indexOf(0x0a) < 0) {
      this.failProtocol(generation, 'helper stdout line exceeds protocol limit')
      return
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a)
      if (newline < 0) break
      let line = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
      if (!line.length) continue
      const parsed = parseComputerMessage(line)
      if (!parsed.ok) {
        this.failProtocol(generation, `${parsed.code}: ${parsed.message}`)
        return
      }
      this.handleMessage(generation, parsed.message)
      if (generation !== this.generation) return
    }
  }

  private onStderr(generation: number, chunk: Buffer | string): void {
    if (generation !== this.generation) return
    this.stderrPendingLine += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    const lines = this.stderrPendingLine.split(/(?<=\n)/)
    this.stderrPendingLine = lines.pop() ?? ''
    for (const line of lines) this.appendStderr(redactDiagnostic(line))
    // Never retain an unbounded partial line. A giant line is diagnostically
    // useless and may contain a credential split across transport chunks.
    if (Buffer.byteLength(this.stderrPendingLine, 'utf8') > this.options.stderrLimitBytes) {
      this.stderrPendingLine = '[stderr line redacted]'
    }
  }

  private appendStderr(value: string): void {
    this.stderrBuffer = capUtf8Tail(`${this.stderrBuffer}${value}`, this.options.stderrLimitBytes)
  }

  private handleMessage(generation: number, message: ComputerWireResponse): void {
    if (message.type === 'event') {
      if (isPlainObject(message.event) && typeof message.event.type === 'string') {
        const allowed = new Set<ComputerHelperEvent['type']>([
          'hardware-input', 'focus-lost', 'screen-locked', 'target-destroyed', 'helper-crashed',
        ])
        if (allowed.has(message.event.type as ComputerHelperEvent['type'])) {
          const event = message.event as unknown as ComputerHelperEvent
          for (const listener of this.eventListeners) listener(event)
        }
      }
      return
    }
    const pending = this.pending.get(message.requestId)
    if (!pending || pending.generation !== generation || pending.settled) return
    if (message.type === 'error' || message.ok === false) {
      this.settlePending(pending, null, new ComputerHelperRemoteError(
        typeof message.code === 'string' ? message.code : 'helper_error',
        typeof message.message === 'string' ? message.message : 'computer helper rejected request',
      ))
      return
    }
    if (message.type !== pending.type) {
      this.failProtocol(generation, `response type ${message.type} does not match ${pending.type}`)
      return
    }
    this.settlePending(pending, message, null)
  }

  private settlePending(
    pending: PendingRequest,
    response: ComputerWireResponse | null,
    error: Error | null,
  ): void {
    if (pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    if (pending.abortSignal && pending.abortListener) {
      pending.abortSignal.removeEventListener('abort', pending.abortListener)
    }
    if (this.pending.get(pending.requestId) === pending) this.pending.delete(pending.requestId)
    if (error) pending.reject(error)
    else if (response) pending.resolve(response)
  }

  private transportError(pending: PendingRequest, message: string): Error {
    return pending.effectTransferred
      ? new ComputerUnknownEffectError(message, pending.attemptId)
      : new ComputerHelperProtocolError(message)
  }

  private failProtocol(generation: number, message: string): void {
    if (generation !== this.generation) return
    for (const pending of [...this.pending.values()]) {
      if (pending.generation !== generation) continue
      this.settlePending(pending, null, this.transportError(pending, message))
    }
    this.terminateExactChild(generation)
  }

  private onChildTransportError(generation: number, error: Error): void {
    if (generation !== this.generation) return
    for (const pending of [...this.pending.values()]) {
      if (pending.generation !== generation) continue
      this.settlePending(pending, null, this.transportError(pending, error.message))
    }
    // Pipe/process errors can precede the actual child exit. Retire and kill
    // the exact generation just like a protocol failure so no successor can
    // overlap a helper that may still own desktop input.
    this.terminateExactChild(generation)
  }

  private onChildExit(generation: number, exactChild: ComputerHelperChild, error: Error): void {
    if (this.terminatingChild === exactChild) {
      this.terminatingChild = null
      return
    }
    if (generation !== this.generation || this.child !== exactChild) return
    for (const pending of [...this.pending.values()]) {
      if (pending.generation !== generation) continue
      this.settlePending(pending, null, this.transportError(pending, error.message))
    }
    this.child = null
    this.helloResult = null
    this.helloPromise = null
    this.stdoutBuffer = Buffer.alloc(0)
    if (this.stderrPendingLine) this.appendStderr(redactDiagnostic(this.stderrPendingLine))
    this.stderrPendingLine = ''
    this.generation += 1
    this.emitHelperGenerationLost('helper process ended')
  }

  private terminateExactChild(expectedGeneration = this.generation): void {
    if (expectedGeneration !== this.generation) return
    const child = this.child
    if (!child) return
    this.child = null
    this.helloResult = null
    this.helloPromise = null
    this.stdoutBuffer = Buffer.alloc(0)
    if (this.stderrPendingLine) this.appendStderr(redactDiagnostic(this.stderrPendingLine))
    this.stderrPendingLine = ''
    this.generation += 1
    for (const pending of [...this.pending.values()]) {
      if (pending.generation !== expectedGeneration) continue
      this.settlePending(
        pending,
        null,
        this.transportError(pending, 'computer helper exact child terminated'),
      )
    }
    if (child.exitCode == null && child.signalCode == null) {
      this.terminatingChild = child
      child.kill('SIGTERM')
    }
    // Retiring a protocol generation destroys helper-private candidate leases,
    // selected-window watches, salted element state and backend refs. Tell the
    // controller immediately so its public binding cannot remain apparently
    // usable while a successor helper has none of that state. The late exit is
    // generation-scoped and therefore cannot invalidate a later successor.
    this.emitHelperGenerationLost('helper protocol generation retired')
  }

  private emitHelperGenerationLost(detail: string): void {
    if (this.intentionallyClosing) return
    const event: ComputerHelperEvent = { type: 'helper-crashed', detail }
    for (const listener of this.eventListeners) listener(event)
  }

  private waitForExactChildExit(exactChild: ComputerHelperChild): Promise<void> {
    if (exactChild.exitCode != null || exactChild.signalCode != null) return Promise.resolve()
    return new Promise(resolve => {
      const confirmExit = () => {
        exactChild.removeListener('exit', confirmExit)
        resolve()
      }
      exactChild.once('exit', confirmExit)
      // Close the event/property race without polling or a second timeout.
      if (exactChild.exitCode != null || exactChild.signalCode != null) confirmExit()
    })
  }

  private async waitForTerminatingExactChild(): Promise<void> {
    const exactChild = this.terminatingChild
    if (!exactChild) return
    await this.waitForExactChildExit(exactChild)
    if (this.terminatingChild === exactChild) this.terminatingChild = null
  }

  private async terminateExactChildAndWait(
    exactChild: ComputerHelperChild,
    expectedGeneration: number,
    timeoutMs: number,
  ): Promise<boolean> {
    if (exactChild.exitCode != null || exactChild.signalCode != null) return true
    let exited = false
    let exitListener: (() => void) | null = null
    const exit = new Promise<void>(resolve => {
      exitListener = () => {
        exited = true
        resolve()
      }
      exactChild.once('exit', exitListener)
    })
    this.terminateExactChild(expectedGeneration)
    if (exactChild.exitCode != null || exactChild.signalCode != null) exited = true
    if (!exited) {
      await Promise.race([
        exit,
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
      ])
    }
    if (exitListener) exactChild.removeListener('exit', exitListener)
    return exited || exactChild.exitCode != null || exactChild.signalCode != null
  }
}
