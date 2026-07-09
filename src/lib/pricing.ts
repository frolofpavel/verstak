/**
 * Best-effort pricing table for cost estimation in the chat header.
 *
 * Prices are USD per million tokens (input / output). Keep this conservative
 * and document where each number came from. CLI providers run on user's
 * subscription so cost is reported as 0.
 *
 * Last updated: 2026-05 (snapshot — adjust as providers publish new pricing).
 */

import type { ProviderId } from '../hooks/useProvider'

interface ModelPrice {
  input: number   // $ per 1M input tokens
  output: number  // $ per 1M output tokens
  cached?: number // $ per 1M cached input tokens (when provider supports caching)
}

const PRICES: Record<string, ModelPrice> = {
  // Anthropic — anthropic.com/pricing
  'claude-sonnet-4-6':  { input: 3.0,  output: 15.0,  cached: 0.3 },
  'claude-opus-4-5':    { input: 15.0, output: 75.0,  cached: 1.5 },
  'claude-sonnet-4-5':  { input: 3.0,  output: 15.0,  cached: 0.3 },
  'claude-haiku-4-5':   { input: 1.0,  output: 5.0,   cached: 0.1 },
  // Google — ai.google.dev/pricing
  'gemini-3-pro':                { input: 2.50, output: 15.0 },   // Gemini 3 Pro
  'gemini-3.5-flash':            { input: 0.30, output: 2.50 },   // Gemini 3.5 Flash (2026-05 release)
  'gemini-3-flash':              { input: 0.30, output: 2.50 },
  'gemini-2.5-pro':              { input: 1.25, output: 10.0 },
  'gemini-2.5-flash':            { input: 0.30, output: 2.50 },
  // OpenAI — openai.com/api/pricing
  'gpt-5':                       { input: 1.25, output: 10.0 },
  'gpt-5-mini':                  { input: 0.25, output: 2.0 },
  'gpt-4o':                      { input: 2.5,  output: 10.0 },
  'gpt-4o-mini':                 { input: 0.15, output: 0.60 },
  'o1':                          { input: 15.0, output: 60.0 },
  'o1-mini':                     { input: 3.0,  output: 12.0 },
  // xAI — docs.x.ai/developers/models
  'grok-4.5':                    { input: 2.00, output: 6.00 },
  // 🇷🇺 YandexGPT — yandex.cloud pricing (₽→$ ~90, консервативно вверх)
  'yandexgpt/latest':            { input: 0.50, output: 0.50 },
  'yandexgpt-32k/latest':        { input: 0.50, output: 0.50 },
  'yandexgpt-lite/latest':       { input: 0.15, output: 0.15 },
  // 🇷🇺 GigaChat — developers.sber.ru (₽→$ ~90, консервативно)
  'GigaChat':                    { input: 0.30, output: 0.30 },
  'GigaChat-Plus':               { input: 0.30, output: 0.30 },
  'GigaChat-Pro':                { input: 1.50, output: 1.50 },
  'GigaChat-Max':                { input: 2.00, output: 2.00 },
  // DeepSeek — api-docs.deepseek.com (V4)
  'deepseek-v4-flash':           { input: 0.28, output: 0.42 },
  'deepseek-v4-pro':             { input: 0.55, output: 2.19 },
  'deepseek-chat':               { input: 0.28, output: 0.42 },
  'deepseek-reasoner':           { input: 0.55, output: 2.19 },
  // Moonshot Kimi — platform.moonshot.ai (K2.7-Code coding-first, релиз 12.06.2026)
  'kimi-k2.7-code':              { input: 0.95, output: 4.00 },
  'kimi-k2.6':                   { input: 0.60, output: 2.50 },
  'kimi-k2.5':                   { input: 0.60, output: 2.50 },
  'moonshot-v1-128k':            { input: 2.00, output: 5.00 },
  'moonshot-v1-32k':             { input: 1.00, output: 3.00 },
  'moonshot-v1-8k':              { input: 0.20, output: 2.00 },
  // Подписочные coding-планы (Kimi Code / GLM Coding Plan) — фикс-цена за месяц,
  // маржинальная цена токена $0 (как CLI-подписки).
  'kimi-for-coding':             { input: 0, output: 0 },
  'glm-5.2':                     { input: 0, output: 0 },
  'glm-5-turbo':                 { input: 0, output: 0 },
  // Qwen (Alibaba DashScope)
  'qwen3-max':                   { input: 1.60, output: 6.40 },
  'qwen3-coder-plus':            { input: 1.00, output: 5.00 },
  'qwen3-coder-flash':           { input: 0.30, output: 1.50 },
  'qwen-max':                    { input: 1.60, output: 6.40 },
  'qwen-plus':                   { input: 0.40, output: 1.20 },
  'qwen-flash':                  { input: 0.05, output: 0.40 },
  // Mistral — mistral.ai/pricing
  'mistral-large-latest':        { input: 2.00, output: 6.00 },
  'mistral-small-latest':        { input: 0.20, output: 0.60 },
  'codestral-latest':            { input: 0.30, output: 0.90 },
  'ministral-8b-latest':         { input: 0.10, output: 0.10 },
  // Groq — groq.com/pricing
  'llama-3.3-70b-versatile':     { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant':        { input: 0.05, output: 0.08 },
  'mixtral-8x7b-32768':          { input: 0.24, output: 0.24 },
  'gemma2-9b-it':                { input: 0.20, output: 0.20 },
  // Ollama (local) — крутится локально, $0 явно
  'llama3.3':                    { input: 0, output: 0 },
  'qwen2.5-coder':               { input: 0, output: 0 },
  'deepseek-r1':                 { input: 0, output: 0 },
  'mistral':                     { input: 0, output: 0 },
  'gemma2':                      { input: 0, output: 0 }
}

const CLI_FREE: Set<ProviderId> = new Set(['gemini-cli', 'claude-cli', 'grok-cli', 'codex-cli'])

/**
 * Нормализует model id перед lookup в PRICES. OpenRouter раздаёт модели с
 * префиксом провайдера ('anthropic/claude-sonnet-4-6') — срезаем его, чтобы
 * матчить базовое имя из таблицы цен. Должно совпадать с cost-guard.ts.
 */
function normalizeModelId(providerId: ProviderId, model: string): string {
  if (providerId === 'openrouter') {
    const slash = model.indexOf('/')
    if (slash >= 0) return model.slice(slash + 1)
  }
  return model
}

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
  cachedInputTokens: number
): CostEstimate {
  if (CLI_FREE.has(providerId)) return { usd: null, cents: 0 }
  const price = PRICES[normalizeModelId(providerId, model)]
  if (!price) return { usd: '—', cents: 0 }
  const billableInput = Math.max(0, inputTokens - cachedInputTokens)
  const inputCost = (billableInput / 1_000_000) * price.input
  const cachedCost = price.cached ? (cachedInputTokens / 1_000_000) * price.cached : 0
  const outputCost = (outputTokens / 1_000_000) * price.output
  const total = inputCost + cachedCost + outputCost
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
  cachedInputTokens: number
): string {
  if (CLI_FREE.has(providerId)) {
    return `Провайдер: ${providerId} (CLI, подписка — стоимость = $0)\nТокены input: ${inputTokens}\nТокены output: ${outputTokens}`
  }
  const price = PRICES[normalizeModelId(providerId, model)]
  if (!price) {
    return `Модель ${model}: цены неизвестны\nТокены input: ${inputTokens}\nТокены output: ${outputTokens}`
  }
  const billableInput = Math.max(0, inputTokens - cachedInputTokens)
  const inputCost = (billableInput / 1_000_000) * price.input
  const cachedCost = price.cached ? (cachedInputTokens / 1_000_000) * price.cached : 0
  const outputCost = (outputTokens / 1_000_000) * price.output
  const total = inputCost + cachedCost + outputCost
  const lines = [
    `Модель: ${model}`,
    `Цена: $${price.input}/M input, $${price.output}/M output${price.cached ? `, $${price.cached}/M cached` : ''}`,
    '',
    `↑ input: ${billableInput.toLocaleString()} × $${price.input}/M = $${inputCost.toFixed(4)}`,
    ...(cachedInputTokens > 0 && price.cached
      ? [`⟲ cached: ${cachedInputTokens.toLocaleString()} × $${price.cached}/M = $${cachedCost.toFixed(4)}`]
      : []),
    `↓ output: ${outputTokens.toLocaleString()} × $${price.output}/M = $${outputCost.toFixed(4)}`,
    `─────`,
    `Итого: $${total.toFixed(4)}`
  ]
  return lines.join('\n')
}
