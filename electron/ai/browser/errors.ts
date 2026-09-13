/**
 * Transport lost the acknowledgement after a browser mutation was dispatched.
 * The page may already have applied the effect, so callers must not retry it.
 */
export type UnknownBrowserEffectReason = 'timeout' | 'disconnect' | 'transport'

export class UnknownBrowserEffectError extends Error {
  readonly code = 'BROWSER_EFFECT_UNKNOWN' as const
  readonly effectReason: UnknownBrowserEffectReason

  constructor(message: string, effectReason: UnknownBrowserEffectReason) {
    super(message)
    this.name = 'UnknownBrowserEffectError'
    this.effectReason = effectReason
  }
}

export function isUnknownBrowserEffectError(error: unknown): error is UnknownBrowserEffectError {
  return error instanceof UnknownBrowserEffectError
    || (
      typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'BROWSER_EFFECT_UNKNOWN'
    )
}
