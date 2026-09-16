export type ComputerSafetyCode =
  | 'no-binding'
  | 'unknown-candidate'
  | 'invalid-target-identity'
  | 'target-identity-changed'
  | 'target-title-changed'
  | 'target-destroyed'
  | 'stale-observation'
  | 'stale-binding-generation'
  | 'binding-owner-mismatch'
  | 'binding-expired'
  | 'binding-not-authorized'
  | 'binding-active'
  | 'stale-geometry'
  | 'stale-dpi'
  | 'hardware-input'
  | 'focus-lost'
  | 'screen-locked'
  | 'elevated-target'
  | 'protected-target'
  | 'secure-surface'
  | 'password-surface'
  | 'secret-input'
  | 'responsible-action-confirmation-required'
  | 'hit-test-mismatch'
  | 'target-occluded'
  | 'uia-priority-violated'
  | 'global-input-not-accepted'
  | 'invalid-element-ref'
  | 'invalid-key'
  | 'invalid-action'
  | 'inactive-run'
  | 'action-id-conflict'
  | 'prepare-timeout'
  | 'commit-timeout'
  | 'readback-mismatch'
  | 'dispatch-not-accepted'
  | 'effect-not-proven'
  | 'uncertain-reconciliation-required'
  | 'readback-failed'
  | 'transport-lost'
  | 'stopped'
  | 'run-cancelled'
  | 'helper-crashed'

export class ComputerSafetyError extends Error {
  constructor(
    readonly code: ComputerSafetyCode,
    message = code,
  ) {
    super(message)
    this.name = 'ComputerSafetyError'
  }
}

export class ComputerCancelledError extends ComputerSafetyError {
  constructor(code: ComputerSafetyCode = 'stopped') {
    super(code)
    this.name = 'ComputerCancelledError'
  }
}

export class ComputerUnknownEffectError extends ComputerSafetyError {
  constructor(code: ComputerSafetyCode, message = code) {
    super(code, message)
    this.name = 'ComputerUnknownEffectError'
  }
}

export function computerErrorCode(error: unknown, fallback: ComputerSafetyCode): ComputerSafetyCode {
  return error instanceof ComputerSafetyError ? error.code : fallback
}
