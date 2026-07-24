import type { AdaptiveDecisionV1 } from '../../shared/contracts/outcome'
import type { PipelineStep } from '../storage/pipeline-runs'

export function nextPipelineStep(
  decision: AdaptiveDecisionV1,
  remainingSteps: number,
): PipelineStep {
  if (decision.action === 'block' || decision.action === 'ask-user') return 'blocked'
  if (decision.action === 'continue' && remainingSteps === 0) return 'verify'
  return 'execute'
}
