import policyData from './agent-model-policy.json'

export type AgentModelMode = 'recommended' | 'allowed' | 'fallback' | 'not_recommended'
export type AgentModelRole = 'coding' | 'planner' | 'reviewer' | 'fast-edit' | 'fallback' | 'executor' | 'verifier' | 'cheap-read'
export type AgentRecipeId = 'small-edit' | 'bugfix' | 'test-fix' | 'typescript-error' | 'review-before-commit'
export type AgentToolMode = 'native' | 'json'

export interface AgentModelPolicy {
  model: string
  agentMode: AgentModelMode
  roles: AgentModelRole[]
  recipes: AgentRecipeId[]
  toolMode: AgentToolMode
  notes?: string
}

interface AgentModelPolicyData {
  version: string
  source: string
  defaults: {
    provider: string
    coding: string
    fallback: string
    reviewer: string
    planner: string
    fastEdit: string
  }
  aliases: Record<string, string>
  gatewayPresetRecommendations: Record<string, string>
  policies: AgentModelPolicy[]
}

const DATA = policyData as AgentModelPolicyData

export const DEFAULT_AGENT_CODING_MODEL = DATA.defaults.coding
export const DEFAULT_AGENT_FALLBACK_MODEL = DATA.defaults.fallback
export const DEFAULT_AGENT_REVIEWER_MODEL = DATA.defaults.reviewer
export const DEFAULT_AGENT_PLANNER_MODEL = DATA.defaults.planner
export const DEFAULT_AGENT_FAST_EDIT_MODEL = DATA.defaults.fastEdit
export const AGENT_MODEL_POLICIES: AgentModelPolicy[] = DATA.policies
export const GATEWAY_AGENT_PRESET_RECOMMENDATIONS = DATA.gatewayPresetRecommendations

export function canonicalAgentModel(model: string | null | undefined): string | null {
  if (!model) return null
  return DATA.aliases[model] ?? model
}

export function getAgentModelPolicy(model: string | null | undefined): AgentModelPolicy | null {
  const canonical = canonicalAgentModel(model)
  if (!canonical) return null
  return AGENT_MODEL_POLICIES.find(p => p.model === canonical) ?? null
}

export function isAgentModelNotRecommended(model: string | null | undefined): boolean {
  return getAgentModelPolicy(model)?.agentMode === 'not_recommended'
}

export function recommendedGatewayPresetTarget(model: string | null | undefined): string | null {
  if (!model) return null
  return GATEWAY_AGENT_PRESET_RECOMMENDATIONS[model] ?? null
}

export function recommendAgentModel(
  role: AgentModelRole = 'coding',
  opts: { recipe?: AgentRecipeId; fallback?: boolean; userPinnedModel?: string | null } = {}
): string {
  const pinned = canonicalAgentModel(opts.userPinnedModel)
  if (pinned) return pinned
  if (opts.fallback) return DEFAULT_AGENT_FALLBACK_MODEL
  if (role === 'fallback') return DEFAULT_AGENT_FALLBACK_MODEL
  if (role === 'planner') return DEFAULT_AGENT_PLANNER_MODEL
  if (role === 'reviewer' || role === 'verifier') return DEFAULT_AGENT_REVIEWER_MODEL
  if (role === 'fast-edit' || role === 'cheap-read') return DEFAULT_AGENT_FAST_EDIT_MODEL

  if (opts.recipe) {
    const hit = AGENT_MODEL_POLICIES.find(p =>
      p.agentMode === 'recommended' &&
      p.roles.includes('coding') &&
      p.recipes.includes(opts.recipe!)
    )
    if (hit) return hit.model
  }

  return DEFAULT_AGENT_CODING_MODEL
}
