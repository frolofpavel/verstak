import { createHash, randomUUID } from 'node:crypto'
import type { BrowserActionRow, BrowserTasks } from '../../storage/browser-tasks'
import { classifyResponsibleComputerTarget } from '../responsible-action'
import { scanText } from '../secret-scanner'
import {
  ComputerCancelledError,
  ComputerSafetyError,
  computerErrorCode,
  type ComputerSafetyCode,
} from './errors'
import type {
  BackendCandidate,
  BackendObservedElement,
  ComputerAction,
  ComputerBackend,
  ComputerBackendEvent,
  ComputerBindingResult,
  ComputerBindingView,
  ComputerCandidate,
  ComputerDispatchInput,
  ComputerDispatchResult,
  ComputerExpectedElementTransition,
  ComputerIdentity,
  ComputerObservation,
  ComputerObservedElement,
  ComputerPrepareRequest,
  ComputerProbe,
  ComputerResultStatus,
  ComputerStopAck,
  WindowGeometry,
} from './types'
import { isComputerElementRef, isComputerObservationRef } from './refs'
import {
  chooseAutomaticTarget,
  parseAutomaticComputerUseRequest,
  type AutomaticComputerApp,
} from './automatic-target'

interface InternalCandidate {
  candidate: BackendCandidate
}

interface IdempotentDispatch {
  browserTaskId: string
  runId: string
  action: ComputerAction
  requestFingerprint: string
  promise: Promise<ComputerDispatchResult>
}

interface InternalBinding {
  identity: ComputerIdentity
  generation: number
  targetFingerprint: string
  processName: string
  title: string
  titleFingerprint: string
  source: 'manual' | 'automatic'
  claim: {
    browserTaskId: string
    runId: string
    expiresAt: number
  } | null
  uncertain: {
    browserTaskId: string
    runId: string
    actionId: string
    reason: ComputerSafetyCode
    targetFingerprint: string | null
    titleFingerprint: string | null
    status: 'executing' | 'uncertain'
  } | null
  /** A ledger read failure is itself a reconciliation boundary. Never turn an
   * unavailable durable verdict into permission to repeat an effect. */
  uncertainLookupFailed: boolean
}

interface InternalElement {
  public: ComputerObservedElement
  backend: BackendObservedElement
}

interface InternalObservation {
  public: ComputerObservation
  probe: ComputerProbe
  elements: Map<string, InternalElement>
}

interface ActiveAttempt {
  actionId: string
  attemptId: string
  browserTaskId: string
  runId: string
  abort: AbortController
  commitTransferred: boolean
  cancelReason: ComputerSafetyCode | null
}

interface InternalAcknowledgementChallenge {
  binding: InternalBinding
  bindingGeneration: number
  browserTaskId: string
  actionId: string
  targetFingerprint: string
  title: string
  titleFingerprint: string
  safetyEpoch: number
  expiresAt: number
}

export interface ComputerControllerDeps {
  storage: BrowserTasks
  backend: ComputerBackend
  now?: () => number
  prepareTimeoutMs?: number
  commitTimeoutMs?: number
  /**
   * Bounded quiet period between two independent post-action observations.
   * Tests may shorten it; production remains capped and abort-aware.
   */
  postconditionSettleMs?: number
  /** Tests may shorten this bound; production is always capped at 30 seconds. */
  maxSnapshotAgeMs?: number
  /**
   * Test harness only. Global SendInput/coordinates have an unavoidable
   * foreground TOCTOU and remain disabled in production until live acceptance.
   */
  testOnlyAllowUnverifiedGlobalInput?: boolean
  /** Test-only visibility into bounded cancelled-lineage bookkeeping. */
  testOnlyOnRunCancelEpochCount?: (size: number) => void
  /** Main-owned allowlisted launcher; arbitrary executable names never enter here. */
  launchApplication?: (app: AutomaticComputerApp) => Promise<void>
  /** Test seam for the bounded post-launch discovery wait. */
  automaticDiscoveryDelayMs?: number
}

export type ComputerRunAuthorizationResult =
  | {
      ok: true
      bindingGeneration: number
      expiresAt: number
      /** Прогон начался поверх недоказанного исхода прошлого действия, и эта
       *  команда закрыла его сама. Фолбэк, работающий молча, прячет то, что
       *  компенсирует, — человек обязан увидеть, что тут было неизвестное. */
      settledStaleUncertainty?: boolean
    }
  | { ok: false; error: ComputerSafetyCode }

export type ComputerAutomaticRunResult = ComputerRunAuthorizationResult
  | { ok: false; error: 'automatic-intent-unrecognized' | 'automatic-target-missing' | 'automatic-target-ambiguous' | 'automatic-launch-failed' | 'manual-target-mismatch' }

export interface ComputerUncertainAcknowledgementChallenge {
  challenge: string
  bindingGeneration: number
  processName: string
  title: string
}

export interface ComputerController {
  listCandidates(): Promise<ComputerCandidate[]>
  bindCandidate(candidateId: string): Promise<ComputerBindingResult>
  unbind(): Promise<void>
  getBinding(): ComputerBindingView | null
  authorizeRun(input: { browserTaskId: string; runId: string }): ComputerRunAuthorizationResult
  prepareAutomaticRun(input: {
    browserTaskId: string
    runId: string
    originalUserText: string
  }): Promise<ComputerAutomaticRunResult>
  observe(input: { browserTaskId: string; runId: string }): Promise<ComputerObservation>
  dispatch(input: ComputerDispatchInput): Promise<ComputerDispatchResult>
  cancelRun(browserTaskId: string, runId: string): Promise<void>
  prepareUncertainAcknowledgement(): ComputerUncertainAcknowledgementChallenge | null
  acknowledgePreparedUncertain(challenge: string): Promise<boolean>
  stop(): Promise<ComputerStopAck>
  shutdown(): Promise<void>
}

const KEY_ALLOWLIST = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'])
const TYPE_CHUNK_CODE_POINTS = 16
const CHUNK_CHECK_TARGET_MS = 50
const STOP_ACK_TARGET_MS = 500
const BINDING_CLAIM_TTL_MS = 5 * 60_000
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 30_000
const DEFAULT_PREPARE_TIMEOUT_MS = 5_000
const DEFAULT_COMMIT_TIMEOUT_MS = 15_000
const DEFAULT_POSTCONDITION_SETTLE_MS = 50
const MAX_POSTCONDITION_SETTLE_MS = 250
const ACKNOWLEDGEMENT_CHALLENGE_TTL_MS = 60_000
const MAX_ACKNOWLEDGEMENT_CHALLENGES = 16

export function createComputerController(deps: ComputerControllerDeps): ComputerController {
  const now = deps.now ?? (() => Date.now())
  const prepareTimeoutMs = deps.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
  const commitTimeoutMs = deps.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS
  const postconditionSettleMs = boundedPostconditionSettle(deps.postconditionSettleMs)
  const maxSnapshotAgeMs = boundedSnapshotAge(deps.maxSnapshotAgeMs)
  const automaticDiscoveryDelayMs = Math.max(0, Math.min(2_000, deps.automaticDiscoveryDelayMs ?? 300))
  const allowUnverifiedGlobalInput = deps.testOnlyAllowUnverifiedGlobalInput === true
  let candidates = new Map<string, InternalCandidate>()
  let binding: InternalBinding | null = null
  let bindingGeneration = 0
  let currentObservation: InternalObservation | null = null
  let queueTail: Promise<void> = Promise.resolve()
  let active: ActiveAttempt | null = null
  // A helper stop is global to the single desktop queue. Keep every successor
  // claim closed until every prior stop has acknowledged, otherwise a late ACK
  // can tear down work owned by a newly-authorized run.
  let stopAcksInFlight = 0
  let safetyEpoch = 0
  let shuttingDown = false
  const dispatches = new Map<string, IdempotentDispatch>()
  const runCancelEpochs = new Map<string, number>()
  const pendingDispatchesByLineage = new Map<string, number>()
  const acknowledgementChallenges = new Map<string, InternalAcknowledgementChallenge>()

  const unsubscribe = deps.backend.onEvent(event => {
    safetyEpoch += 1
    acknowledgementChallenges.clear()
    const reason = eventReason(event)
    currentObservation = null
    if (binding) binding.claim = null
    if (event.type === 'target-destroyed' || event.type === 'helper-crashed') {
      bindingGeneration += 1
      binding = null
      candidates.clear()
    }
    if (active) {
      active.cancelReason = reason
      active.abort.abort(new ComputerCancelledError(reason))
      fireAndForget(deps.backend.cancel(active.attemptId))
    }
    fireAndForget(beginBackendStop())
  })

  function beginBackendStop(): Promise<void> {
    stopAcksInFlight += 1
    try {
      return Promise.resolve(deps.backend.stop()).then(() => undefined).finally(() => {
        stopAcksInFlight = Math.max(0, stopAcksInFlight - 1)
      })
    } catch (error) {
      stopAcksInFlight = Math.max(0, stopAcksInFlight - 1)
      return Promise.reject(error)
    }
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queueTail.then(work, work)
    queueTail = result.then(() => undefined, () => undefined)
    return result
  }

  function retainDispatchLineage(key: string): void {
    pendingDispatchesByLineage.set(key, (pendingDispatchesByLineage.get(key) ?? 0) + 1)
  }

  function releaseDispatchLineage(key: string): void {
    const remaining = (pendingDispatchesByLineage.get(key) ?? 1) - 1
    if (remaining > 0) pendingDispatchesByLineage.set(key, remaining)
    else pendingDispatchesByLineage.delete(key)
    cleanupRunCancelEpoch(key)
  }

  function cleanupRunCancelEpoch(key: string): void {
    if ((pendingDispatchesByLineage.get(key) ?? 0) > 0) return
    if (active && lineageKey(active.browserTaskId, active.runId) === key) return
    if (runCancelEpochs.delete(key)) deps.testOnlyOnRunCancelEpochCount?.(runCancelEpochs.size)
  }

  async function listCandidates(): Promise<ComputerCandidate[]> {
    return enqueue(async () => {
      candidates.clear()
      const listed = await deps.backend.listCandidates()
      const next = new Map<string, InternalCandidate>()
      const result: ComputerCandidate[] = []
      for (const candidate of listed) {
        if (!validIdentity(candidate.identity)) continue
        if (isBrowserApplication(candidate)) continue
        const normalizedTitle = normalizeWindowTitle(candidate.title)
        if (!normalizedTitle) continue
        if (!validTitleFingerprint(candidate.titleFingerprint)) continue
        if (containsCredentialMarker(`${candidate.processName} ${normalizedTitle}`)) continue
        const normalizedCandidate = cloneCandidate({ ...candidate, title: normalizedTitle })
        const candidateId = `wc-${randomUUID()}`
        next.set(candidateId, { candidate: normalizedCandidate })
        result.push({
          candidateId,
          processName: candidate.processName,
          title: normalizedTitle,
          ...(candidateBlockedReason(candidate) ? { blockedReason: candidateBlockedReason(candidate) } : {}),
        })
      }
      candidates = next
      return result
    })
  }

  async function bindCandidateWithSource(
    candidateId: string,
    source: InternalBinding['source'],
  ): Promise<ComputerBindingResult> {
    return enqueue(async () => {
      const bindSafetyEpoch = safetyEpoch
      const listed = candidates.get(candidateId)
      if (!listed) return { ok: false, error: 'unknown-candidate' }
      candidates.delete(candidateId)
      const blocked = candidateBlockedReason(listed.candidate)
      if (blocked) return { ok: false, error: blocked }

      let probe: ComputerProbe
      try {
        probe = normalizeProbe(await deps.backend.probeBinding(listed.candidate.identity, listed.candidate.candidateToken))
      } catch {
        return { ok: false, error: 'target-destroyed' }
      }
      try {
        if (bindSafetyEpoch !== safetyEpoch) throw new ComputerCancelledError('stopped')
        assertSafeProbe(probe)
        if (!sameIdentity(listed.candidate.identity, probe.identity)) {
          throw new ComputerSafetyError('target-identity-changed')
        }
        if (listed.candidate.title !== probe.title
          || listed.candidate.titleFingerprint !== probe.titleFingerprint) {
          throw new ComputerSafetyError('target-title-changed')
        }
      } catch (error) {
        return { ok: false, error: computerErrorCode(error, 'target-identity-changed') }
      }

      bindingGeneration += 1
      acknowledgementChallenges.clear()
      binding = {
        identity: cloneIdentity(probe.identity),
        generation: bindingGeneration,
        targetFingerprint: identityFingerprint(probe.identity),
        processName: listed.candidate.processName,
        title: probe.title,
        titleFingerprint: probe.titleFingerprint,
        source,
        claim: null,
        uncertain: null,
        uncertainLookupFailed: false,
      }
      currentObservation = null
      candidates.clear()
      return {
        ok: true,
        bindingGeneration,
        targetFingerprint: binding.targetFingerprint,
        processName: binding.processName,
        title: binding.title,
      }
    })
  }

  async function bindCandidate(candidateId: string): Promise<ComputerBindingResult> {
    return bindCandidateWithSource(candidateId, 'manual')
  }

  async function focusCurrentBinding(): Promise<ComputerRunAuthorizationResult | null> {
    return enqueue(async () => {
      const current = binding
      if (!current) return { ok: false, error: 'no-binding' }
      try {
        const probe = normalizeProbe(await deps.backend.focusBinding(current.identity))
        assertSafeProbe(probe)
        assertBinding(current, probe)
        if (!probe.foreground) return { ok: false, error: 'focus-lost' }
        currentObservation = null
        return null
      } catch (error) {
        return { ok: false, error: computerErrorCode(error, 'focus-lost') }
      }
    })
  }

  async function prepareAutomaticRun(input: {
    browserTaskId: string
    runId: string
    originalUserText: string
  }): Promise<ComputerAutomaticRunResult> {
    const request = parseAutomaticComputerUseRequest(input.originalUserText)
    if (!request) return { ok: false, error: 'automatic-intent-unrecognized' }
    if (active || stopAcksInFlight > 0) {
      return { ok: false, error: 'binding-active' }
    }
    if (binding?.claim && binding.claim.browserTaskId !== input.browserTaskId) {
      if (binding.source !== 'automatic') {
        return { ok: false, error: 'binding-owner-mismatch' }
      }
      // Залежавшаяся отметка прошлой задачи claim не держит: её снимет
      // settleStaleUncertaintyForNewRequest уже после перепривязки к цели.
      // Держат только живое действие и нечитаемый журнал.
      refreshDurableUncertainty(binding, binding.claim.browserTaskId)
      if (binding.uncertainLookupFailed || binding.uncertain?.status === 'executing') {
        return { ok: false, error: 'uncertain-reconciliation-required' }
      }
      if (deps.storage.listActions(binding.claim.browserTaskId, { status: 'executing' }).length > 0) {
        return { ok: false, error: 'binding-active' }
      }
      // Automatic bindings are per-run leases, not a user-selected scope.
      // Once the prior effect is durably settled, release its claim so a new
      // ordinary chat can discover and bind its own target without Settings.
      await unbind()
    }

    if (binding?.source === 'manual') {
      const forced = chooseAutomaticTarget(request.targetApp, [{
        candidateId: 'manual-binding',
        processName: binding.processName,
        title: binding.title,
        bounds: { left: 0, top: 0, width: 1, height: 1 },
        visible: true,
        foreground: false,
        blocked: false,
      }])
      if (forced.kind !== 'selected') return { ok: false, error: 'manual-target-mismatch' }
      const focusError = await focusCurrentBinding()
      if (focusError) return focusError
      return settleThenAuthorizeRun(input)
    }

    if (binding) await unbind()
    let listed = await listCandidates()
    let selection = chooseAutomaticTarget(request.targetApp, automaticTargetCandidates(listed))
    if (selection.kind === 'missing' && request.openTargetIfMissing) {
      if (!deps.launchApplication) return { ok: false, error: 'automatic-target-missing' }
      try {
        await deps.launchApplication(request.targetApp)
      } catch {
        return { ok: false, error: 'automatic-launch-failed' }
      }
      for (let attempt = 0; attempt < 10 && selection.kind === 'missing'; attempt += 1) {
        if (automaticDiscoveryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, automaticDiscoveryDelayMs))
        }
        listed = await listCandidates()
        selection = chooseAutomaticTarget(request.targetApp, automaticTargetCandidates(listed))
      }
    }
    if (selection.kind === 'missing') return { ok: false, error: 'automatic-target-missing' }
    if (selection.kind === 'ambiguous') return { ok: false, error: 'automatic-target-ambiguous' }

    const bound = await bindCandidateWithSource(selection.candidateId, 'automatic')
    if (!bound.ok) return { ok: false, error: computerErrorCode(bound.error, 'no-binding') }
    let focusError = await focusCurrentBinding()
    if (focusError && !focusError.ok && focusError.error === 'focus-lost') {
      // Modern Windows apps may redirect activation to a sibling top-level
      // HWND (Notepad tabs/windows are the common case). Never follow that
      // HWND implicitly: discard the old binding, obtain fresh helper leases,
      // and bind the newly foreground candidate through the normal selector.
      await unbind()
      listed = await listCandidates()
      selection = chooseAutomaticTarget(request.targetApp, automaticTargetCandidates(listed))
      if (selection.kind === 'missing') return { ok: false, error: 'automatic-target-missing' }
      if (selection.kind === 'ambiguous') return { ok: false, error: 'automatic-target-ambiguous' }
      const rebound = await bindCandidateWithSource(selection.candidateId, 'automatic')
      if (!rebound.ok) return { ok: false, error: computerErrorCode(rebound.error, 'no-binding') }
      focusError = await focusCurrentBinding()
    }
    if (focusError) return focusError
    return settleThenAuthorizeRun(input)

    function automaticTargetCandidates(list: readonly ComputerCandidate[]) {
      return list.flatMap(candidate => {
        const internal = candidates.get(candidate.candidateId)?.candidate
        return internal ? [{
          candidateId: candidate.candidateId,
          processName: internal.processName,
          title: internal.title,
          bounds: { ...internal.geometry },
          visible: internal.visible,
          foreground: internal.foreground,
          blocked: candidateBlockedReason(internal) != null,
        }] : []
      })
    }
  }

  function getBinding(): ComputerBindingView | null {
    if (binding?.claim && now() >= binding.claim.expiresAt) invalidateExpiredBinding(binding)
    if (!binding) return null
    refreshDurableUncertainty(
      binding,
      binding.claim?.browserTaskId ?? binding.uncertain?.browserTaskId ?? '',
    )
    return {
      bindingGeneration: binding.generation,
      source: binding.source,
      targetFingerprint: binding.targetFingerprint,
      processName: binding.processName,
      title: binding.title,
      expiresAt: binding.claim?.expiresAt ?? null,
      reconciliationRequired: binding.uncertain != null || binding.uncertainLookupFailed,
      reconciliationAcknowledgementAvailable: binding.uncertainLookupFailed === false
        && binding.uncertain?.status === 'uncertain'
        && binding.uncertain.targetFingerprint === binding.targetFingerprint
        && binding.uncertain.titleFingerprint === binding.titleFingerprint
        && active == null
        && stopAcksInFlight === 0,
    }
  }

  function refreshDurableUncertainty(
    current: InternalBinding,
    browserTaskId: string,
  ): boolean {
    try {
      const unresolved = deps.storage.findUnacknowledgedComputerEffect(
        browserTaskId,
        current.targetFingerprint,
      )
      current.uncertainLookupFailed = false
      current.uncertain = unresolved
        ? {
            browserTaskId: unresolved.browserTaskId,
            runId: unresolved.runId,
            actionId: unresolved.actionId,
            reason: 'uncertain-reconciliation-required',
            targetFingerprint: typeof unresolved.scope.targetFingerprint === 'string'
              ? unresolved.scope.targetFingerprint
              : null,
            titleFingerprint: typeof unresolved.scope.titleFingerprint === 'string'
              && validTitleFingerprint(unresolved.scope.titleFingerprint)
              ? unresolved.scope.titleFingerprint
              : null,
            status: unresolved.status === 'executing' ? 'executing' : 'uncertain',
          }
        : null
      return unresolved == null
    } catch {
      current.uncertainLookupFailed = true
      currentObservation = null
      return false
    }
  }

  function authorizeRun(input: { browserTaskId: string; runId: string }): ComputerRunAuthorizationResult {
    const task = deps.storage.get(input.browserTaskId)
    const run = deps.storage.currentRun(input.browserTaskId)
    if (!task || task.endedAt != null || task.currentRunId !== input.runId
      || !run || run.runId !== input.runId) {
      return { ok: false, error: 'inactive-run' }
    }
    const current = binding
    if (!current) return { ok: false, error: 'no-binding' }
    if (stopAcksInFlight > 0) return { ok: false, error: 'binding-active' }
    if (current.claim && now() >= current.claim.expiresAt) {
      invalidateExpiredBinding(current)
      return { ok: false, error: 'binding-expired' }
    }
    if (!refreshDurableUncertainty(current, input.browserTaskId)) {
      return { ok: false, error: 'uncertain-reconciliation-required' }
    }

    const claim = current.claim
    if (claim && claim.browserTaskId !== input.browserTaskId) {
      return { ok: false, error: 'binding-owner-mismatch' }
    }
    if (claim && claim.runId !== input.runId) {
      if (active || deps.storage.listActions(input.browserTaskId, { status: 'executing' }).length > 0) {
        return { ok: false, error: 'binding-active' }
      }
      currentObservation = null
    }

    const expiresAt = now() + BINDING_CLAIM_TTL_MS
    current.claim = {
      browserTaskId: input.browserTaskId,
      runId: input.runId,
      expiresAt,
    }
    return { ok: true, bindingGeneration: current.generation, expiresAt }
  }

  async function observe(input: { browserTaskId: string; runId: string }): Promise<ComputerObservation> {
    return enqueue(async () => {
      const attempt: ActiveAttempt = {
        actionId: `direct-observe:${randomUUID()}`,
        attemptId: `direct-observe:${randomUUID()}`,
        browserTaskId: input.browserTaskId,
        runId: input.runId,
        abort: new AbortController(),
        commitTransferred: false,
        cancelReason: null,
      }
      active = attempt
      try {
        throwIfAborted(attempt)
        const observation = await captureObservation(input.browserTaskId, input.runId, false, attempt)
        throwIfAborted(attempt)
        return observation
      } finally {
        if (attempt.abort.signal.aborted) currentObservation = null
        if (active === attempt) active = null
      }
    })
  }

  async function unbind(): Promise<void> {
    safetyEpoch += 1
    acknowledgementChallenges.clear()
    bindingGeneration += 1
    binding = null
    currentObservation = null
    candidates.clear()
    if (active) {
      active.cancelReason = 'stopped'
      active.abort.abort(new ComputerCancelledError('stopped'))
      fireAndForget(deps.backend.cancel(active.attemptId))
    }
    await beginBackendStop()
  }

  function dispatch(input: ComputerDispatchInput): Promise<ComputerDispatchResult> {
    const actionId = input.actionId?.trim() || randomUUID()
    // Legacy/forged callers must not turn an already-verified append into a
    // clearFirst replay by exploiting durable boolean normalization.
    if (input.action === 'type' && input.clearFirst !== undefined) {
      return Promise.resolve(plainResult(actionId, 'blocked', 'invalid-action'))
    }
    const requestFingerprint = ephemeralRequestFingerprint(input)
    const inflight = dispatches.get(actionId)
    if (inflight) {
      if (inflight.browserTaskId !== input.browserTaskId
        || inflight.runId !== input.runId
        || inflight.action !== input.action
        || inflight.requestFingerprint !== requestFingerprint) {
        return Promise.resolve(plainResult(actionId, 'blocked', 'action-id-conflict'))
      }
      return inflight.promise
    }

    const existing = deps.storage.getAction(actionId)
    if (existing) {
      if (existing.browserTaskId !== input.browserTaskId
        || existing.runId !== input.runId
        || existing.actionType !== `computer:${input.action}`
        || !binding
        || existing.scope.targetFingerprint !== binding.targetFingerprint
        || existing.scope.titleFingerprint !== binding.titleFingerprint
        || !matchesDurableReplay(existing, input)) {
        return Promise.resolve(plainResult(actionId, 'blocked', 'action-id-conflict'))
      }
      const prior = Promise.resolve(resultFromExisting(existing))
      dispatches.set(actionId, {
        browserTaskId: input.browserTaskId,
        runId: input.runId,
        action: input.action,
        requestFingerprint,
        promise: prior,
      })
      return prior
    }

    const scheduledSafetyEpoch = safetyEpoch
    const dispatchLineage = lineageKey(input.browserTaskId, input.runId)
    const scheduledRunCancelEpoch = runCancelEpoch(input.browserTaskId, input.runId)
    retainDispatchLineage(dispatchLineage)
    const work = enqueue(() => execute(
      { ...input, actionId },
      scheduledSafetyEpoch,
      scheduledRunCancelEpoch,
    ))
    void work.then(
      () => releaseDispatchLineage(dispatchLineage),
      () => releaseDispatchLineage(dispatchLineage),
    )
    dispatches.set(actionId, {
      browserTaskId: input.browserTaskId,
      runId: input.runId,
      action: input.action,
      requestFingerprint,
      promise: work,
    })
    if (dispatches.size > 1_024) {
      const oldest = dispatches.keys().next().value as string | undefined
      if (oldest && oldest !== actionId) dispatches.delete(oldest)
    }
    return work
  }

  async function stop(): Promise<ComputerStopAck> {
    safetyEpoch += 1
    acknowledgementChallenges.clear()
    currentObservation = null
    // Stop is a durable boundary for the current model run. Keep the user's
    // selected target visible, but revoke its lineage claim immediately so a
    // later tool call in the same continuing run cannot restart input. A new
    // visible user send may explicitly authorize the selected target again.
    if (binding) binding.claim = null
    if (active) {
      active.cancelReason = 'stopped'
      active.abort.abort(new ComputerCancelledError('stopped'))
      fireAndForget(deps.backend.cancel(active.attemptId))
    }
    await beginBackendStop()
    return {
      acknowledged: true,
      targetAckMs: STOP_ACK_TARGET_MS,
      realTimeGuaranteed: false,
    }
  }

  async function cancelRun(browserTaskId: string, runId: string): Promise<void> {
    const key = lineageKey(browserTaskId, runId)
    runCancelEpochs.set(key, (runCancelEpochs.get(key) ?? 0) + 1)
    deps.testOnlyOnRunCancelEpochCount?.(runCancelEpochs.size)
    const ownsClaim = binding?.claim?.browserTaskId === browserTaskId
      && binding.claim.runId === runId
    try {
      if (ownsClaim && binding) {
        // ai:stop can arrive while the provider is still thinking, before a
        // computer tool has installed its own AbortSignal listener. Revoke the
        // exact pre-model lineage synchronously so a late model tool cannot
        // restart work with a freshly sampled cancel epoch.
        safetyEpoch += 1
        binding.claim = null
      }
      if (currentObservation?.public.browserTaskId === browserTaskId
        && currentObservation.public.runId === runId) {
        currentObservation = null
      }
      if (active?.browserTaskId === browserTaskId && active.runId === runId) {
        active.cancelReason = 'run-cancelled'
        active.abort.abort(new ComputerCancelledError('run-cancelled'))
        if (ownsClaim) fireAndForget(deps.backend.cancel(active.attemptId))
        else await deps.backend.cancel(active.attemptId)
      }
      // Only the selected owner may close the helper's single input queue. A
      // foreign/stale lineage remains scoped to its epoch and cannot disturb the
      // current owner. stop() provides the bounded helper ACK.
      if (ownsClaim) {
        await beginBackendStop()
      }
    } finally {
      cleanupRunCancelEpoch(key)
      if (runCancelEpochs.has(key)) {
        const queuedAtCancel = queueTail
        void queuedAtCancel.then(
          () => cleanupRunCancelEpoch(key),
          () => cleanupRunCancelEpoch(key),
        )
      }
    }
  }

  function prepareUncertainAcknowledgement(): ComputerUncertainAcknowledgementChallenge | null {
    pruneAcknowledgementChallenges()
    const current = binding
    if (!current || active || stopAcksInFlight > 0) return null
    if (current.claim && now() >= current.claim.expiresAt) {
      invalidateExpiredBinding(current)
      return null
    }
    const lookupTaskId = current.claim?.browserTaskId ?? current.uncertain?.browserTaskId ?? ''
    refreshDurableUncertainty(current, lookupTaskId)
    if (current.uncertainLookupFailed) return null
    const pending = current.uncertain
    if (!pending
      || pending.status !== 'uncertain'
      || pending.targetFingerprint !== current.targetFingerprint
      || pending.titleFingerprint !== current.titleFingerprint) return null

    const challenge = randomUUID()
    acknowledgementChallenges.set(challenge, {
      binding: current,
      bindingGeneration: current.generation,
      browserTaskId: pending.browserTaskId,
      actionId: pending.actionId,
      targetFingerprint: current.targetFingerprint,
      title: current.title,
      titleFingerprint: current.titleFingerprint,
      safetyEpoch,
      expiresAt: now() + ACKNOWLEDGEMENT_CHALLENGE_TTL_MS,
    })
    while (acknowledgementChallenges.size > MAX_ACKNOWLEDGEMENT_CHALLENGES) {
      const oldest = acknowledgementChallenges.keys().next().value as string | undefined
      if (!oldest) break
      acknowledgementChallenges.delete(oldest)
    }
    return {
      challenge,
      bindingGeneration: current.generation,
      processName: current.processName,
      title: current.title,
    }
  }

  async function acknowledgePreparedUncertain(challenge: string): Promise<boolean> {
    const prepared = acknowledgementChallenges.get(challenge)
    // One-shot even on a failed probe or stale binding. A human decision must
    // never become reusable authority for a later target.
    acknowledgementChallenges.delete(challenge)
    if (!prepared || now() > prepared.expiresAt) return false
    const current = binding
    if (!current
      || current !== prepared.binding
      || current.generation !== prepared.bindingGeneration
      || current.targetFingerprint !== prepared.targetFingerprint
      || current.title !== prepared.title
      || current.titleFingerprint !== prepared.titleFingerprint
      || safetyEpoch !== prepared.safetyEpoch
      || active
      || stopAcksInFlight > 0) return false
    if (current.claim && now() >= current.claim.expiresAt) {
      invalidateExpiredBinding(current)
      return false
    }
    refreshDurableUncertainty(current, prepared.browserTaskId)
    if (current.uncertainLookupFailed) return false
    const pending = current.uncertain
    if (!pending
      || pending.actionId !== prepared.actionId
      || pending.status !== 'uncertain'
      || pending.targetFingerprint !== prepared.targetFingerprint
      || pending.titleFingerprint !== prepared.titleFingerprint) return false

    let liveProbe: ComputerProbe
    try {
      liveProbe = normalizeProbe(await deps.backend.probeBinding(current.identity))
      assertSafeProbe(liveProbe)
      if (!sameIdentity(current.identity, liveProbe.identity)) return false
      if (liveProbe.title !== prepared.title
        || liveProbe.titleFingerprint !== prepared.titleFingerprint) return false
    } catch {
      return false
    }
    if (binding !== current
      || current.generation !== prepared.bindingGeneration
      || safetyEpoch !== prepared.safetyEpoch
      || active
      || stopAcksInFlight > 0) return false
    refreshDurableUncertainty(current, prepared.browserTaskId)
    if (current.uncertainLookupFailed) return false
    const refreshed = current.uncertain
    if (!refreshed
      || refreshed.actionId !== pending.actionId
      || refreshed.status !== 'uncertain'
      || refreshed.targetFingerprint !== current.targetFingerprint
      || refreshed.titleFingerprint !== prepared.titleFingerprint) return false

    try {
      if (!deps.storage.acknowledgeComputerEffect(refreshed.actionId)) return false
    } catch {
      current.uncertainLookupFailed = true
      currentObservation = null
      return false
    }
    // An acknowledgement is not a continuation grant. The next effect needs a
    // new visible send (authorization) and an independent fresh observation.
    current.claim = null
    currentObservation = null
    current.uncertain = null
    refreshDurableUncertainty(current, refreshed.browserTaskId)
    return true
  }

  /** Незакрытая отметка прошлого прогона не должна запирать СЛЕДУЮЩУЮ задачу
   *  человека. Новая команда в чате — это и есть его присутствие; делаем ровно
   *  то же, что делает кнопка «Я проверил результат»: живьём убеждаемся, что
   *  окно то же самое, закрываем сверку отдельной причиной в журнале и сбрасываем
   *  наблюдение, чтобы следующий шаг обязан был увидеть фактическое состояние.
   *  Что НЕ снимается автоматически: действие, числящееся выполняющимся прямо
   *  сейчас, и нечитаемый журнал — там исход ещё не решён и решать его нечем. */
  async function settleStaleUncertaintyForNewRequest(
    browserTaskId: string,
  ): Promise<'settled' | 'nothing-to-settle' | 'blocked'> {
    const current = binding
    if (!current || active || stopAcksInFlight > 0) return 'blocked'
    refreshDurableUncertainty(current, browserTaskId)
    if (current.uncertainLookupFailed) return 'blocked'
    const pending = current.uncertain
    if (!pending) return 'nothing-to-settle'
    if (pending.status !== 'uncertain') return 'blocked'
    if (pending.targetFingerprint !== current.targetFingerprint) return 'blocked'

    try {
      const probe = normalizeProbe(await deps.backend.probeBinding(current.identity))
      assertSafeProbe(probe)
      if (!sameIdentity(current.identity, probe.identity)) return 'blocked'
    } catch {
      return 'blocked'
    }
    if (binding !== current || active || stopAcksInFlight > 0) return 'blocked'

    try {
      if (!deps.storage.settleComputerEffectForNewRequest(pending.actionId)) return 'blocked'
    } catch {
      current.uncertainLookupFailed = true
      currentObservation = null
      return 'blocked'
    }
    currentObservation = null
    current.uncertain = null
    refreshDurableUncertainty(current, browserTaskId)
    return !current.uncertainLookupFailed && current.uncertain == null ? 'settled' : 'blocked'
  }

  /** Снятие отметки и выдача capability идут одной операцией, чтобы прогон,
   *  начатый поверх неизвестного исхода, всегда нёс об этом пометку наружу. */
  async function settleThenAuthorizeRun(
    input: { browserTaskId: string; runId: string },
  ): Promise<ComputerRunAuthorizationResult> {
    const settlement = await settleStaleUncertaintyForNewRequest(input.browserTaskId)
    const authorization = authorizeRun(input)
    return authorization.ok && settlement === 'settled'
      ? { ...authorization, settledStaleUncertainty: true }
      : authorization
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    await stop()
    unsubscribe()
    await queueTail
    runCancelEpochs.clear()
    pendingDispatchesByLineage.clear()
    acknowledgementChallenges.clear()
    deps.testOnlyOnRunCancelEpochCount?.(0)
    await deps.backend.shutdown()
  }

  function finalize(
    actionId: string,
    browserTaskId: string,
    status: 'verified' | 'uncertain' | 'failed',
    reason: string,
    attemptId: string,
  ): void {
    deps.storage.finalizeAction(actionId, status, {
      resultStatus: reason,
      resultDetail: publicDetail(status, reason),
      attemptId,
    })
    deps.storage.updateLastResult(browserTaskId, status, reason)
  }

  function finalizeBlocked(
    actionId: string,
    browserTaskId: string,
    reason: ComputerSafetyCode,
    attemptId?: string,
  ): ComputerDispatchResult {
    deps.storage.finalizeAction(actionId, 'blocked', {
      resultStatus: reason,
      resultDetail: publicDetail('blocked', reason),
      attemptId: attemptId ?? null,
    })
    deps.storage.updateLastResult(browserTaskId, 'blocked', reason)
    return plainResult(actionId, 'blocked', reason)
  }

  async function executeReadOnlyAction(
    input: ComputerDispatchInput & { actionId: string },
  ): Promise<ComputerDispatchResult> {
    const { actionId, browserTaskId, runId } = input
    const attemptId = `${actionId}:${randomUUID()}`
    const attempt: ActiveAttempt = {
      actionId,
      attemptId,
      browserTaskId,
      runId,
      abort: new AbortController(),
      commitTransferred: false,
      cancelReason: null,
    }
    active = attempt
    deps.storage.startExecute(actionId, attemptId)
    try {
      throwIfAborted(attempt)
      const observation = input.action === 'wait_for'
        ? await waitFor(input, browserTaskId, runId, attempt)
        : await captureObservation(browserTaskId, runId, false, attempt)
      throwIfAborted(attempt)
      const reason = input.action === 'wait_for' ? 'condition-observed' : 'readback-verified'
      finalize(actionId, browserTaskId, 'verified', reason, attemptId)
      return result(actionId, 'verified', reason, observation)
    } catch (error) {
      const reason = attempt.cancelReason ?? computerErrorCode(error, 'readback-failed')
      if (attempt.abort.signal.aborted || attempt.cancelReason) {
        currentObservation = null
        deps.storage.cancelAction(actionId, reason)
        deps.storage.updateLastResult(browserTaskId, 'cancelled', reason)
        return plainResult(actionId, 'cancelled', reason)
      }
      finalize(actionId, browserTaskId, 'failed', reason, attemptId)
      return plainResult(actionId, 'failed', reason)
    } finally {
      if (active === attempt) active = null
    }
  }

  async function execute(
    requestedInput: ComputerDispatchInput & { actionId: string },
    scheduledSafetyEpoch: number,
    scheduledRunCancelEpoch: number,
  ): Promise<ComputerDispatchResult> {
    const { actionId, browserTaskId, runId } = requestedInput
    const task = deps.storage.get(browserTaskId)
    const run = deps.storage.currentRun(browserTaskId)
    if (!task || task.endedAt != null || !run || run.runId !== runId || task.currentRunId !== runId) {
      return plainResult(actionId, 'blocked', 'inactive-run')
    }
    if (scheduledRunCancelEpoch !== runCancelEpoch(browserTaskId, runId)) {
      return plainResult(actionId, 'cancelled', 'run-cancelled')
    }
    if (scheduledSafetyEpoch !== safetyEpoch) {
      return plainResult(actionId, 'cancelled', 'hardware-input')
    }
    const invalidRouting = invalidRoutingReason(requestedInput)
    if (invalidRouting) return plainResult(actionId, 'blocked', invalidRouting)
    let actionBinding: InternalBinding
    try {
      actionBinding = bindingForLineage(browserTaskId, runId)
    } catch (error) {
      return plainResult(actionId, 'blocked', computerErrorCode(error, 'no-binding'))
    }
    refreshDurableUncertainty(actionBinding, browserTaskId)

    if (hasSecretInput(requestedInput)) {
      return plainResult(actionId, 'blocked', 'secret-input')
    }

    let input = requestedInput
    let snapshot = currentObservation
    if (requiresElement(input.action)
      && actionBinding.source === 'automatic'
      && snapshot
      && input.observationId === snapshot.public.observationId
      && snapshot.public.browserTaskId === browserTaskId
      && snapshot.public.runId === runId
      && snapshot.public.bindingGeneration === actionBinding.generation
      && observationExpired(snapshot.public.capturedAt, now(), maxSnapshotAgeMs)) {
      const oldElement = resolveElement(input, snapshot)
      if (oldElement) {
        try {
          await captureObservation(browserTaskId, runId)
          const refreshed = currentObservation
          if (!refreshed) throw new ComputerSafetyError('stale-observation')
          assertProbeMatches(snapshot.probe, refreshed.probe)
          const matching = [...refreshed.elements.entries()].filter(([, candidate]) => (
            sameElementForAutomaticRenewal(oldElement.backend, candidate.backend)
          ))
          if (matching.length !== 1) throw new ComputerSafetyError('stale-observation')
          const [elementRef] = matching[0]!
          input = {
            ...input,
            observationId: refreshed.public.observationId,
            elementRef,
          }
          snapshot = refreshed
        } catch (error) {
          currentObservation = null
          return plainResult(actionId, 'blocked', computerErrorCode(error, 'stale-observation'))
        }
      }
    }
    let element: InternalElement | null = null

    if (input.action === 'observe') {
      if (input.observationId !== undefined || input.elementRef !== undefined || input.waitFor !== undefined) {
        return plainResult(actionId, 'blocked', 'invalid-action')
      }
    } else if (input.action === 'wait_for') {
      if (input.observationId !== undefined || input.elementRef !== undefined
        || typeof input.waitFor?.text !== 'string' || input.waitFor.text.trim().length === 0) {
        return plainResult(actionId, 'blocked', 'invalid-action')
      }
      const waitElementRef = input.waitFor.elementRef
      if (waitElementRef) {
        if (!snapshot || snapshot.public.browserTaskId !== browserTaskId || snapshot.public.runId !== runId) {
          return plainResult(actionId, 'blocked', 'stale-observation')
        }
        if (snapshot.public.bindingGeneration !== actionBinding.generation) {
          return plainResult(actionId, 'blocked', 'stale-binding-generation')
        }
        if (!freshObservation(snapshot.public.capturedAt, now(), maxSnapshotAgeMs)) {
          return plainResult(actionId, 'blocked', 'stale-observation')
        }
        if (!snapshot.elements.has(waitElementRef)) {
          return plainResult(actionId, 'blocked', 'invalid-element-ref')
        }
      }
    } else {
      if (actionBinding.uncertain || actionBinding.uncertainLookupFailed) {
        return plainResult(actionId, 'blocked', 'uncertain-reconciliation-required')
      }
      if (!snapshot || !input.observationId || snapshot.public.observationId !== input.observationId) {
        return plainResult(actionId, 'blocked', 'stale-observation')
      }
      if (snapshot.public.browserTaskId !== browserTaskId || snapshot.public.runId !== runId) {
        return plainResult(actionId, 'blocked', 'stale-observation')
      }
      if (snapshot.public.bindingGeneration !== actionBinding.generation) {
        return plainResult(actionId, 'blocked', 'stale-binding-generation')
      }
      if (!freshObservation(snapshot.public.capturedAt, now(), maxSnapshotAgeMs)) {
        return plainResult(actionId, 'blocked', 'stale-observation')
      }

      element = resolveElement(input, snapshot)
      if (requiresElement(input.action) && !element) {
        return plainResult(actionId, 'blocked', 'invalid-element-ref')
      }
      if (input.action === 'key' && (!input.key || !KEY_ALLOWLIST.has(input.key))) {
        return plainResult(actionId, 'blocked', 'invalid-key')
      }
      if (input.action === 'scroll') {
        const deltaX = discreteScrollDelta(input.deltaX)
        const deltaY = discreteScrollDelta(input.deltaY)
        if (deltaX == null || deltaY == null || (deltaX === 0 && deltaY === 0)) {
          return plainResult(actionId, 'blocked', 'invalid-action')
        }
      }
      if (input.action === 'type' && (
        typeof input.text !== 'string'
        || Array.from(input.text).length === 0
        || input.clearFirst !== undefined
      )) return plainResult(actionId, 'blocked', 'invalid-action')
      if (input.action === 'type' && !validValueState(element?.backend.valueState)) {
        return plainResult(actionId, 'blocked', 'invalid-action')
      }
      if (input.action === 'scroll'
        && element?.backend.supportedActions.includes('scroll')
        && !validScrollState(element.backend.scrollState)) {
        return plainResult(actionId, 'blocked', 'invalid-action')
      }
    }

    const durablePayload = projectDurablePayload(input)
    const durableScope: Record<string, unknown> = {
      targetType: 'windows',
      bindingGeneration: actionBinding.generation,
      targetFingerprint: actionBinding.targetFingerprint,
      titleFingerprint: actionBinding.titleFingerprint,
      observationId: input.observationId ?? null,
    }
    deps.storage.proposeAction({
      actionId,
      browserTaskId,
      runId,
      actionType: `computer:${input.action}`,
      riskLevel: riskFor(input.action),
      scope: durableScope,
      payload: durablePayload,
      preconditions: {
        bindingGeneration: actionBinding.generation,
        targetFingerprint: actionBinding.targetFingerprint,
        titleFingerprint: actionBinding.titleFingerprint,
        observationId: input.observationId ?? null,
        observationCapturedAt: snapshot?.public.capturedAt ?? null,
        observationExpiresAt: snapshot ? snapshot.public.capturedAt + maxSnapshotAgeMs : null,
      },
      expectedPostcondition: { independentReadback: true },
    })

    if (input.action === 'observe' || input.action === 'wait_for') {
      return executeReadOnlyAction(input)
    }
    if (!snapshot) {
      return finalizeBlocked(actionId, browserTaskId, 'stale-observation')
    }
    if (element && classifyResponsibleComputerTarget({
      role: element.backend.role,
      label: element.backend.label,
      state: element.backend.state,
    }).responsible) {
      return finalizeBlocked(actionId, browserTaskId, 'responsible-action-confirmation-required')
    }
    const expectedElementTransition = input.action === 'click' && element
      ? expectedClickTransition(element.backend.state)
      : undefined
    if (input.action === 'click'
      && element?.backend.supportedActions.includes('click')
      && isStatefulClickState(element.backend.state)
      && !expectedElementTransition) {
      return finalizeBlocked(actionId, browserTaskId, 'invalid-action')
    }
    if (!allowUnverifiedGlobalInput && requiresUnverifiedGlobalInput(input.action, element)) {
      return finalizeBlocked(actionId, browserTaskId, 'global-input-not-accepted')
    }

    const attemptId = `${actionId}:${randomUUID()}`
    const attempt: ActiveAttempt = {
      actionId,
      attemptId,
      browserTaskId,
      runId,
      abort: new AbortController(),
      commitTransferred: false,
      cancelReason: null,
    }
    active = attempt

    try {
      let liveProbe = normalizeProbe(await deps.backend.probeBinding(actionBinding.identity))
      assertBindingClaim(actionBinding, browserTaskId, runId)
      assertFreshObservation(snapshot.public.capturedAt)
      assertProbeMatches(snapshot.probe, liveProbe)
      assertBinding(actionBinding, liveProbe)
      assertFallbackSafety(input.action, element, liveProbe)
      throwIfAborted(attempt)

      const chunks = input.action === 'type' ? chunkText(input.text ?? '') : undefined
      const exactElementCoordinateClick = acceptsExactElementCoordinateClick(input.action, element)
      // UI Automation exposes no generic keyboard pattern. A key is scoped by
      // its resolved element, then delivered to the exact foreground HWND.
      const uiaRequired = input.action !== 'key'
        && !!element?.backend.supportedActions.includes(input.action)
        && !exactElementCoordinateClick
      const prepareRequest: ComputerPrepareRequest = {
        attemptId,
        identity: cloneIdentity(actionBinding.identity),
        action: prepareActionDescriptor(input),
        ...(element ? {
          resolvedElement: {
            backendRef: element.backend.backendRef,
            ...(element.backend.bounds ? { bounds: { ...element.backend.bounds } } : {}),
            ...(expectedElementTransition
              ? { expectedTransition: { ...expectedElementTransition } }
              : {}),
            ...(input.action === 'type' && element.backend.valueState
              ? { expectedValueState: { ...element.backend.valueState } }
              : {}),
            ...(input.action === 'scroll' && element.backend.scrollState
              ? { expectedScrollState: { ...element.backend.scrollState } }
              : {}),
          },
          ...(element.backend.bounds ? { fallbackPoint: center(element.backend.bounds) } : {}),
        } : {}),
        ...(chunks ? { textChunks: chunks } : {}),
        uiaRequired,
        expected: {
          title: snapshot.probe.title,
          titleFingerprint: snapshot.probe.titleFingerprint,
          geometry: { ...snapshot.probe.geometry },
          dpi: snapshot.probe.dpi,
          foreground: true,
          screenLocked: false,
          userInputEpoch: snapshot.probe.userInputEpoch,
        },
        signal: attempt.abort.signal,
      }

      const prepared = await withTimeout(
        deps.backend.prepareAction(prepareRequest),
        prepareTimeoutMs,
        () => attempt.abort.abort(new ComputerSafetyError('prepare-timeout')),
        'prepare-timeout',
      )
      throwIfAborted(attempt)
      assertBindingClaim(actionBinding, browserTaskId, runId)
      assertFreshObservation(snapshot.public.capturedAt)
      if (prepared.attemptId !== attemptId || !sameIdentity(prepared.identity, actionBinding.identity)) {
        throw new ComputerSafetyError('target-identity-changed')
      }
      if (uiaRequired && prepared.method !== 'uia') {
        throw new ComputerSafetyError('uia-priority-violated')
      }
      assertPreparedMethod(input.action, prepared.method, element)
      if (prepared.method !== 'uia' && !allowUnverifiedGlobalInput
        && !(exactElementCoordinateClick && prepared.method === 'coordinates')) {
        throw new ComputerSafetyError('global-input-not-accepted')
      }
      if (input.action === 'type') {
        const expectedAfterLength = element!.backend.valueState!.scalarLength + Array.from(input.text!).length
        if (!validValueState(prepared.expectedAfterValueState)
          || !Number.isSafeInteger(expectedAfterLength)
          || prepared.expectedAfterValueState.scalarLength !== expectedAfterLength) {
          throw new ComputerSafetyError('invalid-action')
        }
      }
      if (!uiaRequired && isPointerFallback(input.action, prepared.method)) {
        assertCoordinateFallback(liveProbe, prepared.requiresHitTest)
      }
      if (chunks && chunks.length > 1 && (
        prepared.chunkGuards !== 'backend-enforced'
        ||
        prepared.targetCheckIntervalMs == null
        || prepared.targetCheckIntervalMs <= 0
        || prepared.targetCheckIntervalMs > CHUNK_CHECK_TARGET_MS
      )) {
        throw new ComputerSafetyError('invalid-action')
      }

      // The prepare phase is guaranteed effect-free. Re-probe immediately
      // before the durable `executing` transition and commit transfer.
      liveProbe = normalizeProbe(await deps.backend.probeBinding(actionBinding.identity))
      assertBindingClaim(actionBinding, browserTaskId, runId)
      assertFreshObservation(snapshot.public.capturedAt)
      assertProbeMatches(snapshot.probe, liveProbe)
      assertBinding(actionBinding, liveProbe)
      if (!uiaRequired && isPointerFallback(input.action, prepared.method)) {
        assertCoordinateFallback(liveProbe, prepared.requiresHitTest)
      }
      throwIfAborted(attempt)

      deps.storage.startExecute(actionId, attemptId)
      if (deps.storage.getAction(actionId)?.status !== 'executing') {
        throw new ComputerSafetyError('invalid-action')
      }

      const commit = await withTimeout(
        deps.backend.commitAction(prepared, {
          signal: attempt.abort.signal,
          onTransferred() {
            attempt.commitTransferred = true
          },
        }),
        input.timeoutMs ?? commitTimeoutMs,
        () => {
          attempt.cancelReason = 'commit-timeout'
          attempt.abort.abort(new ComputerSafetyError('commit-timeout'))
          fireAndForget(deps.backend.cancel(attemptId))
        },
        'commit-timeout',
      )

      if (!attempt.commitTransferred) {
        throw new ComputerSafetyError('transport-lost')
      }
      throwIfAborted(attempt)
      if ((commit.attemptId != null && commit.attemptId !== attemptId) || !commit.readback?.matched) {
        throw new ComputerSafetyError('readback-mismatch')
      }
      if (commit.readback.dispatchAccepted !== true) {
        throw new ComputerSafetyError('dispatch-not-accepted')
      }
      if (commit.readback.effectMatched !== true) {
        throw new ComputerSafetyError('effect-not-proven')
      }
      const postUserInputEpoch = commit.readback.postUserInputEpoch
      if (postUserInputEpoch != null
        && (!Number.isSafeInteger(postUserInputEpoch) || postUserInputEpoch < 0)) {
        throw new ComputerSafetyError('readback-mismatch')
      }
      if (prepared.method !== 'uia' && postUserInputEpoch == null) {
        throw new ComputerSafetyError('readback-mismatch')
      }

      let postObservation: ComputerObservation
      try {
        // A verified action can legitimately change the same window's title
        // (for example Notepad adds `*`). Adopt it only after the helper proved
        // dispatch + effect; every pre-effect boundary above remains pinned.
        postObservation = await captureObservation(browserTaskId, runId, true, attempt)
      } catch {
        throw new ComputerSafetyError('readback-failed')
      }
      const expectedPostInputEpoch = postUserInputEpoch ?? snapshot.probe.userInputEpoch
      assertPostActionObservation(postObservation)

      // A native control may expose a requested state for one UIA read and
      // immediately roll it back while an async handler finishes. One such
      // snapshot is not a stable postcondition. Wait a short, abort-aware
      // quiet period, then require a second independent observation to agree
      // on the exact window state and the semantic effect.
      await delayWithAbort(postconditionSettleMs, attempt)
      let settledObservation: ComputerObservation
      try {
        settledObservation = await captureObservation(browserTaskId, runId, false, attempt)
      } catch (error) {
        if (attempt.abort.signal.aborted) throw error
        throw new ComputerSafetyError('readback-failed')
      }
      assertStablePostObservation(postObservation, settledObservation)
      assertPostActionObservation(settledObservation)
      postObservation = settledObservation
      throwIfAborted(attempt)
      finalize(actionId, browserTaskId, 'verified', 'independent-readback-verified', attemptId)
      return result(
        actionId,
        'verified',
        'independent-readback-verified',
        input.action === 'type' ? omitTypedContent(postObservation) : postObservation,
      )

      function assertPostActionObservation(observation: ComputerObservation): void {
        if (observation.userInputEpoch !== expectedPostInputEpoch) {
          throw new ComputerSafetyError('hardware-input')
        }
        if (!observation.foreground) throw new ComputerSafetyError('focus-lost')
        if (observation.screenLocked) throw new ComputerSafetyError('screen-locked')
        if (expectedElementTransition && element
          && !postObservationMatchesTransition(
            currentObservation,
            element.backend.semanticFingerprint,
            expectedElementTransition,
          )) {
          throw new ComputerSafetyError('readback-mismatch')
        }
        if (input.action === 'scroll' && element?.backend.scrollState
          && !postObservationMatchesScroll(
            currentObservation,
            element.backend.semanticFingerprint,
            element.backend.scrollState,
            finite(input.deltaX),
            finite(input.deltaY),
          )) {
          throw new ComputerSafetyError('readback-mismatch')
        }
        if (input.action === 'type' && element && prepared.expectedAfterValueState
          && !postObservationMatchesValueState(
            currentObservation,
            element.backend.semanticFingerprint,
            prepared.expectedAfterValueState,
          )) {
          throw new ComputerSafetyError('readback-mismatch')
        }
      }
    } catch (error) {
      const reason = attempt.cancelReason ?? computerErrorCode(error, 'transport-lost')
      if (attempt.commitTransferred) {
        currentObservation = null
        if (binding === actionBinding) {
          actionBinding.uncertain = {
            browserTaskId,
            runId,
            actionId,
            reason,
            targetFingerprint: actionBinding.targetFingerprint,
            titleFingerprint: actionBinding.titleFingerprint,
            status: 'uncertain',
          }
        }
        finalize(actionId, browserTaskId, 'uncertain', reason, attemptId)
        return plainResult(actionId, 'uncertain', reason)
      }
      if (attempt.abort.signal.aborted || attempt.cancelReason) {
        deps.storage.cancelAction(actionId, reason)
        deps.storage.updateLastResult(browserTaskId, 'cancelled', reason)
        return plainResult(actionId, 'cancelled', reason)
      }
      if (error instanceof ComputerSafetyError && isBlockingSafetyCode(reason)) {
        return finalizeBlocked(actionId, browserTaskId, reason, attemptId)
      }
      finalize(actionId, browserTaskId, 'failed', reason, attemptId)
      return plainResult(actionId, 'failed', reason)
    } finally {
      if (active === attempt) active = null
    }
  }

  async function captureObservation(
    browserTaskId: string,
    runId: string,
    acceptVerifiedPostActionTitle = false,
    attempt?: ActiveAttempt,
  ): Promise<ComputerObservation> {
    const task = deps.storage.get(browserTaskId)
    const run = deps.storage.currentRun(browserTaskId)
    if (!task || task.currentRunId !== runId || !run || run.runId !== runId) {
      throw new ComputerSafetyError('inactive-run')
    }
    const actionBinding = bindingForLineage(browserTaskId, runId)
    const raw = await deps.backend.observe(actionBinding.identity)
    if (attempt) throwIfAborted(attempt)
    const observationProbe = normalizeProbe(raw.probe)
    assertSafeProbe(observationProbe)
    if (!sameIdentity(actionBinding.identity, observationProbe.identity)) {
      throw new ComputerSafetyError('target-identity-changed')
    }
    if (!acceptVerifiedPostActionTitle
      && (actionBinding.title !== observationProbe.title
        || actionBinding.titleFingerprint !== observationProbe.titleFingerprint)) {
      throw new ComputerSafetyError('target-title-changed')
    }
    assertBindingClaim(actionBinding, browserTaskId, runId)
    if (attempt) throwIfAborted(attempt)
    if (acceptVerifiedPostActionTitle) {
      actionBinding.title = observationProbe.title
      actionBinding.titleFingerprint = observationProbe.titleFingerprint
    }

    const observationId = `wo-${randomUUID()}`
    const observationVersion = task.observationVersion + 1
    const elements = new Map<string, InternalElement>()
    let passwordSurface = false
    let credentialSurface = false
    for (const backendElement of raw.elements) {
      if (!/^[a-f0-9]{64}$/.test(backendElement.semanticFingerprint)) {
        throw new ComputerSafetyError('invalid-target-identity')
      }
      if (backendElement.valueState !== undefined && !validValueState(backendElement.valueState)) {
        throw new ComputerSafetyError('invalid-target-identity')
      }
      if (backendElement.scrollState !== undefined && !validScrollState(backendElement.scrollState)) {
        throw new ComputerSafetyError('invalid-target-identity')
      }
      if (backendElement.isPassword) {
        passwordSurface = true
        continue
      }
      if (isCredentialElement(backendElement)) {
        credentialSurface = true
        continue
      }
      const elementRef = `we-${randomUUID()}`
      const publicElement: ComputerObservedElement = {
        elementRef,
        role: backendElement.role,
        label: backendElement.label,
        ...(backendElement.state ? { state: backendElement.state } : {}),
        ...(backendElement.bounds ? { bounds: { ...backendElement.bounds } } : {}),
        supportedActions: [...backendElement.supportedActions],
      }
      elements.set(elementRef, { public: publicElement, backend: cloneBackendElement(backendElement) })
    }
    const omissions = [...raw.omissions]
    if (passwordSurface) omissions.push('password-surface')
    if (credentialSurface) omissions.push('credential-surface')
    const publicObservation: ComputerObservation = {
      observationId,
      observationVersion,
      capturedAt: now(),
      browserTaskId,
      runId,
      bindingGeneration: actionBinding.generation,
      targetFingerprint: actionBinding.targetFingerprint,
      processName: actionBinding.processName,
      title: observationProbe.title,
      geometry: { ...observationProbe.geometry },
      dpi: observationProbe.dpi,
      foreground: observationProbe.foreground,
      screenLocked: observationProbe.screenLocked,
      userInputEpoch: observationProbe.userInputEpoch,
      elements: [...elements.values()].map(element => element.public),
      text: passwordSurface || credentialSurface ? '' : raw.text ?? '',
      screenshotDataUrl: passwordSurface || credentialSurface ? null : raw.screenshotDataUrl ?? null,
      omissions,
    }
    currentObservation = { public: publicObservation, probe: cloneProbe(observationProbe), elements }
    deps.storage.updateObservation(browserTaskId, observationId, observationVersion)
    return publicObservation
  }

  async function waitFor(
    input: ComputerDispatchInput,
    browserTaskId: string,
    runId: string,
    attempt: ActiveAttempt,
  ): Promise<ComputerObservation> {
    const deadline = now() + Math.max(0, Math.min(input.timeoutMs ?? 1_000, 5_000))
    const wantedSemanticFingerprint = input.waitFor?.elementRef
      ? currentObservation?.elements.get(input.waitFor.elementRef)?.backend.semanticFingerprint
      : null
    do {
      throwIfAborted(attempt)
      const observation = await captureObservation(browserTaskId, runId, false, attempt)
      throwIfAborted(attempt)
      const wantedText = input.waitFor?.text
      const refMatched = !input.waitFor?.elementRef
        || (!!wantedSemanticFingerprint && [...(currentObservation?.elements.values() ?? [])]
          .some(element => element.backend.semanticFingerprint === wantedSemanticFingerprint))
      const textMatched = !wantedText || observation.text.includes(wantedText)
      if (refMatched && textMatched) return observation
      await delay(25)
      throwIfAborted(attempt)
    } while (now() <= deadline)
    throw new ComputerSafetyError('readback-mismatch')
  }

  function bindingForLineage(browserTaskId: string, runId: string): InternalBinding {
    const current = binding
    if (!current) throw new ComputerSafetyError('no-binding')
    if (!current.claim) throw new ComputerSafetyError('binding-not-authorized')
    assertBindingClaim(current, browserTaskId, runId)
    return current
  }

  function assertBindingClaim(
    expectedBinding: InternalBinding,
    browserTaskId: string,
    runId: string,
  ): void {
    if (binding !== expectedBinding) throw new ComputerSafetyError('stale-binding-generation')
    const claim = expectedBinding.claim
    if (!claim) throw new ComputerSafetyError('binding-not-authorized')
    if (claim && now() >= claim.expiresAt) {
      invalidateExpiredBinding(expectedBinding)
      throw new ComputerSafetyError('binding-expired')
    }
    if (claim && (claim.browserTaskId !== browserTaskId || claim.runId !== runId)) {
      throw new ComputerSafetyError('binding-owner-mismatch')
    }
  }

  function invalidateExpiredBinding(expectedBinding: InternalBinding): void {
    if (binding !== expectedBinding) return
    bindingGeneration += 1
    acknowledgementChallenges.clear()
    binding = null
    currentObservation = null
    candidates.clear()
    if (active) {
      active.cancelReason = 'binding-expired'
      active.abort.abort(new ComputerCancelledError('binding-expired'))
      fireAndForget(deps.backend.cancel(active.attemptId))
    }
    fireAndForget(deps.backend.stop())
  }

  function assertFreshObservation(capturedAt: number): void {
    if (!freshObservation(capturedAt, now(), maxSnapshotAgeMs)) {
      throw new ComputerSafetyError('stale-observation')
    }
  }

  function runCancelEpoch(browserTaskId: string, runId: string): number {
    return runCancelEpochs.get(lineageKey(browserTaskId, runId)) ?? 0
  }

  function pruneAcknowledgementChallenges(): void {
    const currentTime = now()
    for (const [challenge, prepared] of acknowledgementChallenges) {
      if (currentTime > prepared.expiresAt) acknowledgementChallenges.delete(challenge)
    }
  }

  return {
    listCandidates,
    bindCandidate,
    unbind,
    getBinding,
    authorizeRun,
    prepareAutomaticRun,
    observe,
    dispatch,
    cancelRun,
    prepareUncertainAcknowledgement,
    acknowledgePreparedUncertain,
    stop,
    shutdown,
  }
}

function projectDurablePayload(input: ComputerDispatchInput): Record<string, unknown> {
  switch (input.action) {
    case 'type': {
      const text = input.text ?? ''
      return {
        elementRef: input.elementRef ?? null,
        textLength: Array.from(text).length,
        clearFirst: !!input.clearFirst,
      }
    }
    case 'click':
      return { elementRef: input.elementRef ?? null }
    case 'key':
      return { elementRef: input.elementRef ?? null, key: input.key ?? null }
    case 'scroll':
      return { elementRef: input.elementRef ?? null, deltaX: finite(input.deltaX), deltaY: finite(input.deltaY) }
    case 'wait_for': {
      const text = input.waitFor?.text ?? ''
      return {
        elementRef: input.waitFor?.elementRef ?? null,
        textLength: Array.from(text).length,
      }
    }
    case 'observe':
      return {}
  }
}

/**
 * Exact request identity for one process lifetime. Private type/wait text is
 * mixed into this digest only in main-process memory; neither the text nor the
 * digest is written to the action ledger, hooks, telemetry, or checkpoints.
 */
function ephemeralRequestFingerprint(input: ComputerDispatchInput): string {
  const semantics: unknown[] = [input.action]
  switch (input.action) {
    case 'type':
      semantics.push(
        input.observationId ?? null,
        input.elementRef ?? null,
        typeof input.text === 'string' ? ['text', input.text] : ['missing-text'],
        !!input.clearFirst,
      )
      break
    case 'click':
      semantics.push(input.observationId ?? null, input.elementRef ?? null)
      break
    case 'key':
      semantics.push(input.observationId ?? null, input.elementRef ?? null, input.key ?? null)
      break
    case 'scroll':
      semantics.push(
        input.observationId ?? null,
        input.elementRef ?? null,
        finite(input.deltaX),
        finite(input.deltaY),
      )
      break
    case 'wait_for':
      semantics.push(
        input.waitFor?.elementRef ?? null,
        input.waitFor?.text ? ['text', input.waitFor.text] : ['no-text'],
        Math.max(0, Math.min(input.timeoutMs ?? 1_000, 5_000)),
      )
      break
    case 'observe':
      break
  }
  return createHash('sha256').update(JSON.stringify(semantics)).digest('hex')
}

/**
 * A restart loses the private in-memory request fingerprint. Reuse a durable
 * result only when every executed argument is represented exactly by the
 * non-secret ledger projection. Read observations and text-bearing actions
 * fail closed because their exact output/content is deliberately not stored.
 */
function matchesDurableReplay(row: BrowserActionRow, input: ComputerDispatchInput): boolean {
  if (input.action === 'observe' || input.action === 'wait_for' || input.action === 'type') return false
  if (row.scope.targetType !== 'windows'
    || typeof row.scope.bindingGeneration !== 'number'
    || !Number.isSafeInteger(row.scope.bindingGeneration)
    || typeof row.scope.targetFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.scope.targetFingerprint)
    || typeof row.scope.titleFingerprint !== 'string'
    || !validTitleFingerprint(row.scope.titleFingerprint)
    || row.scope.observationId !== (input.observationId ?? null)) {
    return false
  }
  return JSON.stringify(row.payload) === JSON.stringify(projectDurablePayload(input))
}

function prepareActionDescriptor(input: ComputerDispatchInput): ComputerPrepareRequest['action'] {
  switch (input.action) {
    case 'click': return { kind: 'click' }
    // Replacement/clear semantics are intentionally unavailable in R2. The
    // helper receives append-only ValuePattern input even if another caller
    // bypasses the model-facing tool adapter.
    case 'type': return { kind: 'type' }
    case 'key': return { kind: 'key', key: input.key! }
    case 'scroll': return { kind: 'scroll', deltaX: finite(input.deltaX), deltaY: finite(input.deltaY) }
    case 'observe':
    case 'wait_for':
      throw new ComputerSafetyError('invalid-action')
  }
}

function riskFor(action: ComputerAction): 'R0' | 'R1' | 'R3' {
  if (action === 'observe' || action === 'wait_for') return 'R0'
  if (action === 'type') return 'R3'
  return 'R1'
}

function resolveElement(input: ComputerDispatchInput, snapshot: InternalObservation): InternalElement | null {
  if (!input.elementRef) return null
  return snapshot.elements.get(input.elementRef) ?? null
}

function expectedClickTransition(state: string | undefined): ComputerExpectedElementTransition | undefined {
  switch (state) {
    case 'off': return { kind: 'toggle', before: 'off', after: 'on' }
    case 'on': return { kind: 'toggle', before: 'on', after: 'off' }
    case 'not-selected': return { kind: 'selection', before: 'not-selected', after: 'selected' }
    case undefined: return undefined
    default: return undefined
  }
}

function isStatefulClickState(state: string | undefined): boolean {
  return state === 'off'
    || state === 'on'
    || state === 'indeterminate'
    || state === 'not-selected'
    || state === 'selected'
}

function postObservationMatchesTransition(
  observation: InternalObservation | null,
  semanticFingerprint: string,
  transition: ComputerExpectedElementTransition,
): boolean {
  if (!observation) return false
  return [...observation.elements.values()].some(element => (
    element.backend.semanticFingerprint === semanticFingerprint
    && element.backend.state === transition.after
  ))
}

function postObservationMatchesScroll(
  observation: InternalObservation | null,
  semanticFingerprint: string,
  before: NonNullable<BackendObservedElement['scrollState']>,
  deltaX: number,
  deltaY: number,
): boolean {
  if (!observation) return false
  const after = [...observation.elements.values()].find(element => (
    element.backend.semanticFingerprint === semanticFingerprint
  ))?.backend.scrollState
  return !!after
    && scrollDirectionMatched(deltaX, before.horizontalPercent, after.horizontalPercent)
    && scrollDirectionMatched(deltaY, before.verticalPercent, after.verticalPercent)
}

function postObservationMatchesValueState(
  observation: InternalObservation | null,
  semanticFingerprint: string,
  expected: NonNullable<BackendObservedElement['valueState']>,
): boolean {
  if (!observation) return false
  const actual = [...observation.elements.values()].find(element => (
    element.backend.semanticFingerprint === semanticFingerprint
  ))?.backend.valueState
  return validValueState(actual)
    && actual.fingerprint === expected.fingerprint
    && actual.scalarLength === expected.scalarLength
}

function scrollDirectionMatched(delta: number, before: number, after: number): boolean {
  if (delta === 0) return after === before
  if (before < 0 || after < 0) return false
  return delta > 0 ? after > before : after < before
}

function requiresElement(action: ComputerAction): boolean {
  return action === 'click' || action === 'type' || action === 'key' || action === 'scroll'
}

function chunkText(text: string): string[] {
  const points = Array.from(text)
  const chunks: string[] = []
  for (let index = 0; index < points.length; index += TYPE_CHUNK_CODE_POINTS) {
    chunks.push(points.slice(index, index + TYPE_CHUNK_CODE_POINTS).join(''))
  }
  return chunks.length > 0 ? chunks : ['']
}

function assertBinding(binding: InternalBinding, probe: ComputerProbe): void {
  if (!sameIdentity(binding.identity, probe.identity)) {
    throw new ComputerSafetyError('target-identity-changed')
  }
  if (binding.title !== probe.title || binding.titleFingerprint !== probe.titleFingerprint) {
    throw new ComputerSafetyError('target-title-changed')
  }
  assertSafeProbe(probe)
}

function assertSafeProbe(probe: ComputerProbe): void {
  if (!validIdentity(probe.identity)) throw new ComputerSafetyError('invalid-target-identity')
  if (typeof probe.title !== 'string'
    || !probe.title
    || probe.title !== normalizeWindowTitle(probe.title)
    || !validTitleFingerprint(probe.titleFingerprint)
    || !validGeometry(probe.geometry)
    || !Number.isFinite(probe.dpi)
    || probe.dpi <= 0
    || !Number.isSafeInteger(probe.userInputEpoch)
    || probe.userInputEpoch < 0) {
    throw new ComputerSafetyError('invalid-target-identity')
  }
  if (probe.destroyed) throw new ComputerSafetyError('target-destroyed')
  if (probe.elevated) throw new ComputerSafetyError('elevated-target')
  if (probe.protectedProcess) throw new ComputerSafetyError('protected-target')
  if (probe.secureSurface) throw new ComputerSafetyError('secure-surface')
  if (probe.screenLocked) throw new ComputerSafetyError('screen-locked')
}

function assertProbeMatches(expected: ComputerProbe, actual: ComputerProbe): void {
  if (!sameIdentity(expected.identity, actual.identity)) throw new ComputerSafetyError('target-identity-changed')
  if (expected.title !== actual.title || expected.titleFingerprint !== actual.titleFingerprint) {
    throw new ComputerSafetyError('target-title-changed')
  }
  if (!sameGeometry(expected.geometry, actual.geometry)) throw new ComputerSafetyError('stale-geometry')
  if (expected.dpi !== actual.dpi) throw new ComputerSafetyError('stale-dpi')
  if (expected.userInputEpoch !== actual.userInputEpoch) throw new ComputerSafetyError('hardware-input')
  if (actual.screenLocked) throw new ComputerSafetyError('screen-locked')
  if (!actual.foreground) throw new ComputerSafetyError('focus-lost')
  assertSafeProbe(actual)
}

function assertFallbackSafety(
  action: Exclude<ComputerAction, 'observe' | 'wait_for'>,
  element: InternalElement | null,
  probe: ComputerProbe,
): void {
  const uia = !!element?.backend.supportedActions.includes(action)
  if (!uia && (action === 'click' || action === 'scroll')) assertCoordinateFallback(probe, true)
}

function requiresUnverifiedGlobalInput(
  action: Exclude<ComputerAction, 'observe' | 'wait_for'>,
  element: InternalElement | null,
): boolean {
  return action === 'key' || !element?.backend.supportedActions.includes(action)
}

function acceptsExactElementCoordinateClick(
  action: Exclude<ComputerAction, 'observe' | 'wait_for'>,
  element: InternalElement | null,
): boolean {
  return action === 'click'
    && !!element?.backend.bounds
    && element.backend.supportedActions.includes('click')
    && !isStatefulClickState(element.backend.state)
}

function assertCoordinateFallback(probe: ComputerProbe, requiresHitTest: boolean): void {
  if (!probe.foreground) throw new ComputerSafetyError('focus-lost')
  if (probe.occluded) throw new ComputerSafetyError('target-occluded')
  if (!requiresHitTest || !probe.hitTestOwnWindow) throw new ComputerSafetyError('hit-test-mismatch')
}

function assertPreparedMethod(
  action: Exclude<ComputerAction, 'observe' | 'wait_for'>,
  method: 'uia' | 'coordinates' | 'send-input',
  element: InternalElement | null,
): void {
  if (action === 'click' && method !== 'uia' && method !== 'coordinates') {
    throw new ComputerSafetyError('invalid-action')
  }
  if (action === 'type' && method !== 'uia' && method !== 'send-input') {
    throw new ComputerSafetyError('invalid-action')
  }
  if (action === 'key' && method !== 'send-input') {
    throw new ComputerSafetyError('invalid-action')
  }
  if (action === 'scroll' && method !== 'uia' && method !== 'send-input') {
    throw new ComputerSafetyError('invalid-action')
  }
  if (action === 'click' && method === 'coordinates' && !element?.backend.bounds) {
    throw new ComputerSafetyError('invalid-action')
  }
}

function isPointerFallback(
  action: Exclude<ComputerAction, 'observe' | 'wait_for'>,
  method: 'uia' | 'coordinates' | 'send-input',
): boolean {
  return (action === 'click' && method === 'coordinates')
    || (action === 'scroll' && method === 'send-input')
}

function throwIfAborted(attempt: ActiveAttempt): void {
  if (!attempt.abort.signal.aborted) return
  throw attempt.abort.signal.reason instanceof Error
    ? attempt.abort.signal.reason
    : new ComputerCancelledError(attempt.cancelReason ?? 'stopped')
}

function validIdentity(identity: ComputerIdentity): boolean {
  return Number.isSafeInteger(identity.pid)
    && identity.pid > 0
    && typeof identity.processStartTime100ns === 'string'
    && /^[0-9]+$/.test(identity.processStartTime100ns)
    && typeof identity.hwnd === 'string'
    && identity.hwnd.length > 0
}

function sameIdentity(left: ComputerIdentity, right: ComputerIdentity): boolean {
  return left.pid === right.pid
    && left.processStartTime100ns === right.processStartTime100ns
    && left.hwnd === right.hwnd
}

function sameGeometry(left: WindowGeometry, right: WindowGeometry): boolean {
  return left.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height
}

function validGeometry(geometry: WindowGeometry): boolean {
  return Number.isFinite(geometry.left)
    && Number.isFinite(geometry.top)
    && Number.isFinite(geometry.width)
    && Number.isFinite(geometry.height)
    && geometry.width > 0
    && geometry.height > 0
}

function identityFingerprint(identity: ComputerIdentity): string {
  return createHash('sha256')
    .update(`${identity.pid}\u0000${identity.processStartTime100ns}\u0000${identity.hwnd}`)
    .digest('hex')
}

function candidateBlockedReason(candidate: BackendCandidate): ComputerCandidate['blockedReason'] | undefined {
  if (candidate.elevated) return 'elevated'
  if (candidate.protectedProcess) return 'protected-process'
  if (candidate.secureSurface) return 'secure-surface'
  if (SECURITY_SETTINGS_PROCESS_NAMES.has(normalizeProcessName(candidate.processName))) return 'secure-surface'
  return undefined
}

function isBrowserApplication(candidate: BackendCandidate): boolean {
  const processName = normalizeProcessName(candidate.processName)
  if (BROWSER_PROCESS_NAMES.has(processName)) return true

  const className = normalizeApplicationMarker(candidate.topLevelClassName)
  if (BROWSER_WINDOW_CLASS_PREFIXES.some(prefix => className.startsWith(prefix))) return true

  const productName = normalizeApplicationMarker(candidate.productName)
  if (!productName) return false
  return productName.includes('browser')
    || productName.includes('браузер')
    || BROWSER_PRODUCT_MARKERS.some(marker => productName === marker || productName.startsWith(`${marker} `))
}

const SECURITY_SETTINGS_PROCESS_NAMES = new Set([
  'unknown',
  'systemsettings', 'systemsettingsadminflows', 'control', 'controlpanel',
  'mmc', 'secpol', 'sechealthui',
])

const BROWSER_PROCESS_NAMES = new Set([
  'chrome', 'chrome_proxy', 'google-chrome', 'msedge', 'msedgewebview2',
  'firefox', 'firefox-esr', 'brave', 'brave-browser', 'opera', 'opera_gx',
  'chromium', 'chromium-browser', 'vivaldi', 'waterfox', 'librewolf',
  'browser', 'yandex', 'yandexbrowser', 'yabrowser', 'arc', 'arc-browser',
  'duckduckgo', 'duckduckgobrowser', 'zen', 'zen-browser', 'floorp',
])

const BROWSER_WINDOW_CLASS_PREFIXES = [
  'chrome_widgetwin_', 'mozillawindowclass', 'operawindowclass',
] as const

const BROWSER_PRODUCT_MARKERS = [
  'google chrome', 'microsoft edge', 'mozilla firefox', 'brave', 'opera',
  'chromium', 'vivaldi', 'waterfox', 'librewolf', 'yandex', 'яндекс',
  'arc', 'duckduckgo', 'zen', 'floorp',
] as const

function normalizeProcessName(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/\.exe$/u, '')
}

function normalizeApplicationMarker(value: string | undefined): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLocaleLowerCase('ru-RU')
    : ''
}

const CREDENTIAL_CONTROL_MARKERS = [
  'api key', 'api-key', 'apikey', 'access token', 'client secret',
  'secret key', 'private key', 'authorization', 'api ключ', 'ключ api',
  'токен доступа', 'секрет', 'приватный ключ',
] as const

function isCredentialElement(element: BackendObservedElement): boolean {
  return containsCredentialMarker(`${element.role} ${element.label} ${element.state ?? ''}`)
}

function containsCredentialMarker(value: string): boolean {
  const marker = value.toLocaleLowerCase('ru-RU')
  return CREDENTIAL_CONTROL_MARKERS.some(candidate => marker.includes(candidate))
}

function hasSecretInput(input: ComputerDispatchInput): boolean {
  if (input.action !== 'type' && input.action !== 'wait_for') return false
  const text = input.action === 'type' ? input.text : input.waitFor?.text
  return typeof text === 'string' && scanText(text).hits.length > 0
}

function invalidRoutingReason(input: ComputerDispatchInput): ComputerSafetyCode | null {
  if (input.observationId !== undefined && !isComputerObservationRef(input.observationId)) {
    return 'stale-observation'
  }
  if (input.elementRef !== undefined && !isComputerElementRef(input.elementRef)) {
    return 'invalid-element-ref'
  }
  if (input.waitFor?.elementRef !== undefined && !isComputerElementRef(input.waitFor.elementRef)) {
    return 'invalid-element-ref'
  }
  return null
}

function eventReason(event: ComputerBackendEvent): ComputerSafetyCode {
  switch (event.type) {
    case 'hardware-input': return 'hardware-input'
    case 'focus-lost': return 'focus-lost'
    case 'screen-locked': return 'screen-locked'
    case 'target-destroyed': return 'target-destroyed'
    case 'helper-crashed': return 'helper-crashed'
  }
}

function isBlockingSafetyCode(code: ComputerSafetyCode): boolean {
  return code !== 'prepare-timeout'
    && code !== 'commit-timeout'
    && code !== 'transport-lost'
    && code !== 'readback-failed'
    && code !== 'readback-mismatch'
    && code !== 'stopped'
    && code !== 'helper-crashed'
}

function result(
  actionId: string,
  status: ComputerResultStatus,
  reason: string,
  observation?: ComputerObservation,
): ComputerDispatchResult {
  return {
    ok: status === 'verified',
    actionId,
    status,
    reason,
    detail: publicDetail(status, reason),
    ...(observation ? { observation } : {}),
  }
}

function plainResult(actionId: string, status: ComputerResultStatus, reason: string): ComputerDispatchResult {
  return result(actionId, status, reason)
}

function publicDetail(status: ComputerResultStatus, reason: string): string {
  if (status === 'verified') return 'Действие подтверждено независимым readback.'
  if (status === 'uncertain') return `Эффект не доказан (${reason}); автоматический повтор запрещён.`
  if (status === 'cancelled') return `Действие отменено до доказанного эффекта (${reason}).`
  if (status === 'blocked') return `Действие заблокировано защитой (${reason}).`
  return `Действие не началось или завершилось определённой ошибкой (${reason}).`
}

function omitTypedContent(observation: ComputerObservation): ComputerObservation {
  return {
    ...observation,
    title: '',
    text: '',
    elements: [],
    screenshotDataUrl: null,
    omissions: [...observation.omissions, 'typed-content-omitted'],
  }
}

function resultFromExisting(row: BrowserActionRow): ComputerDispatchResult {
  const status: ComputerResultStatus = row.status === 'verified'
    ? 'verified'
    : row.status === 'uncertain' || row.status === 'executing'
      ? 'uncertain'
      : row.status === 'cancelled' || row.status === 'rejected'
        ? 'cancelled'
        : row.status === 'blocked'
          ? 'blocked'
          : 'failed'
  return plainResult(row.actionId, status, row.resultStatus ?? `existing-${row.status}`)
}

function cloneIdentity(identity: ComputerIdentity): ComputerIdentity {
  return { ...identity }
}

function cloneCandidate(candidate: BackendCandidate): BackendCandidate {
  return { ...candidate, identity: cloneIdentity(candidate.identity) }
}

function cloneBackendElement(element: BackendObservedElement): BackendObservedElement {
  return {
    ...element,
    ...(element.bounds ? { bounds: { ...element.bounds } } : {}),
    ...(element.valueState ? { valueState: { ...element.valueState } } : {}),
    ...(element.scrollState ? { scrollState: { ...element.scrollState } } : {}),
    supportedActions: [...element.supportedActions],
  }
}

function validValueState(
  value: BackendObservedElement['valueState'],
): value is NonNullable<BackendObservedElement['valueState']> {
  return !!value
    && typeof value.fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && Number.isSafeInteger(value.scalarLength)
    && value.scalarLength >= 0
}

function validScrollState(value: BackendObservedElement['scrollState']): boolean {
  return !!value
    && validScrollPercent(value.horizontalPercent)
    && validScrollPercent(value.verticalPercent)
}

function validScrollPercent(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && (value === -1 || (value >= 0 && value <= 100))
}

function cloneProbe(probe: ComputerProbe): ComputerProbe {
  return { ...probe, identity: cloneIdentity(probe.identity), geometry: { ...probe.geometry } }
}

function normalizeProbe(probe: ComputerProbe): ComputerProbe {
  return { ...cloneProbe(probe), title: normalizeWindowTitle(probe.title) }
}

function normalizeWindowTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, 300)
}

function validTitleFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function center(bounds: WindowGeometry): { x: number; y: number } {
  return {
    x: Math.round(bounds.left + bounds.width / 2),
    y: Math.round(bounds.top + bounds.height / 2),
  }
}

function finite(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0
}

function discreteScrollDelta(value: number | undefined): -1 | 0 | 1 | null {
  if (value === undefined) return 0
  return value === -1 || value === 0 || value === 1 ? value : null
}

function lineageKey(browserTaskId: string, runId: string): string {
  return `${browserTaskId}\u0000${runId}`
}

function boundedSnapshotAge(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SNAPSHOT_AGE_MS
  return Math.max(1, Math.min(DEFAULT_MAX_SNAPSHOT_AGE_MS, Math.floor(Number(value))))
}

function boundedPostconditionSettle(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_POSTCONDITION_SETTLE_MS
  return Math.max(1, Math.min(MAX_POSTCONDITION_SETTLE_MS, Math.floor(Number(value))))
}

function assertStablePostObservation(
  first: ComputerObservation,
  second: ComputerObservation,
): void {
  if (first.browserTaskId !== second.browserTaskId
    || first.runId !== second.runId
    || first.bindingGeneration !== second.bindingGeneration
    || first.targetFingerprint !== second.targetFingerprint
    || first.title !== second.title
    || !sameGeometry(first.geometry, second.geometry)
    || first.dpi !== second.dpi
    || first.userInputEpoch !== second.userInputEpoch
    || !first.foreground
    || !second.foreground
    || first.screenLocked
    || second.screenLocked) {
    throw new ComputerSafetyError('readback-mismatch')
  }
}

function freshObservation(capturedAt: number, currentTime: number, maxAgeMs: number): boolean {
  const age = currentTime - capturedAt
  return Number.isFinite(capturedAt) && Number.isFinite(currentTime) && age >= 0 && age < maxAgeMs
}

function observationExpired(capturedAt: number, currentTime: number, maxAgeMs: number): boolean {
  const age = currentTime - capturedAt
  return Number.isFinite(capturedAt) && Number.isFinite(currentTime) && age >= maxAgeMs
}

function sameElementForAutomaticRenewal(
  previous: BackendObservedElement,
  current: BackendObservedElement,
): boolean {
  return previous.semanticFingerprint === current.semanticFingerprint
    && previous.role === current.role
    && previous.label === current.label
    && previous.state === current.state
    && previous.isPassword === current.isPassword
    && sameOptionalGeometry(previous.bounds, current.bounds)
    && previous.supportedActions.length === current.supportedActions.length
    && previous.supportedActions.every((action, index) => current.supportedActions[index] === action)
    && sameOptionalValueState(previous.valueState, current.valueState)
    && sameOptionalScrollState(previous.scrollState, current.scrollState)
}

function sameOptionalGeometry(left: WindowGeometry | undefined, right: WindowGeometry | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameGeometry(left, right)
}

function sameOptionalValueState(
  left: BackendObservedElement['valueState'],
  right: BackendObservedElement['valueState'],
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.fingerprint === right.fingerprint
      && left.scalarLength === right.scalarLength
}

function sameOptionalScrollState(
  left: BackendObservedElement['scrollState'],
  right: BackendObservedElement['scrollState'],
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.horizontalPercent === right.horizontalPercent
      && left.verticalPercent === right.verticalPercent
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  code: ComputerSafetyCode,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new ComputerSafetyError(code))
    }, Math.max(1, timeoutMs))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function delayWithAbort(ms: number, attempt: ActiveAttempt): Promise<void> {
  throwIfAborted(attempt)
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      attempt.abort.signal.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(1, ms))
    const onAbort = () => {
      clearTimeout(timer)
      reject(attempt.abort.signal.reason instanceof Error
        ? attempt.abort.signal.reason
        : new ComputerCancelledError(attempt.cancelReason ?? 'stopped'))
    }
    attempt.abort.signal.addEventListener('abort', onAbort, { once: true })
  })
}

function fireAndForget(value: void | Promise<unknown>): void {
  if (value && typeof value.then === 'function') void value.catch(() => undefined)
}
