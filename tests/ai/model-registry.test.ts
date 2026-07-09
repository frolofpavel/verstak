import { describe, expect, it } from 'vitest'
import { getContextLimit } from '../../electron/ai/context-limits'
import { EXTRA_PROVIDERS } from '../../electron/ai/extra-providers'
import { DEFAULT_GROK_CLI_MODEL, GROK_CLI_MODELS } from '../../electron/ai/grok-cli'
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

  it('uses live Grok Build CLI model ids, not the legacy grok-build alias', () => {
    expect(DEFAULT_GROK_CLI_MODEL).toBe('grok-4.5')
    expect(GROK_CLI_MODELS).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
    expect(GROK_CLI_MODELS).not.toContain('grok-build')
  })

  it('registers Kimi Code subscription provider (kimi.com membership, не по токенам)', () => {
    const kimi = EXTRA_PROVIDERS.find(p => p.id === 'kimi-coding')!

    expect(kimi).toBeDefined()
    expect(kimi.baseUrl).toBe('https://api.kimi.com/coding/v1')
    expect(kimi.defaultModel).toBe('kimi-for-coding')
    expect(kimi.secretKey).toBe('kimi_coding_api_key')
    // Подписка: маржинальная цена токена 0 — cost controller не должен пугать юзера.
    expect(getRegisteredModelPrice('kimi-for-coding')).toEqual({ input: 0, output: 0 })
    // Контекст из доков Kimi Code (262144) — через registry-fallback getContextLimit.
    expect(getContextLimit('kimi-for-coding')).toBe(262_144)
  })

  it('registers Z.ai GLM Coding Plan subscription provider (строго coding-endpoint)', () => {
    const zai = EXTRA_PROVIDERS.find(p => p.id === 'zai-coding')!

    expect(zai).toBeDefined()
    // Критично: coding-endpoint, НЕ общий /api/paas/v4 (они не взаимозаменяемы).
    expect(zai.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(zai.defaultModel).toBe('glm-5.2')
    expect(zai.models).toContain('glm-5-turbo')
    expect(zai.secretKey).toBe('zai_coding_api_key')
    expect(getRegisteredModelPrice('glm-5.2')).toEqual({ input: 0, output: 0 })
  })
})
