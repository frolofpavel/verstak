export type ModelEvalRole = 'planner' | 'executor' | 'reviewer' | 'verifier' | 'cheap-read' | 'fallback'

export interface ModelEvalRoleEvidence {
  passRate: number
  repeats: number
  fixtures: string[]
  safetyPassed: boolean
  rowCount: number
  medianDurationMs: number | null
  estimatedCost: number | null
}

export interface ModelEvalRoleCandidate {
  model: string
  evidence: ModelEvalRoleEvidence
}

export interface ModelEvalPolicyCandidate {
  schemaVersion: 1
  status: 'candidate' | 'insufficient'
  generatedAt: string
  source: { runDate: string; verstakCommit: string }
  autoApplied: false
  ownerApprovalRequired: true
  roles: Partial<Record<ModelEvalRole, ModelEvalRoleCandidate>>
  reasons: string[]
}
