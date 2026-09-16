import { createHash } from 'node:crypto'
import type {
  BackendCandidate,
  BackendObservation,
  ComputerBackend,
  ComputerBackendEvent,
  ComputerCommitOptions,
  ComputerCommitResult,
  ComputerIdentity,
  ComputerPrepareRequest,
  ComputerPreparedAction,
  ComputerProbe,
} from '../../electron/ai/computer/types'
import { ComputerSafetyError } from '../../electron/ai/computer/errors'

export interface Deferred<T = void> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const IDENTITY: ComputerIdentity = {
  pid: 4242,
  processStartTime100ns: '133700000000000000',
  hwnd: '0x0000000000012345',
}

export class FakeComputerBackend implements ComputerBackend {
  candidates: Array<Omit<BackendCandidate, 'candidateToken'>> = [{
    identity: { ...IDENTITY },
    processName: 'notepad.exe',
    title: 'Temporary canary',
    titleFingerprint: 'b'.repeat(64),
    elevated: false,
    protectedProcess: false,
    secureSurface: false,
  }]

  probe: ComputerProbe = {
    identity: { ...IDENTITY },
    title: 'Temporary canary',
    titleFingerprint: 'b'.repeat(64),
    geometry: { left: 100, top: 80, width: 900, height: 700 },
    dpi: 96,
    foreground: true,
    screenLocked: false,
    userInputEpoch: 1,
    destroyed: false,
    occluded: false,
    hitTestOwnWindow: true,
  }

  observation: Omit<BackendObservation, 'probe'> = {
    elements: [{
      backendRef: 'uia:editor',
      semanticFingerprint: 'a'.repeat(64),
      role: 'textbox',
      label: 'Text editor',
      state: 'focused',
      bounds: { left: 120, top: 120, width: 700, height: 500 },
      isPassword: false,
      supportedActions: ['click', 'type', 'key', 'scroll'],
      valueState: { fingerprint: 'c'.repeat(64), scalarLength: 0 },
      scrollState: { horizontalPercent: 50, verticalPercent: 50 },
    }],
    text: 'Temporary canary',
    screenshotDataUrl: null,
    omissions: [],
  }

  listCount = 0
  probeCount = 0
  observeCount = 0
  prepareCount = 0
  commitCount = 0
  cancelCount = 0
  stopCount = 0
  shutdownCount = 0
  committedChunkLengths: number[] = []
  lastPrepare: ComputerPrepareRequest | null = null
  lastPrepared: ComputerPreparedAction | null = null

  prepareBarrier: Deferred | null = null
  commitBarrier: Deferred | null = null
  observeBarrier: Deferred | null = null
  stopBarrier: Deferred | null = null
  throwBeforeTransfer: Error | null = null
  throwAfterTransfer: Error | null = null
  readbackMatched = true
  dispatchAccepted = true
  effectMatched = true
  forceMethod: ComputerPreparedAction['method'] | null = null
  forceChunkGuards: ComputerPreparedAction['chunkGuards'] = 'backend-enforced'
  failObserveAfterCommit: Error | null = null
  mutateAfterChunk: ((index: number, backend: FakeComputerBackend) => void) | null = null
  lastCandidateToken: string | null = null

  private listeners = new Set<(event: ComputerBackendEvent) => void>()
  private candidateLeaseNumber = 0
  private candidateLeases = new Map<string, ComputerIdentity>()
  private selectedIdentity: ComputerIdentity | null = null

  async listCandidates(): Promise<BackendCandidate[]> {
    this.listCount += 1
    return this.candidates.map(candidate => {
      const candidateToken = `candidate-lease:${(++this.candidateLeaseNumber).toString(16).padStart(24, '0')}`
      this.candidateLeases.set(candidateToken, { ...candidate.identity })
      return { ...candidate, candidateToken, identity: { ...candidate.identity } }
    })
  }

  async probeBinding(identity: ComputerIdentity, candidateToken?: string): Promise<ComputerProbe> {
    this.probeCount += 1
    if (candidateToken) {
      const leased = this.candidateLeases.get(candidateToken)
      this.candidateLeases.delete(candidateToken)
      if (!leased || !sameIdentity(leased, identity)) throw new Error('stale helper candidate lease')
      this.lastCandidateToken = candidateToken
      this.selectedIdentity = { ...identity }
    } else if (!this.selectedIdentity || !sameIdentity(this.selectedIdentity, identity)) {
      throw new Error('fresh helper candidate token required')
    }
    return {
      ...this.probe,
      identity: { ...this.probe.identity },
      geometry: { ...this.probe.geometry },
    }
  }

  async observe(_identity: ComputerIdentity): Promise<BackendObservation> {
    this.observeCount += 1
    if (this.observeBarrier) await this.observeBarrier.promise
    if (this.commitCount > 0 && this.failObserveAfterCommit) {
      throw this.failObserveAfterCommit
    }
    return {
      ...this.observation,
      probe: await this.probeBinding(_identity),
      elements: this.observation.elements.map(element => ({
        ...element,
        // Production helper refs are observation-scoped; only the semantic
        // fingerprint is stable across snapshots.
        backendRef: `${element.backendRef}:observation-${this.observeCount}`,
        bounds: element.bounds ? { ...element.bounds } : undefined,
        supportedActions: [...element.supportedActions],
      })),
      omissions: [...this.observation.omissions],
    }
  }

  async prepareAction(request: ComputerPrepareRequest): Promise<ComputerPreparedAction> {
    this.prepareCount += 1
    this.lastPrepare = request
    if (this.prepareBarrier) await this.prepareBarrier.promise
    const method = this.forceMethod
      ?? (request.uiaRequired ? 'uia' : request.action.kind === 'click' ? 'coordinates' : 'send-input')
    const expectedAfterValueState = request.action.kind === 'type'
      && request.resolvedElement?.expectedValueState
      ? (request.textChunks ?? []).reduce(
          (state, chunk) => advanceFakeValueState(state, chunk),
          { ...request.resolvedElement.expectedValueState },
        )
      : undefined
    const prepared: ComputerPreparedAction = {
      preparedId: `prepared-${this.prepareCount}`,
      attemptId: request.attemptId,
      method,
      identity: { ...request.identity },
      requiresHitTest: method === 'coordinates'
        || (request.action.kind === 'scroll' && method === 'send-input'),
      chunkGuards: request.textChunks && request.textChunks.length > 1
        ? this.forceChunkGuards
        : undefined,
      targetCheckIntervalMs: request.textChunks && request.textChunks.length > 1 ? 50 : undefined,
      ...(expectedAfterValueState ? { expectedAfterValueState } : {}),
    }
    this.lastPrepared = prepared
    return prepared
  }

  async commitAction(
    prepared: ComputerPreparedAction,
    options: ComputerCommitOptions,
  ): Promise<ComputerCommitResult> {
    this.commitCount += 1
    if (this.throwBeforeTransfer) throw this.throwBeforeTransfer
    options.onTransferred()
    if (this.commitBarrier) await this.commitBarrier.promise
    if (this.throwAfterTransfer) throw this.throwAfterTransfer

    const chunks = this.lastPrepare?.textChunks ?? []
    let liveValueState = this.lastPrepare?.resolvedElement?.expectedValueState
      ? { ...this.lastPrepare.resolvedElement.expectedValueState }
      : undefined
    for (let index = 0; index < chunks.length; index += 1) {
      await options.beforeChunk?.(index)
      if (options.signal.aborted) throw options.signal.reason ?? new Error('aborted')
      if (prepared.chunkGuards === 'backend-enforced' && this.lastPrepare) {
        assertBackendEnforcedTarget(this.lastPrepare, this.probe)
      }
      if (liveValueState && this.readbackMatched && this.dispatchAccepted && this.effectMatched) {
        const observed = this.observation.elements[0]
        if (!sameValueState(observed?.valueState, liveValueState)) {
          throw new ComputerSafetyError('readback-mismatch')
        }
        liveValueState = advanceFakeValueState(liveValueState, chunks[index] ?? '')
        observed!.valueState = { ...liveValueState }
      }
      this.committedChunkLengths.push(Array.from(chunks[index] ?? '').length)
      this.mutateAfterChunk?.(index, this)
    }

    const transition = this.lastPrepare?.resolvedElement?.expectedTransition
    if (transition && this.readbackMatched && this.dispatchAccepted && this.effectMatched) {
      const observed = this.observation.elements.find(element => (
        element.semanticFingerprint === this.observation.elements[0]?.semanticFingerprint
      ))
      if (observed) observed.state = transition.after
    }
    if (this.lastPrepare?.action.kind === 'scroll'
      && this.readbackMatched && this.dispatchAccepted && this.effectMatched) {
      const observed = this.observation.elements[0]
      if (observed?.scrollState) {
        observed.scrollState = {
          horizontalPercent: shiftedScrollPercent(
            observed.scrollState.horizontalPercent,
            this.lastPrepare.action.deltaX,
          ),
          verticalPercent: shiftedScrollPercent(
            observed.scrollState.verticalPercent,
            this.lastPrepare.action.deltaY,
          ),
        }
      }
    }

    return {
      attemptId: prepared.attemptId,
      readback: {
        matched: this.readbackMatched,
        dispatchAccepted: this.dispatchAccepted,
        effectMatched: this.effectMatched,
        detail: this.readbackMatched ? 'matched' : 'mismatch',
        postUserInputEpoch: this.probe.userInputEpoch,
      },
    }
  }

  async cancel(_attemptId: string): Promise<void> {
    this.cancelCount += 1
  }

  async stop(): Promise<void> {
    this.stopCount += 1
    this.candidateLeases.clear()
    if (this.stopBarrier) await this.stopBarrier.promise
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1
  }

  onEvent(listener: (event: ComputerBackendEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: ComputerBackendEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  invalidateCandidateLeases(hwnd: string): void {
    for (const [token, identity] of this.candidateLeases) {
      if (identity.hwnd === hwnd) this.candidateLeases.delete(token)
    }
  }
}

function shiftedScrollPercent(value: number, delta: number): number {
  if (delta === 0 || value < 0) return value
  return Math.max(0, Math.min(100, value + (delta > 0 ? 5 : -5)))
}

function advanceFakeValueState(
  state: NonNullable<BackendObservation['elements'][number]['valueState']>,
  chunk: string,
): NonNullable<BackendObservation['elements'][number]['valueState']> {
  return {
    fingerprint: createHash('sha256')
      .update(state.fingerprint, 'utf8')
      .update(':', 'utf8')
      .update(chunk, 'utf8')
      .digest('hex'),
    scalarLength: state.scalarLength + Array.from(chunk).length,
  }
}

function sameValueState(
  left: BackendObservation['elements'][number]['valueState'],
  right: BackendObservation['elements'][number]['valueState'],
): boolean {
  return !!left && !!right
    && left.fingerprint === right.fingerprint
    && left.scalarLength === right.scalarLength
}

function assertBackendEnforcedTarget(request: ComputerPrepareRequest, probe: ComputerProbe): void {
  if (!sameIdentity(request.identity, probe.identity)) throw new ComputerSafetyError('target-identity-changed')
  if (request.expected.title !== probe.title
    || request.expected.titleFingerprint !== probe.titleFingerprint) {
    throw new ComputerSafetyError('target-title-changed')
  }
  if (request.expected.geometry.left !== probe.geometry.left
    || request.expected.geometry.top !== probe.geometry.top
    || request.expected.geometry.width !== probe.geometry.width
    || request.expected.geometry.height !== probe.geometry.height) {
    throw new ComputerSafetyError('stale-geometry')
  }
  if (request.expected.dpi !== probe.dpi) throw new ComputerSafetyError('stale-dpi')
  if (request.expected.userInputEpoch !== probe.userInputEpoch) throw new ComputerSafetyError('hardware-input')
  if (probe.screenLocked) throw new ComputerSafetyError('screen-locked')
  if (!probe.foreground) throw new ComputerSafetyError('focus-lost')
}

function sameIdentity(left: ComputerIdentity, right: ComputerIdentity): boolean {
  return left.pid === right.pid
    && left.processStartTime100ns === right.processStartTime100ns
    && left.hwnd === right.hwnd
}
