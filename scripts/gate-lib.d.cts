export function hasNonAbiFailures(output: string): boolean
export function decideTestGate(p: {
  abiStatus: 'ok' | 'rebuilt' | 'locked' | 'failed' | 'error'
  vitestExit: number
  vitestOutput: string
}): { block: boolean; reason: string }
