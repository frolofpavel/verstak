import type { ComputerUseComposerActivationProof } from '../shared/contracts/computer-use-composer-activation'

const COMPOSER_ACTIVATION_WINDOW_MS = 250

interface ActivationEventLike {
  readonly isTrusted: boolean
  readonly key?: string
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly clientX?: number
  readonly clientY?: number
  composedPath(): unknown[]
}

interface ActivationTargetLike {
  addEventListener(
    type: 'click' | 'keydown',
    listener: (event: ActivationEventLike) => void,
    options: { capture: true },
  ): void
}

function pathHasClass(event: ActivationEventLike, className: string): boolean {
  return event.composedPath().some(item => {
    if (!item || typeof item !== 'object') return false
    const classList = (item as { classList?: { contains?: (name: string) => boolean } }).classList
    return classList?.contains?.(className) === true
  })
}

/**
 * contextBridge callbacks execute in Electron's isolated world. Chromium may
 * expose a different transient `navigator.userActivation` value there than in
 * the page world that received the physical click/keypress. Capture the trusted
 * DOM event itself, then consume the proof synchronously from the React submit
 * handler in the same dispatch.
 */
export function installComputerUseComposerActivationLatch(
  target: ActivationTargetLike,
  now: () => number = () => performance.now(),
): () => ComputerUseComposerActivationProof | null {
  let armedUntil = 0
  let proof: ComputerUseComposerActivationProof | null = null

  const arm = (nextProof: ComputerUseComposerActivationProof) => {
    proof = nextProof
    armedUntil = now() + COMPOSER_ACTIVATION_WINDOW_MS
  }

  target.addEventListener('click', event => {
    if (
      event.isTrusted
      && pathHasClass(event, 'gg-send-btn')
      && !pathHasClass(event, 'gg-stop-btn')
      && !pathHasClass(event, 'gg-pause-btn')
      && Number.isSafeInteger(event.clientX)
      && Number.isSafeInteger(event.clientY)
    ) arm({ kind: 'mouse', x: event.clientX!, y: event.clientY! })
  }, { capture: true })

  target.addEventListener('keydown', event => {
    if (
      event.isTrusted
      && event.key === 'Enter'
      && event.shiftKey !== true
      && event.ctrlKey !== true
      && event.metaKey !== true
      && pathHasClass(event, 'gg-composer-textarea')
    ) arm({ kind: 'keyboard', key: 'Enter' })
  }, { capture: true })

  return () => {
    const accepted = armedUntil > 0 && now() <= armedUntil ? proof : null
    armedUntil = 0
    proof = null
    return accepted
  }
}
