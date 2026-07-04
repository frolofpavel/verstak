import { describe, expect, it } from 'vitest'
import { getContextLimit } from '../../electron/ai/context-limits'
import { EXTRA_PROVIDERS } from '../../electron/ai/extra-providers'
import {
  getRegisteredModelPrice,
  modelRegistryEntry,
  modelRegistryForProvider,
} from '../../electron/ai/model-registry'

describe('model registry', () => {
  it('tracks Kimi K2.7 Code context and price for agent defaults', () => {
    expect(getContextLimit('kimi-k2.7-code')).toBe(256_000)
    expect(getRegisteredModelPrice('kimi-k2.7-code')).toEqual({ input: 0.95, output: 4.00 })
  })

  it('keeps Moonshot provider default in sync with the registry', () => {
    const moonshot = EXTRA_PROVIDERS.find(p => p.id === 'moonshot')!

    expect(moonshot.defaultModel).toBe('kimi-k2.7-code')
    expect(moonshot.models[0]).toBe('kimi-k2.7-code')
    expect(modelRegistryEntry('moonshot', moonshot.defaultModel)?.agentMode).toBe('recommended')
  })

  it('covers all hard-coded Moonshot models', () => {
    const moonshot = EXTRA_PROVIDERS.find(p => p.id === 'moonshot')!
    const registered = new Set(modelRegistryForProvider('moonshot').map(entry => entry.model))

    for (const model of moonshot.models) {
      expect(registered.has(model), `missing Moonshot registry entry for ${model}`).toBe(true)
    }
  })

  it('marks Gateway agent defaults explicitly', () => {
    expect(modelRegistryEntry('verstak-gateway', 'kimi-k2.7-code')?.defaultRoles).toContain('coding')
    expect(modelRegistryEntry('verstak-gateway', 'deepseek-chat')?.defaultRoles).toContain('fallback')
    expect(modelRegistryEntry('verstak-gateway', 'verstak/fast')?.agentMode).toBe('not-recommended')
  })
})
