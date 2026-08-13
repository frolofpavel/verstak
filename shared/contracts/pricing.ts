/**
 * Единая таблица цен моделей + normalizeModelId — ОДИН источник для renderer
 * (src/lib/pricing.ts) и main (electron/ai/cost-guard.ts). Оба слоя ре-экспортируют.
 *
 * Раньше таблица дублировалась в обоих слоях и разошлась по СОСТАВУ (55 записей против
 * 52 — main не хватало kimi-for-coding, glm-5.2, glm-5-turbo): при ВКЛЮЧЁННОМ лимите
 * расхода эти $0-подписочные модели падали в FALLBACK_PRICE ($3/$15) — экран показывал
 * $0, а страж лимита копил деньги на том, что ничего не стоит. Держал синхронность
 * анти-дрейф-пин; переезд в shared/ убирает саму возможность дрейфа (пин снят как
 * тавтология). Прецедент: cachedTokenRate уже живёт в shared/contracts/usage.ts.
 *
 * ЦЕНЫ — ЭТО ДЕНЬГИ. Их состав и значения меняет ТОЛЬКО Павел. Здесь — только перенос
 * дубля в один дом, значения байт-в-байт как были в обеих копиях.
 *
 * Цены в USD per 1M tokens (input / output). CLI-провайдеры идут по подписке → стоимость
 * репортится как 0 отдельно (CLI_FREE в слоях). Snapshot 2026-05 — правится по мере
 * публикации новых тарифов провайдерами.
 */

/**
 * Провайдеры, работающие через СВОЙ endpoint: локальный inference или чужой
 * OpenAI-совместимый прокси. Публичная таблица цен к ним НЕ применяется — за их
 * токенами стоит не тариф вендора, а собственный сервер человека.
 *
 * Живёт здесь, а не в main (C8, 13.08). Набор был только в `cost-guard.ts`, и
 * экран про него не знал: достаточно назвать модель своего прокси знакомым именем
 * (`gpt-4o` — обычное дело для OpenAI-совместимого прокси), и человеку рисовались
 * доллары по тарифу OpenAI за чужой сервер, пока страж лимита считал те же токены
 * бесплатными. Ровно тот дрейф, ради которого сюда уже переехала сама таблица
 * PRICES (см. шапку выше: «экран показывал $0, а страж копил деньги»), только
 * зеркальный.
 *
 * СОСТАВ НАБОРА — ДЕНЬГИ, как и цены: меняет только Павел.
 */
export const OWN_ENDPOINT_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'custom-openai'])

export interface ModelPrice {
  input: number       // $ per 1M input tokens
  output: number      // $ per 1M output tokens
  cached?: number     // $ per 1M cached input tokens (when provider supports caching)
  cacheWrite?: number // $ per 1M 5-minute cache creation tokens
}

export const PRICES: Record<string, ModelPrice> = {
  // Anthropic — anthropic.com/pricing
  'claude-sonnet-4-6':  { input: 3.0,  output: 15.0,  cached: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-5':    { input: 15.0, output: 75.0,  cached: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-5':  { input: 3.0,  output: 15.0,  cached: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5':   { input: 1.0,  output: 5.0,   cached: 0.1, cacheWrite: 1.25 },
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

/**
 * Нормализует model id перед lookup в PRICES. OpenRouter раздаёт модели с префиксом
 * провайдера ('anthropic/claude-sonnet-4-6') — срезаем его, чтобы матчить базовое имя
 * из таблицы цен. providerId принимаем как строку: shared не тянет ни renderer-ный
 * (useProvider), ни main-ный (registry) union ProviderId — оба надмножества string,
 * а сравнение здесь только со строковым литералом 'openrouter'.
 */
export function normalizeModelId(providerId: string, model: string): string {
  if (providerId === 'openrouter') {
    const slash = model.indexOf('/')
    if (slash >= 0) return model.slice(slash + 1)
  }
  return model
}
