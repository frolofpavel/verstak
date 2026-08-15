import { describe, it, expect } from 'vitest'
import { EXTRA_PROVIDERS, createExtraProvider } from '../../electron/ai/extra-providers'

describe('Verstak Gateway провайдер (Phase 1 / Итерация 1)', () => {
  const spec = EXTRA_PROVIDERS.find(p => p.id === 'verstak-gateway')

  it('зарегистрирован в EXTRA_PROVIDERS с правильным baseUrl/ключом', () => {
    expect(spec).toBeDefined()
    expect(spec!.baseUrl).toBe('https://api-ru.agi-iri.ru/v1') // РФ-релей (постоянный домен)
    expect(spec!.secretKey).toBe('verstak_gateway_api_key')
    expect(spec!.keyHint).toBe('vsk_live_...')
  })

  it('пресеты вместо зоопарка моделей (Эконом/Баланс/Кодинг/…)', () => {
    expect(spec!.models).toEqual([
      'kimi-k2.7-code', 'deepseek-chat', 'qwen3-coder',
      'verstak/economy', 'verstak/free', 'verstak/balanced', 'verstak/coder',
      'verstak/long', 'verstak/fast', 'verstak/private',
    ])
    expect(spec!.defaultModel).toBe('kimi-k2.7-code')
  })

  // Проверка русских названий пресетов переехала туда, где живёт единственная
  // таблица меток — tests/lib/gateway-preset-labels.test.ts (main-копия удалена
  // 15.08, §1.2 ревизии; показывает метку renderer, у main поверхности нет).

  it('createExtraProvider строит провайдер (OpenAI-совместимый, как DeepSeek)', () => {
    const p = createExtraProvider('verstak-gateway', { apiKey: 'vsk_live_test' })
    expect(p.id).toBe('verstak-gateway')
    expect(p.models[0]).toBe('kimi-k2.7-code')
    expect(p.models).toContain('verstak/balanced')
  })
})
