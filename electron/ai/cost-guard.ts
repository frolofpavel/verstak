/**
 * Hard cost cap для агентских сессий. Если cumulative cost превышает лимит
 * settings.cost_cap_usd_per_session — emit error + abort.
 *
 * Зачем: длинный агент-цикл может пожечь $20-50 если уходит в спираль.
 * Cost controller (UI pill) показывает только постфактум. Этот guard
 * останавливает ДО того как улетит много денег.
 *
 * Источник: V3 Plan раздел 11 «Cost discipline».
 */

import type { ProviderId } from './registry'
import { billableInputTokens, type InputAccounting } from '../../shared/contracts/usage'

export interface ModelPrice {
  input: number
  output: number
  cached?: number
  /** Anthropic 5-minute prompt-cache creation price, USD / 1M tokens. */
  cacheWrite?: number
}

// Цены в $ per 1M tokens. Должны быть синхронизированы с src/lib/pricing.ts.
// Дубликат сознательный — renderer и main не имеют shared modules.
export const PRICES: Record<string, ModelPrice> = {
  'claude-opus-4-5':       { input: 15.0, output: 75.0, cached: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6':     { input: 3.0,  output: 15.0, cached: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5':     { input: 3.0,  output: 15.0, cached: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5':      { input: 1.0,  output: 5.0,  cached: 0.1, cacheWrite: 1.25 },
  'gemini-3-pro':          { input: 2.50, output: 15.0 },
  'gemini-3.5-flash':      { input: 0.30, output: 2.50 },
  'gemini-3-flash':        { input: 0.30, output: 2.50 },
  'gemini-2.5-pro':        { input: 1.25, output: 10.0 },
  'gemini-2.5-flash':      { input: 0.30, output: 2.50 },
  'gpt-5':                 { input: 1.25, output: 10.0 },
  'gpt-5-mini':            { input: 0.25, output: 2.0 },
  'gpt-4o':                { input: 2.5,  output: 10.0 },
  'gpt-4o-mini':           { input: 0.15, output: 0.60 },
  'o1':                    { input: 15.0, output: 60.0 },
  'o1-mini':               { input: 3.0,  output: 12.0 },
  'grok-4.5':              { input: 2.00, output: 6.00 },
  // 🇷🇺 YandexGPT — yandex.cloud/ru/docs/foundation-models/pricing (₽→$ по ~90,
  //  округлено консервативно вверх). Lite дешевле Pro.
  'yandexgpt/latest':      { input: 0.50, output: 0.50 },
  'yandexgpt-32k/latest':  { input: 0.50, output: 0.50 },
  'yandexgpt-lite/latest': { input: 0.15, output: 0.15 },
  // 🇷🇺 GigaChat — developers.sber.ru/docs (тарификация в токенах; ₽→$ ~90,
  //  консервативная оценка). Max/Pro дороже базового.
  'GigaChat':              { input: 0.30, output: 0.30 },
  'GigaChat-Plus':         { input: 0.30, output: 0.30 },
  'GigaChat-Pro':          { input: 1.50, output: 1.50 },
  'GigaChat-Max':          { input: 2.00, output: 2.00 },
  // DeepSeek — api-docs.deepseek.com/quick_start/pricing (V4, дёшево).
  'deepseek-v4-flash':     { input: 0.28, output: 0.42 },
  'deepseek-v4-pro':       { input: 0.55, output: 2.19 },
  'deepseek-chat':         { input: 0.28, output: 0.42 },
  'deepseek-reasoner':     { input: 0.55, output: 2.19 },
  // Moonshot Kimi — platform.moonshot.ai (K2.7-Code coding-first; K2.6 флагман; v1-* по контексту).
  'kimi-k2.7-code':        { input: 0.95, output: 4.00 },
  'kimi-k2.6':             { input: 0.60, output: 2.50 },
  'kimi-k2.5':             { input: 0.60, output: 2.50 },
  'moonshot-v1-128k':      { input: 2.00, output: 5.00 },
  'moonshot-v1-32k':       { input: 1.00, output: 3.00 },
  'moonshot-v1-8k':        { input: 0.20, output: 2.00 },
  // Qwen (Alibaba DashScope) — alibabacloud.com/help/model-studio.
  'qwen3-max':             { input: 1.60, output: 6.40 },
  'qwen3-coder-plus':      { input: 1.00, output: 5.00 },
  'qwen3-coder-flash':     { input: 0.30, output: 1.50 },
  'qwen-max':              { input: 1.60, output: 6.40 },
  'qwen-plus':             { input: 0.40, output: 1.20 },
  'qwen-flash':            { input: 0.05, output: 0.40 },
  // Mistral — mistral.ai/pricing.
  'mistral-large-latest':  { input: 2.00, output: 6.00 },
  'mistral-small-latest':  { input: 0.20, output: 0.60 },
  'codestral-latest':      { input: 0.30, output: 0.90 },
  'ministral-8b-latest':   { input: 0.10, output: 0.10 },
  // Groq — groq.com/pricing (LPU-инференс на open-source моделях, дёшево).
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant':    { input: 0.05, output: 0.08 },
  'mixtral-8x7b-32768':      { input: 0.24, output: 0.24 },
  'gemma2-9b-it':            { input: 0.20, output: 0.20 },
  // Ollama (local) — модели крутятся локально, денег не стоят. Явно $0,
  //  чтобы это была ОСОЗНАННАЯ бесплатность, а не «неизвестная модель».
  'llama3.3':              { input: 0, output: 0 },
  'qwen2.5-coder':         { input: 0, output: 0 },
  'deepseek-r1':           { input: 0, output: 0 },
  'mistral':               { input: 0, output: 0 },
  'gemma2':                { input: 0, output: 0 }
}

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

/**
 * Нормализует model id перед lookup в PRICES. OpenRouter раздаёт модели с
 * префиксом провайдера ('anthropic/claude-sonnet-4-6', 'openai/gpt-5', …) —
 * срезаем его, чтобы матчить базовое имя из PRICES.
 */
export function normalizeModelId(providerId: ProviderId, model: string): string {
  if (providerId === 'openrouter') {
    const slash = model.indexOf('/')
    if (slash >= 0) return model.slice(slash + 1)
  }
  return model
}

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
      const cachedCost = price.cached ? ((cached ?? 0) / 1_000_000) * price.cached : 0
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
