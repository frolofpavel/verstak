// PRICES + normalizeModelId переехали в shared/contracts/pricing.ts — ЕДИНЫЙ источник
// для renderer (src/lib/pricing.ts) и main (electron/ai/cost-guard.ts). Прежний
// анти-дрейф-пин (tests/lib/prices-drift.test.ts) сравнивал две копии; после переезда
// он стал ТАВТОЛОГИЕЙ (оба слоя ре-экспортируют один и тот же объект) и снят тем же
// коммитом. Вместо него — ПРЯМЫЕ пины на значения: страж теперь стережёт сами цифры,
// а не совпадение двух таблиц. Цены — деньги, меняет их только Павел; пин ловит
// СЛУЧАЙНУЮ правку значения/состава.
import { describe, it, expect } from 'vitest'
import { PRICES, normalizeModelId } from '../../shared/contracts/pricing'
import { PRICES as RENDERER_PRICES } from '../../src/lib/pricing'
import { PRICES as MAIN_PRICES } from '../../electron/ai/cost-guard'

describe('shared PRICES — прямые пины на значения (после переезда в shared)', () => {
  it('оба слоя ре-экспортируют ОДИН И ТОТ ЖЕ объект (дубля больше нет)', () => {
    // Ссылочная идентичность — доказательство, что копий не осталось: расходиться нечему.
    expect(RENDERER_PRICES).toBe(PRICES)
    expect(MAIN_PRICES).toBe(PRICES)
  })

  it('состав: ровно 55 моделей', () => {
    expect(Object.keys(PRICES)).toHaveLength(55)
  })

  it('три подписочные coding-модели стоят $0 (регресс сюда уже приводил к ложному счёту)', () => {
    for (const k of ['kimi-for-coding', 'glm-5.2', 'glm-5-turbo']) {
      expect(PRICES[k], k).toEqual({ input: 0, output: 0 })
    }
  })

  it('якорные цены не изменились (случайная правка значения — красный)', () => {
    expect(PRICES['claude-opus-4-5']).toEqual({ input: 15.0, output: 75.0, cached: 1.5, cacheWrite: 18.75 })
    expect(PRICES['claude-sonnet-4-6']).toEqual({ input: 3.0, output: 15.0, cached: 0.3, cacheWrite: 3.75 })
    expect(PRICES['gpt-5']).toEqual({ input: 1.25, output: 10.0 })
    expect(PRICES['grok-4.5']).toEqual({ input: 2.00, output: 6.00 })
    expect(PRICES['deepseek-v4-flash']).toEqual({ input: 0.28, output: 0.42 })
    expect(PRICES['gemini-3-pro']).toEqual({ input: 2.50, output: 15.0 })
  })

  it('локальные Ollama-модели явно $0 (осознанная бесплатность, не «неизвестно»)', () => {
    for (const k of ['llama3.3', 'qwen2.5-coder', 'deepseek-r1', 'mistral', 'gemma2']) {
      expect(PRICES[k], k).toEqual({ input: 0, output: 0 })
    }
  })
})

describe('normalizeModelId — переехал в shared, поведение прежнее', () => {
  it('openrouter: срезает префикс провайдера', () => {
    expect(normalizeModelId('openrouter', 'anthropic/claude-opus-4-5')).toBe('claude-opus-4-5')
    expect(normalizeModelId('openrouter', 'openai/gpt-5')).toBe('gpt-5')
  })
  it('openrouter без слэша — как есть', () => {
    expect(normalizeModelId('openrouter', 'gpt-5')).toBe('gpt-5')
  })
  it('не-openrouter: id не трогается (даже со слэшем)', () => {
    expect(normalizeModelId('openai', 'gpt-5')).toBe('gpt-5')
    expect(normalizeModelId('claude', 'anthropic/claude-opus-4-5')).toBe('anthropic/claude-opus-4-5')
  })
})
