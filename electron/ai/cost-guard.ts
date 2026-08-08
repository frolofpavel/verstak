/**
 * Hard cost cap для агентских сессий. Если cumulative cost превышает лимит
 * settings.cost_cap_usd_per_session — emit error + abort.
 *
 * Зачем: длинный агент-цикл может пожечь $20-50 если уходит в спираль.
 * Cost controller (UI pill) показывает только постфактум. Этот guard
 * останавливает ДО того как улетит много денег.
 *
 * Источник: V3 Plan раздел 11 «Cost discipline».
 *
 * Таблица цен PRICES и normalizeModelId переехали в shared/contracts/pricing.ts —
 * ЕДИНЫЙ источник с renderer-слоем (src/lib/pricing.ts), дубль убран (расходиться
 * нечему). Ре-экспортируем их отсюда для обратной совместимости (agent-run-usage.ts).
 */

import type { ProviderId } from './registry'
import { billableInputTokens, cachedTokenRate, type InputAccounting } from '../../shared/contracts/usage'
import { PRICES, normalizeModelId, type ModelPrice } from '../../shared/contracts/pricing'

export { PRICES, normalizeModelId }
export type { ModelPrice }

// Fail-safe тариф для НЕИЗВЕСТНОЙ модели при ВКЛЮЧЁННОМ cap. Берём как у дорогой
// модели (claude-sonnet), чтобы рой субов на незнакомой модели не жёг деньги
// без счёта. Без cap (capCents == null) этот тариф не применяется — поведение
// прежнее («не считаем»).
export const FALLBACK_PRICE: ModelPrice = { input: 3.0, output: 15.0, cached: 0.3 }

export const CLI_FREE: Set<ProviderId> = new Set(['gemini-cli', 'claude-cli', 'grok-cli', 'codex-cli'])

// Провайдеры, где стоимость заведомо $0 (локальный inference / собственный
// endpoint без известного тарифа). Их неизвестные модели НЕ попадают под
// fail-safe — они осознанно бесплатные, а не «непосчитанные».
export const ZERO_COST_PROVIDERS: Set<ProviderId> = new Set(['ollama', 'custom-openai'])

export interface CostGuard {
  /** Накопить usage и проверить cap. Возвращает true если превышено → abort.
   *  2.0.8-E commit 2: input/output/cached — nullable (null='провайдер не сообщил', НЕ 0, каветат #1);
   *  inputAccounting задаёт, вычитать ли cached (billableInputTokens — единое место, фикс дефекта B).
   *  Дефолт inputAccounting='inclusive' сохраняет прежнее поведение для старых вызовов без флага. */
  recordAndCheck(
    providerId: ProviderId, model: string,
    input: number | null, output: number | null, cached: number | null,
    inputAccounting?: InputAccounting,
    cacheWrite?: number | null,
  ): {
    exceeded: boolean
    cents: number
    capCents: number | null
    message?: string
  }
  /** Текущая накопленная стоимость в центах. */
  current(): number
}

interface CostGuardOptions {
  initialCents?: number
  onDailyCentsChange?: (cents: number) => void
  periodLabel?: string
}

/**
 * @param capUsd максимум $ за сессию. Null/0 = guard disabled (поведение прежнее).
 */
export function createCostGuard(capUsd: number | null, options: CostGuardOptions = {}): CostGuard {
  const capCents = capUsd && capUsd > 0 ? Math.round(capUsd * 100) : null
  // Аккумулируем ДРОБНЫЕ центы как float — иначе дешёвые ходы роёв (когда
  // total*100 < 1) округлялись бы в 0 на каждом событии, и cap не взводился
  // бы никогда. Округляем только при выдаче наружу (current() / cents).
  const initialCents = Math.max(0, options.initialCents ?? 0)
  let cumulativeCents = 0
  const periodLabel = options.periodLabel ?? 'сессию'
  const totalCents = () => initialCents + cumulativeCents
  const reportDailyCents = () => options.onDailyCentsChange?.(Math.round(totalCents()))

  return {
    recordAndCheck(providerId, model, input, output, cached, inputAccounting, cacheWrite) {
      if (CLI_FREE.has(providerId)) {
        // CLI = подписка, $0
        return { exceeded: false, cents: Math.round(cumulativeCents), capCents }
      }
      if (ZERO_COST_PROVIDERS.has(providerId)) {
        // Локальный / собственный endpoint без тарифа — осознанно $0.
        return { exceeded: false, cents: Math.round(cumulativeCents), capCents }
      }
      // 2.0.8-E: billable-input через ЕДИНЫЙ helper (фикс дефекта B: exclusive НЕ вычитает cached).
      const billable = billableInputTokens({ inputTokens: input, cacheReadTokens: cached, inputAccounting: inputAccounting ?? 'inclusive' })
      // Каветат #4: usage целиком не сообщён (null) → «нет данных»: НЕ считаем $0 и НЕ блокируем.
      if (billable == null && output == null && cached == null && cacheWrite == null) {
        return { exceeded: false, cents: Math.round(cumulativeCents), capCents }
      }
      const lookup = normalizeModelId(providerId, model)
      let price = PRICES[lookup]
      if (!price) {
        // fail-safe: при ВЫКЛЮЧЕННОМ cap неизвестную модель не считаем (прежнее
        // поведение). При ВКЛЮЧЁННОМ cap считаем по консервативному тарифу,
        // чтобы рой субов на незнакомой модели не жёг деньги без счёта.
        if (capCents == null) {
          return { exceeded: false, cents: Math.round(cumulativeCents), capCents }
        }
        price = FALLBACK_PRICE
      }
      const inputCost = ((billable ?? 0) / 1_000_000) * price.input
      // ЗАДАЧА A: неизвестна цена кэша → полная цена input (не ноль). См. cachedTokenRate.
      const cachedCost = ((cached ?? 0) / 1_000_000) * cachedTokenRate(price.cached, price.input)
      const cacheWriteCost = price.cacheWrite ? ((cacheWrite ?? 0) / 1_000_000) * price.cacheWrite : 0
      const outputCost = ((output ?? 0) / 1_000_000) * price.output
      const total = inputCost + cachedCost + cacheWriteCost + outputCost
      cumulativeCents += total * 100
      reportDailyCents()

      if (capCents != null && totalCents() >= capCents) {
        const shownCents = Math.round(totalCents())
        return {
          exceeded: true,
          cents: shownCents,
          capCents,
          message: `За ${periodLabel} израсходовано $${(totalCents() / 100).toFixed(2)} (лимит $${(capCents / 100).toFixed(2)}). ` +
                   `Verstak остановил выполнение по лимиту расходов. Подними лимит или продолжи после сброса счётчика.`
        }
      }
      return { exceeded: false, cents: Math.round(cumulativeCents), capCents }
    },
    current() {
      return Math.round(cumulativeCents)
    }
  }
}
