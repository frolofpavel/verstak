/**
 * Best-effort pricing table for cost estimation in the chat header.
 *
 * Таблица цен и normalizeModelId переехали в shared/contracts/pricing.ts — ЕДИНЫЙ
 * источник с main-слоем (electron/ai/cost-guard.ts), дубль убран (расходиться нечему).
 * Здесь — расчёт стоимости поверх общей таблицы (estimateCost / costBreakdown /
 * costSeverity). Ре-экспортируем PRICES/ModelPrice для обратной совместимости.
 * CLI-провайдеры идут по подписке, поэтому их стоимость репортится как 0.
 */

import type { ProviderId } from '../hooks/useProvider'
import { billableInputTokens, cachedTokenRate, type InputAccounting } from '../../shared/contracts/usage'
import { PRICES, normalizeModelId, OWN_ENDPOINT_PROVIDERS, type ModelPrice } from '../../shared/contracts/pricing'

export { PRICES }
export type { ModelPrice }

const CLI_FREE: Set<ProviderId> = new Set(['gemini-cli', 'claude-cli', 'grok-cli', 'codex-cli'])

export interface CostEstimate {
  /** Total USD, formatted as a string. null when provider is CLI (covered by subscription). */
  usd: string | null
  /** Approximate cents value for logic checks (0 for CLI). */
  cents: number
}

export function estimateCost(
  providerId: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  // 2.0.8-E: default 'inclusive' сохраняет прежнее поведение для вызовов без флага (Chat.tsx —
  // вне allowlist E, покажет корректную Claude-стоимость после проброса inputAccounting пост-Ilya).
  inputAccounting: InputAccounting = 'inclusive',
  cacheWriteTokens = 0,
): CostEstimate {
  if (CLI_FREE.has(providerId)) return { usd: null, cents: 0 }
  // C8: свой endpoint (локальный inference / чужой OpenAI-совместимый прокси) —
  // публичная таблица цен к нему НЕ применяется. Без этой проверки достаточно
  // назвать модель прокси знакомым именем («gpt-4o»), чтобы человеку показались
  // доллары по тарифу OpenAI за его собственный сервер, — при том что страж
  // лимита и журнал расхода считают те же токены бесплатными. Ответ здесь тот же,
  // что уже даёт main ($0 при известной цене), чтобы не завести третий.
  if (OWN_ENDPOINT_PROVIDERS.has(providerId)) return { usd: '$0.00', cents: 0 }
  const price = PRICES[normalizeModelId(providerId, model)]
  if (!price) return { usd: '—', cents: 0 }
  const billableInput = billableInputTokens({ inputTokens, cacheReadTokens: cachedInputTokens, inputAccounting }) ?? 0
  const inputCost = (billableInput / 1_000_000) * price.input
  const cachedCost = (cachedInputTokens / 1_000_000) * cachedTokenRate(price.cached, price.input)
  const cacheWriteCost = price.cacheWrite ? (cacheWriteTokens / 1_000_000) * price.cacheWrite : 0
  const outputCost = (outputTokens / 1_000_000) * price.output
  const total = inputCost + cachedCost + cacheWriteCost + outputCost
  const cents = Math.round(total * 100)
  let usd: string
  if (total < 0.01) usd = '<$0.01'
  else if (total < 1) usd = '$' + total.toFixed(2)
  else if (total < 100) usd = '$' + total.toFixed(2)
  else usd = '$' + total.toFixed(0)
  return { usd, cents }
}

/**
 * Cost severity для цветовой индикации pill: «спокойно / задумайся / стоп».
 * Пороги выбраны под типичную dev-сессию (мелкие правки): 50¢ — норма,
 * $2 — пора смотреть что происходит, $5+ — наверняка цикл / большой rip.
 *
 * Возвращает CSS-class suffix: '' / 'is-warn' / 'is-alert'.
 */
export type CostSeverity = '' | 'is-warn' | 'is-alert'
export function costSeverity(cents: number): CostSeverity {
  if (cents >= 500) return 'is-alert'  // $5+
  if (cents >= 200) return 'is-warn'   // $2+
  return ''
}

/**
 * Детальный breakdown для tooltip: разбивка стоимости на input / cached /
 * output, плюс цена за модель. Возвращает многострочный текст для title.
 */
export function costBreakdown(
  providerId: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  inputAccounting: InputAccounting = 'inclusive',
  cacheWriteTokens = 0,
): string {
  if (CLI_FREE.has(providerId)) {
    return `Провайдер: ${providerId} (CLI, подписка — стоимость = $0)\nТокены input: ${inputTokens}\nТокены output: ${outputTokens}`
  }
  // C8: причина названа прямо. Прочерк или голый $0 человек прочитал бы как сбой
  // счётчика; здесь сказано, что тариф своего endpoint'а продукту неизвестен и
  // публичные цены к нему не применяются.
  if (OWN_ENDPOINT_PROVIDERS.has(providerId)) {
    return `Провайдер: ${providerId} — свой endpoint, тариф неизвестен продукту.\n`
      + `Публичная таблица цен к нему не применяется, расход считается как $0.\n`
      + `Токены input: ${inputTokens}\nТокены output: ${outputTokens}`
  }
  const price = PRICES[normalizeModelId(providerId, model)]
  if (!price) {
    return `Модель ${model}: цены неизвестны\nТокены input: ${inputTokens}\nТокены output: ${outputTokens}`
  }
  const billableInput = billableInputTokens({ inputTokens, cacheReadTokens: cachedInputTokens, inputAccounting }) ?? 0
  const inputCost = (billableInput / 1_000_000) * price.input
  // Ставка кэша ОДНА и та же для суммы и для строки разбивки. Раньше сумма считалась
  // через cachedTokenRate (правило «неизвестна цена → по input»), а строка показывалась
  // только при price.cached — на DeepSeek/Kimi кэш попадал в «Итого», но не в видимые
  // строки, и итог не сходился с тем, что человек видит. Половина собственного фикса.
  const cachedRate = cachedTokenRate(price.cached, price.input)
  const cachedCost = (cachedInputTokens / 1_000_000) * cachedRate
  const cacheWriteCost = price.cacheWrite ? (cacheWriteTokens / 1_000_000) * price.cacheWrite : 0
  const outputCost = (outputTokens / 1_000_000) * price.output
  const total = inputCost + cachedCost + cacheWriteCost + outputCost
  const lines = [
    `Модель: ${model}`,
    `Цена: $${price.input}/M input, $${price.output}/M output${price.cached ? `, $${price.cached}/M cache read` : ''}${price.cacheWrite ? `, $${price.cacheWrite}/M cache write` : ''}`,
    '',
    `↑ input: ${billableInput.toLocaleString()} × $${price.input}/M = $${inputCost.toFixed(4)}`,
    ...(cachedInputTokens > 0
      ? [`⟲ cached: ${cachedInputTokens.toLocaleString()} × $${cachedRate}/M = $${cachedCost.toFixed(4)}`
         + (price.cached == null ? ' (цена кэша неизвестна — считаем по input)' : '')]
      : []),
    ...(cacheWriteTokens > 0 && price.cacheWrite
      ? [`⇧ cache write: ${cacheWriteTokens.toLocaleString()} × $${price.cacheWrite}/M = $${cacheWriteCost.toFixed(4)}`]
      : []),
    `↓ output: ${outputTokens.toLocaleString()} × $${price.output}/M = $${outputCost.toFixed(4)}`,
    `─────`,
    `Итого: $${total.toFixed(4)}`
  ]
  return lines.join('\n')
}
