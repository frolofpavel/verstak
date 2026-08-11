/**
 * P1 шаг 2: оценка расхода состязания ДО запуска.
 *
 * Источник один — shared/contracts/pricing, тот же, что кормит разбивку расхода
 * и «Итого». Правило постановки: деньги только настоящие. Где цена модели
 * неизвестна — оценка null («неизвестна»), а НЕ подставленный тариф:
 * FALLBACK_PRICE из cost-guard — защита лимита расхода, витрине он врал бы.
 *
 * Оценка — это ставка × заявленный объём. Объём до запуска знать нельзя, поэтому
 * он ЯВНЫЙ: дефолт TRIAL_ESTIMATE_TOKENS объявлен константой, вызывающий может
 * передать свой, а UI обязан показать допущение рядом с центами.
 */
import { PROVIDERS } from './registry'
import { CLI_FREE, ZERO_COST_PROVIDERS } from './cost-guard'
import { PRICES, normalizeModelId } from '../../shared/contracts/pricing'
import { isKnownProviderId } from '../../shared/contracts/provider'

export interface TrialTokenAssumption {
  inputTokens: number
  outputTokens: number
}

/**
 * Объём «типичной агентной задачи» для дефолтной оценки. Ориентир — живой разбор
 * трёх агентов 08.08 (задачи по $3–9 на моделях среднего/верхнего ценника).
 * Это ДОПУЩЕНИЕ для сравнения исполнителей между собой, не обещание чека.
 */
export const TRIAL_ESTIMATE_TOKENS: TrialTokenAssumption = { inputTokens: 400_000, outputTokens: 30_000 }

export type TrialEstimateBasis = 'price' | 'subscription' | 'zero-cost' | 'unknown'

export interface TrialAttemptEstimate {
  providerId: string
  /** Модель, по которой смотрели прайс: заданная или дефолт провайдера (как сделает сам прогон). */
  model: string | null
  /** Откуда цифра: 'price' — прайс модели; 'subscription' — CLI-подписка ($0);
   *  'zero-cost' — локальный/свой endpoint ($0 осознанно); 'unknown' — цены нет. */
  basis: TrialEstimateBasis
  /** Ставки $/1M input/output. null — когда прайса нет или он не применим ($0-основания). */
  price: { input: number; output: number } | null
  /** Оценка в центах для заявленного объёма. null — цена неизвестна: так и показываем. */
  estimateCents: number | null
}

// Сравнение по строке: реестровые Set'ы типизированы ProviderId, а участник
// состязания приходит строкой (валидация — отдельным основанием 'unknown').
const CLI_FREE_IDS: ReadonlySet<string> = CLI_FREE
const ZERO_COST_IDS: ReadonlySet<string> = ZERO_COST_PROVIDERS

export function estimateTrialAttempts(
  competitors: Array<{ providerId: string; model?: string | null }>,
  tokens: TrialTokenAssumption = TRIAL_ESTIMATE_TOKENS,
): TrialAttemptEstimate[] {
  return competitors.map(({ providerId, model }) => {
    if (!isKnownProviderId(providerId)) {
      return { providerId, model: model ?? null, basis: 'unknown' as const, price: null, estimateCents: null }
    }
    const resolvedModel = model ?? PROVIDERS[providerId]?.defaultModel ?? null
    if (CLI_FREE_IDS.has(providerId)) {
      return { providerId, model: resolvedModel, basis: 'subscription' as const, price: null, estimateCents: 0 }
    }
    if (ZERO_COST_IDS.has(providerId)) {
      return { providerId, model: resolvedModel, basis: 'zero-cost' as const, price: null, estimateCents: 0 }
    }
    const price = resolvedModel ? PRICES[normalizeModelId(providerId, resolvedModel)] : undefined
    if (!price) {
      return { providerId, model: resolvedModel, basis: 'unknown' as const, price: null, estimateCents: null }
    }
    const totalUsd = (tokens.inputTokens / 1_000_000) * price.input + (tokens.outputTokens / 1_000_000) * price.output
    return {
      providerId,
      model: resolvedModel,
      basis: 'price' as const,
      price: { input: price.input, output: price.output },
      estimateCents: Math.round(totalUsd * 100),
    }
  })
}
