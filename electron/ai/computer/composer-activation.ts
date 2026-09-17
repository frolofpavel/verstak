import {
  parseComputerUseComposerActivationProof,
  type ComputerUseComposerActivationProof,
} from '../../../shared/contracts/computer-use-composer-activation'

const NATIVE_ACTIVATION_TTL_MS = 250

type NativeMouseInput = {
  type: string
  button?: string
  x: number
  y: number
}

type NativeKeyInput = {
  type: string
  key: string
  shift: boolean
  control: boolean
  meta: boolean
  alt: boolean
}

type PendingActivation = ComputerUseComposerActivationProof & { expiresAt: number }

/** Main-owned half of the composer consent proof. Renderer DOM events identify
 * the exact control; Electron native input events prove the event was delivered
 * by Chromium rather than dispatched by renderer JavaScript. */
export function createComputerUseComposerActivationGate(
  now: () => number = () => performance.now(),
) {
  let pending: PendingActivation | null = null

  return {
    noteMouse(input: NativeMouseInput): void {
      if (
        input.type !== 'mouseUp'
        || input.button !== 'left'
        || !Number.isSafeInteger(input.x)
        || !Number.isSafeInteger(input.y)
      ) return
      pending = {
        kind: 'mouse',
        x: input.x,
        y: input.y,
        expiresAt: now() + NATIVE_ACTIVATION_TTL_MS,
      }
    },
    noteKey(input: NativeKeyInput): void {
      if (
        input.type !== 'keyDown'
        || input.key !== 'Enter'
        || input.shift
        || input.control
        || input.meta
        || input.alt
      ) return
      pending = {
        kind: 'keyboard',
        key: 'Enter',
        expiresAt: now() + NATIVE_ACTIVATION_TTL_MS,
      }
    },
    consume(value: unknown): boolean {
      const expected = pending
      pending = null
      const proof = parseComputerUseComposerActivationProof(value)
      if (!expected || !proof || expected.expiresAt < now() || expected.kind !== proof.kind) return false
      if (expected.kind === 'keyboard') return proof.kind === 'keyboard' && proof.key === 'Enter'
      return proof.kind === 'mouse'
        && Math.abs(expected.x - proof.x) <= 1
        && Math.abs(expected.y - proof.y) <= 1
    },
  }
}
