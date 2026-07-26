import type { AgentJobV1 } from '../../shared/contracts/agent-job'

function root(scope: string): string {
  const normalized = scope.trim().replace(/\\/g, '/').replace(/^\.\/+/, '')
  const wildcard = normalized.search(/[*?[]/)
  const stable = wildcard >= 0 ? normalized.slice(0, wildcard) : normalized
  return stable.replace(/\/+$/, '')
}

export function scopesMayConflict(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false
  for (const a of left) {
    for (const b of right) {
      if (a === '**' || b === '**') return true
      const ar = root(a)
      const br = root(b)
      if (!ar || !br || ar === br || ar.startsWith(`${br}/`) || br.startsWith(`${ar}/`)) return true
    }
  }
  return false
}

export function jobsConflict(
  left: Pick<AgentJobV1, 'id' | 'writeScope'>,
  right: Pick<AgentJobV1, 'id' | 'writeScope'>,
): boolean {
  return left.id !== right.id && scopesMayConflict(left.writeScope, right.writeScope)
}

