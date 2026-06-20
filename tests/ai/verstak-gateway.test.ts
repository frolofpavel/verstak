import { describe, it, expect } from 'vitest'
import { EXTRA_PROVIDERS, GATEWAY_PRESET_LABELS, createExtraProvider } from '../../electron/ai/extra-providers'

describe('Verstak Gateway провайдер (Phase 1 / Итерация 1)', () => {
  const spec = EXTRA_PROVIDERS.find(p => p.id === 'verstak-gateway')

  it('зарегистрирован в EXTRA_PROVIDERS с правильным baseUrl/ключом', () => {
    expect(spec).toBeDefined()
    expect(spec!.baseUrl).toBe('https://api.agi-iri.ru/v1')
    expect(spec!.secretKey).toBe('verstak_gateway_api_key')
    expect(spec!.keyHint).toBe('vsk_live_...')
  })

  it('пресеты вместо зоопарка моделей (Эконом/Баланс/Кодинг/…)', () => {
    expect(spec!.models).toEqual([
      'verstak/economy', 'verstak/balanced', 'verstak/coder',
      'verstak/long', 'verstak/fast', 'verstak/private',
    ])
    expect(spec!.defaultModel).toBe('verstak/balanced')
  })

  it('русские названия пресетов для UI (в API уходит id)', () => {
    expect(GATEWAY_PRESET_LABELS['verstak/economy']).toBe('Эконом')
    expect(GATEWAY_PRESET_LABELS['verstak/coder']).toBe('Кодинг')
    // каждый пресет имеет лейбл
    for (const m of spec!.models) expect(GATEWAY_PRESET_LABELS[m]).toBeTruthy()
  })

  it('createExtraProvider строит провайдер (OpenAI-совместимый, как DeepSeek)', () => {
    const p = createExtraProvider('verstak-gateway', { apiKey: 'vsk_live_test' })
    expect(p.id).toBe('verstak-gateway')
    expect(p.models).toContain('verstak/balanced')
  })
})
