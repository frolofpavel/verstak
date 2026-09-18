// Typed seam between the transport-focused JSONL client and the durable
// selected-window controller. Keeping it explicit prevents the two narrow
// contracts from drifting together by structural accident.
import type { ComputerHelperClient } from './helper-client'
import type { ComputerPrepareActionInput } from './protocol'
import type {
  ComputerBackend,
  ComputerCommitOptions,
  ComputerPrepareRequest,
  ComputerPreparedAction,
} from './types'

type HelperClient = Pick<ComputerHelperClient,
  | 'listCandidates'
  | 'probeBinding'
  | 'focusBinding'
  | 'observe'
  | 'prepareAction'
  | 'commitAction'
  | 'cancel'
  | 'stop'
  | 'shutdown'
  | 'onEvent'
>

function wirePrepare(request: ComputerPrepareRequest): ComputerPrepareActionInput {
  return {
    attemptId: request.attemptId,
    identity: request.identity,
    action: request.action,
    ...(request.resolvedElement ? {
      resolvedElement: {
        backendRef: request.resolvedElement.backendRef,
        ...(request.resolvedElement.expectedTransition
          ? { expectedTransition: { ...request.resolvedElement.expectedTransition } }
          : {}),
        ...(request.resolvedElement.expectedValueState
          ? { expectedValueState: { ...request.resolvedElement.expectedValueState } }
          : {}),
        ...(request.resolvedElement.expectedScrollState
          ? { expectedScrollState: { ...request.resolvedElement.expectedScrollState } }
          : {}),
      },
    } : {}),
    ...(request.fallbackPoint ? { fallbackPoint: request.fallbackPoint } : {}),
    ...(request.textChunks ? { textChunks: request.textChunks } : {}),
    expected: request.expected,
    signal: request.signal,
  }
}

export function createComputerHelperBackend(client: HelperClient): ComputerBackend {
  return {
    async listCandidates() {
      const candidates = await client.listCandidates()
      return candidates.map(candidate => ({
        candidateToken: candidate.candidateToken,
        identity: candidate.identity,
        processName: candidate.processName,
        ...(candidate.productName ? { productName: candidate.productName } : {}),
        ...(candidate.topLevelClassName ? { topLevelClassName: candidate.topLevelClassName } : {}),
        title: candidate.title,
        titleFingerprint: candidate.titleFingerprint,
        geometry: candidate.geometry,
        visible: candidate.visible,
        foreground: candidate.foreground,
        elevated: candidate.elevated,
        protectedProcess: candidate.protectedProcess,
        secureSurface: candidate.secureSurface,
      }))
    },
    probeBinding: (identity, candidateToken) => client.probeBinding(identity, candidateToken),
    focusBinding: identity => client.focusBinding(identity),
    observe: identity => client.observe(identity),
    prepareAction: request => client.prepareAction(wirePrepare(request)) as Promise<ComputerPreparedAction>,
    async commitAction(prepared: ComputerPreparedAction, options: ComputerCommitOptions) {
      // Production helper advertises `backend-enforced` chunk guards and runs
      // native identity/focus/input-epoch checks between chunks. Its transport
      // therefore receives only transfer/abort callbacks, not the in-process
      // fake backend's controller-callback hook.
      const committed = await client.commitAction(prepared, {
        signal: options.signal,
        onTransferred: options.onTransferred,
      })
      return { attemptId: prepared.attemptId, readback: committed.readback }
    },
    async cancel(attemptId) { await client.cancel(attemptId) },
    async stop() { await client.stop() },
    async shutdown() { await client.shutdown() },
    onEvent(listener) {
      return client.onEvent(event => listener({ type: event.type }))
    },
  }
}
