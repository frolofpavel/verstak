import { createHash, randomUUID } from 'crypto'
import type { AutoApprove, ToolDecision } from './mode-policy'
import type { TrustLevel } from '../../shared/contracts/capability'
import type { CompiledPermissionRules, ConfirmCause } from './permission-rules'
import { resolveDecision } from './permission-rules'
import type {
  DecisionContextV1,
  DecisionReadbackV1,
  DecisionTraceV1,
  DecisionTraceStorageV1,
  PolicyDecision,
  PolicyDecisionComparison,
  PolicyDecisionMode,
} from '../../shared/contracts/policy-decision'

const STRICTNESS: Record<PolicyDecision, number> = {
  allow: 0,
  require_confirmation: 1,
  deny: 2,
}

function fromLegacy(decision: ToolDecision): PolicyDecision {
  if (decision === 'block') return 'deny'
  if (decision === 'confirm') return 'require_confirmation'
  return 'allow'
}

export function policyDecisionMode(
  value = process.env.POLICY_DECISION_V1_MODE,
): PolicyDecisionMode {
  if (value === 'off' || value === 'enforce' || value === 'shadow') return value
  // Roll out observability first. Shadow preserves the legacy execution
  // decision while making tightening/weakening mismatches visible.
  return 'shadow'
}

export function digestPolicyValue(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

export function reconcilePolicyDecision(
  legacy: PolicyDecision,
  candidate: PolicyDecision,
): { decision: PolicyDecision; comparison: PolicyDecisionComparison } {
  if (candidate === legacy) return { decision: legacy, comparison: 'same' }
  if (STRICTNESS[candidate] < STRICTNESS[legacy]) {
    return { decision: legacy, comparison: 'weakening-blocked' }
  }
  return { decision: candidate, comparison: 'tightening' }
}

export interface EvaluatePolicyDecisionInput {
  context: DecisionContextV1
  args?: Record<string, unknown>
  autoApprove?: AutoApprove
  permissionRules?: CompiledPermissionRules
  /** Existing trust input, kept separate so shadow is byte-for-byte compatible. */
  capabilityTrust?: TrustLevel
  featureMode?: PolicyDecisionMode
  /** A guard that runs before permission-rules (for run_command: denylist). */
  hardDenyReason?: string
}

export interface PolicyDecisionEvaluation {
  decision: PolicyDecision
  candidate: PolicyDecision
  confirmCause?: ConfirmCause | 'policy-identity'
  denyReason?: string
  legacy: ReturnType<typeof resolveDecision>
  trace: DecisionTraceV1
}

function resolveLegacyDecision(input: EvaluatePolicyDecisionInput): ReturnType<typeof resolveDecision> {
  if (input.hardDenyReason) return { decision: 'block', reason: input.hardDenyReason }
  const capabilityTrust = input.capabilityTrust ?? input.context.capability?.trust ?? undefined
  return resolveDecision(input.context.tool, input.args, input.context.mode, input.autoApprove, input.permissionRules, capabilityTrust)
}

function identityReasons(context: DecisionContextV1): string[] {
  const reasons: string[] = []
  if (!context.agentId) reasons.push('unknown-agent')
  if (!context.ownerId) reasons.push('unknown-owner')
  if (!context.capability?.id) reasons.push('unknown-capability')
  else if (!context.capability.version) reasons.push('unknown-capability-version')
  return reasons
}

/**
 * S2-A1 facade over the existing, battle-tested permission decision. The
 * candidate is allowed to tighten it only. A future candidate regression is
 * reconciled fail-closed before either shadow reporting or enforcement.
 */
export function evaluatePolicyDecision(input: EvaluatePolicyDecisionInput): PolicyDecisionEvaluation {
  const rolloutMode = input.featureMode ?? policyDecisionMode()
  const legacy = resolveLegacyDecision(input)
  const legacyDecision = fromLegacy(legacy.decision)
  const reasons = input.hardDenyReason ? ['hard-deny'] : []
  let candidate = legacyDecision

  if (input.context.effectful && legacyDecision === 'allow') {
    const unknown = identityReasons(input.context)
    reasons.push(...unknown)
    if (unknown.length > 0) candidate = 'require_confirmation'
  }

  const reconciled = reconcilePolicyDecision(legacyDecision, candidate)
  if (reconciled.comparison === 'weakening-blocked') reasons.push('weakening-blocked')
  const enforced = rolloutMode === 'enforce' ? reconciled.decision : legacyDecision
  const context: DecisionContextV1 = {
    ...input.context,
    // The digest is derived here from transient args; raw values never enter
    // the trace contract even when callers supplied a placeholder context.
    normalizedTarget: input.context.tool === 'run_command'
      ? {
        kind: 'command',
        digest: digestPolicyValue(String(input.args?.command ?? '')),
        scope: 'project',
      }
      : input.context.normalizedTarget,
  }
  const trace: DecisionTraceV1 = {
    schemaVersion: 1,
    traceId: randomUUID(),
    context,
    rolloutMode,
    legacyDecision,
    candidateDecision: candidate,
    enforcedDecision: enforced,
    comparison: reconciled.comparison,
    reasonCodes: reasons,
  }

  return {
    decision: enforced,
    candidate,
    confirmCause: enforced === 'require_confirmation' && legacyDecision === 'allow'
      ? 'policy-identity'
      : legacy.confirmCause,
    denyReason: legacy.reason,
    legacy,
    trace,
  }
}

export function createDecisionReadback(
  trace: DecisionTraceV1,
  input: {
    status: DecisionReadbackV1['status']
    exitCode?: number | null
    stdout?: string
    stderr?: string
    timestamp?: number
  },
): DecisionReadbackV1 {
  return {
    schemaVersion: 1,
    traceId: trace.traceId,
    runId: trace.context.runId,
    jobId: trace.context.jobId,
    status: input.status,
    exitCode: input.exitCode ?? null,
    stdoutDigest: input.stdout == null ? null : digestPolicyValue(input.stdout),
    stderrDigest: input.stderr == null ? null : digestPolicyValue(input.stderr),
    timestamp: input.timestamp ?? Date.now(),
  }
}

function boundedIdentity(value: string | null): string | null {
  if (value == null || value.length <= 32) return value
  return `#${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 20)}`
}

export function serializeDecisionTrace(trace: DecisionTraceV1): string {
  const c = trace.context
  const capability: [string, string | null, TrustLevel | null] | null = c.capability
    ? [boundedIdentity(c.capability.id)!, c.capability.version, c.capability.trust]
    : null
  const stored: DecisionTraceStorageV1 = {
    v: 1,
    id: trace.traceId,
    pv: c.policyVersion,
    ts: c.timestamp,
    i: [boundedIdentity(c.agentId), boundedIdentity(c.ownerId), boundedIdentity(c.taskId), boundedIdentity(c.jobId), boundedIdentity(c.runId), capability],
    a: [c.mode, c.tool, c.operation, c.normalizedTarget.digest, c.normalizedTarget.scope, c.dataClass, c.envelope.costCents, c.envelope.runtimeMs],
    d: [trace.rolloutMode, trace.legacyDecision, trace.candidateDecision, trace.enforcedDecision, trace.comparison, trace.reasonCodes],
  }
  return JSON.stringify(stored)
}
