import { describe, expect, it } from 'vitest'
import {
  canonicalAgentModel,
  getAgentModelPolicy,
  isAgentModelNotRecommended,
  recommendAgentModel,
  recommendedGatewayPresetTarget,
} from '../../electron/ai/agent-model-policy'

describe('agent model policy', () => {
  it('returns Kimi as the default coding model', () => {
    expect(recommendAgentModel('coding')).toBe('kimi-k2.7-code')
  })

  it('returns DeepSeek Chat as the coding fallback', () => {
    expect(recommendAgentModel('coding', { fallback: true })).toBe('deepseek-chat')
  })

  it('allows Qwen but does not make it the reviewer default', () => {
    expect(getAgentModelPolicy('qwen3-coder')?.agentMode).toBe('allowed')
    expect(recommendAgentModel('reviewer', { recipe: 'review-before-commit' })).toBe('kimi-k2.7-code')
  })

  it('keeps fast Gateway presets out of agent-mode defaults', () => {
    expect(isAgentModelNotRecommended('verstak/fast')).toBe(true)
    expect(isAgentModelNotRecommended('verstak/coder/fast')).toBe(true)
    expect(recommendAgentModel('coding')).not.toBe('verstak/fast')
    expect(recommendAgentModel('coding')).not.toBe('verstak/coder/fast')
  })

  it('maps balanced Gateway presets to Kimi recommendations', () => {
    expect(recommendedGatewayPresetTarget('verstak/balanced')).toBe('kimi-k2.7-code')
    expect(recommendedGatewayPresetTarget('verstak/coder/balanced')).toBe('kimi-k2.7-code')
  })

  it('normalizes known provider aliases', () => {
    expect(canonicalAgentModel('moonshotai-kimi-k2')).toBe('kimi-k2.7-code')
    expect(canonicalAgentModel('qwen/qwen3-coder')).toBe('qwen3-coder')
  })

  it('routes all Model Gym roles through current approved defaults', () => {
    expect(recommendAgentModel('executor')).toBe('kimi-k2.7-code')
    expect(recommendAgentModel('verifier')).toBe('kimi-k2.7-code')
    expect(recommendAgentModel('cheap-read')).toBe('deepseek-chat')
    expect(recommendAgentModel('fallback')).toBe('deepseek-chat')
  })

  it('keeps an explicit user pin above measured recommendations', () => {
    expect(recommendAgentModel('executor', { userPinnedModel: 'qwen/qwen3-coder' })).toBe('qwen3-coder')
  })
})
