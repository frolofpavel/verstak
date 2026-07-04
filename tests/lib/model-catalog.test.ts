import { describe, expect, it } from 'vitest'
import { buildCatalog, type ProviderLite } from '../../src/lib/model-catalog'

describe('model catalog', () => {
  it('shows Kimi K2.7 Code as a priced API model', () => {
    const providers: ProviderLite[] = [{
      id: 'moonshot',
      name: 'Moonshot Kimi',
      transport: 'API',
      supportsTools: true,
      models: ['kimi-k2.7-code'],
      defaultModel: 'kimi-k2.7-code',
    }]

    const [entry] = buildCatalog(providers)

    expect(entry.pricePerMInput).toBe(0.95)
    expect(entry.pricePerMOutput).toBe(4)
    expect(entry.tags).toContain('TOOLS')
    expect(entry.tags).toContain('API')
  })
})
