import type { TrustLevel } from './capability'

export type PolicyDecision = 'allow' | 'deny' | 'require_confirmation'
export type PolicyDecisionMode = 'off' | 'shadow' | 'enforce'
export type PolicyDecisionComparison = 'same' | 'tightening' | 'weakening-blocked'

export interface DecisionCapabilityV1 {
  id: string
  version: string | null
  trust: TrustLevel | null
}

/**
 * Server-owned identity and policy inputs for one effectful operation.
 * This contract deliberately has no `args`, command text, user input, URL, or
 * document content field. Policy evidence may retain a digest, never the value.
 */
export interface DecisionContextV1 {
  schemaVersion: 1
  policyVersion: 's2-a1-v1'
  timestamp: number
  agentId: string | null
  ownerId: string | null
  taskId: string | null
  jobId: string | null
  runId: string | null
  capability: DecisionCapabilityV1 | null
  mode: 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'
  tool: string
  operation: string
  normalizedTarget: {
    kind: 'command' | 'path' | 'connector' | 'opaque'
    digest: string
    scope: 'project' | 'external' | 'desktop' | 'unknown'
  }
  dataClass: 'project-local' | 'external' | 'sensitive' | 'unknown'
  envelope: {
    costCents: number | null
    runtimeMs: number | null
  }
  effectful: boolean
}

export interface DecisionTraceV1 {
  schemaVersion: 1
  traceId: string
  context: DecisionContextV1
  rolloutMode: PolicyDecisionMode
  legacyDecision: PolicyDecision
  candidateDecision: PolicyDecision
  enforcedDecision: PolicyDecision
  comparison: PolicyDecisionComparison
  reasonCodes: string[]
}

export interface DecisionReadbackV1 {
  schemaVersion: 1
  traceId: string
  runId: string | null
  jobId: string | null
  status: 'ok' | 'error' | 'rejected' | 'blocked'
  exitCode: number | null
  stdoutDigest: string | null
  stderrDigest: string | null
  timestamp: number
}

/**
 * Compact persisted projection. Both existing stores cap detail at 500 chars;
 * the positional tuples are versioned here so they remain parseable rather
 * than becoming a silently truncated JSON object.
 *
 * i = agent, owner, task, job, run, [capability id, version, trust]
 * a = mode, tool, operation, target digest, scope, data class, cost, runtime
 * d = rollout, legacy, candidate, enforced, comparison, reason codes
 */
export interface DecisionTraceStorageV1 {
  v: 1
  id: string
  pv: 's2-a1-v1'
  ts: number
  i: [string | null, string | null, string | null, string | null, string | null, [string, string | null, TrustLevel | null] | null]
  a: [DecisionContextV1['mode'], string, string, string, DecisionContextV1['normalizedTarget']['scope'], DecisionContextV1['dataClass'], number | null, number | null]
  d: [PolicyDecisionMode, PolicyDecision, PolicyDecision, PolicyDecision, PolicyDecisionComparison, string[]]
}
