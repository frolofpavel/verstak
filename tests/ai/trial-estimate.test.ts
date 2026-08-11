// P1 шаг 2: оценка расхода ДО запуска состязания — по прайсу выбранных моделей
// (shared/contracts/pricing), тем же источником, что кормит разбивку расхода.
//
// Главный пин — правило постановки «деньги в таблице только настоящие»: где цена
// модели неизвестна, оценка обязана быть null («неизвестна»), а НЕ подставленным
// консервативным тарифом. FALLBACK_PRICE — защита лимита расхода, не витрина.
import { describe, it, expect } from 'vitest'
import { estimateTrialAttempts, TRIAL_ESTIMATE_TOKENS } from '../../electron/ai/trial-estimate'
import { PRICES } from '../../shared/contracts/pricing'
import { PROVIDERS } from '../../electron/ai/registry'

describe('P1: оценка расхода до запуска', () => {
  it('известная цена: центы посчитаны по прайсу и заявленному объёму', () => {
    const [est] = estimateTrialAttempts(
      [{ providerId: 'deepseek', model: 'deepseek-chat' }],
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    )
    const price = PRICES['deepseek-chat']
    expect(est.basis).toBe('price')
    expect(est.price).toEqual({ input: price.input, output: price.output })
    expect(est.estimateCents).toBe(Math.round((price.input + price.output) * 100))
  })

  it('неизвестная модель: оценки НЕТ (null), а не консервативный тариф', () => {
    const [est] = estimateTrialAttempts(
      [{ providerId: 'openai', model: 'gpt-99-mystery' }],
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    )
    expect(est.basis).toBe('unknown')
    expect(est.estimateCents).toBeNull()
    expect(est.price).toBeNull()
  })

  it('неизвестный провайдер: honest unknown, без выдумки модели', () => {
    const [est] = estimateTrialAttempts([{ providerId: 'no-such', model: 'x' }])
    expect(est.basis).toBe('unknown')
    expect(est.estimateCents).toBeNull()
  })

  it('CLI-подписка: $0 по основанию subscription, а не по прайсу', () => {
    const [est] = estimateTrialAttempts([{ providerId: 'claude-cli', model: 'auto' }])
    expect(est.basis).toBe('subscription')
    expect(est.estimateCents).toBe(0)
  })

  it('локальный/свой endpoint (ollama): осознанный $0, не «неизвестно»', () => {
    const [est] = estimateTrialAttempts([{ providerId: 'ollama', model: 'что-угодно' }])
    expect(est.basis).toBe('zero-cost')
    expect(est.estimateCents).toBe(0)
  })

  it('модель не задана — берётся дефолт провайдера (как сделает сам прогон)', () => {
    const [est] = estimateTrialAttempts([{ providerId: 'deepseek', model: null }])
    expect(est.model).toBe(PROVIDERS.deepseek.defaultModel)
  })

  it('дефолтный объём объявлен и положителен — UI показывает допущение, а не прячет его', () => {
    expect(TRIAL_ESTIMATE_TOKENS.inputTokens).toBeGreaterThan(0)
    expect(TRIAL_ESTIMATE_TOKENS.outputTokens).toBeGreaterThan(0)
    const [est] = estimateTrialAttempts([{ providerId: 'deepseek', model: 'deepseek-chat' }])
    expect(est.estimateCents).not.toBeNull()
  })

  it('порядок результатов совпадает с порядком участников', () => {
    const ests = estimateTrialAttempts([
      { providerId: 'deepseek', model: 'deepseek-chat' },
      { providerId: 'claude-cli', model: 'auto' },
    ])
    expect(ests.map(e => e.providerId)).toEqual(['deepseek', 'claude-cli'])
  })
})
