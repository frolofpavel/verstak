export function ensureNodeAbi(opts?: { log?: Pick<Console, 'log' | 'warn'> }): {
  status: 'ok' | 'rebuilt' | 'locked' | 'failed' | 'error'
  rebuilt: boolean
}
export function classifyRebuildOutcome(p: {
  spawnError: boolean
  afterOk: boolean
  afterAbiMismatch: boolean
  isBusy: boolean
}): 'rebuilt' | 'locked' | 'failed'
