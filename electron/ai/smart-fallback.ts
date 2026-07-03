import type { ProviderId } from './registry'

// Приоритет провайдеров для автоматического fallback.
// CLI-провайдеры намеренно не включены — они требуют установленных бинарников
// и не имеют quota-ограничений как API.
const FALLBACK_CHAINS: Partial<Record<ProviderId, ProviderId[]>> = {
  'gemini-api': ['claude', 'openai', 'grok'],
  'claude':     ['gemini-api', 'openai', 'grok'],
  'grok':       ['gemini-api', 'claude', 'openai'],
  'openai':     ['claude', 'gemini-api', 'grok'],
  // Cheap/китайские: сначала соседний дешёвый OpenAI-compat (сохраняем бюджет),
  // потом frontier. Раньше deepseek падал сразу на frontier — дорого и не нужно,
  // когда рядом есть qwen/moonshot того же класса.
  'deepseek':   ['qwen', 'moonshot', 'gemini-api', 'claude', 'openai'],
  'moonshot':   ['deepseek', 'qwen', 'gemini-api', 'claude'],
  'qwen':       ['deepseek', 'moonshot', 'gemini-api', 'claude'],
  'mistral':    ['gemini-api', 'claude', 'openai'],
  'groq':       ['deepseek', 'gemini-api', 'claude', 'openai'],
}

// Ошибки при которых стоит пробовать другого провайдера.
const FALLBACK_PATTERNS = [
  'rate_limit', 'rate limit', 'too many requests',
  '429', '500', '502', '503',
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
  'overloaded', 'capacity', 'service unavailable',
  'temporarily unavailable',
]

// Ошибка авторизации провайдера (битый/протухший ключ, отозванная организация —
// как бан Claude 03.07). Один провайдер лёг по ключу → есть смысл уйти на другого
// НАСТРОЕННОГО. Отделено от FALLBACK_PATTERNS: это не транзиент, повтор на том же
// не поможет, но переключение провайдера — поможет.
const AUTH_PATTERNS = [
  '401', '403', 'unauthorized', 'authentication', 'invalid api key',
  'invalid_api_key', 'permission denied', 'api key', 'forbidden',
]

/** Решает, стоит ли переключаться на другого провайдера при этой ошибке. */
export function shouldFallback(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (FALLBACK_PATTERNS.some(p => msg.includes(p.toLowerCase()))) return true
  if (AUTH_PATTERNS.some(p => msg.includes(p))) return true
  const status = (error && typeof error === 'object') ? (error as { status?: unknown }).status : null
  if (status === 401 || status === 403 || status === 429) return true
  // Сетевые ошибки несут код в .code (ECONNRESET/ETIMEDOUT/ECONNREFUSED), а
  // обёрнутая/кастомная ошибка может НЕ содержать текст-паттерн в message — тогда
  // фолбэк ошибочно не срабатывал. Зеркалит isRetriableError (with-retry). (F1, ревью 23.06)
  const code = (error && typeof error === 'object') ? (error as { code?: unknown }).code : null
  if (typeof code === 'string') {
    const c = code.toLowerCase()
    return FALLBACK_PATTERNS.some(p => c.includes(p.toLowerCase()))
  }
  return false
}

/**
 * Класс сбоя, специфичный для агентного tool-loop'а (сверх обычных сетевых/квотных).
 * Нужен, чтобы цикл реагировал по-разному: где-то повторить на той же модели,
 * где-то уйти в JSON-режим tool-calling, где-то сменить модель, где-то спросить юзера.
 */
export type FallbackReason =
  | 'tool_calling_unsupported'  // модель/сервер не принимает `tools`
  | 'malformed_tool_call'       // вызов пришёл, но аргументы — битый JSON
  | 'empty_tool_call_arguments' // вызов есть, arguments пустые/невалидные
  | 'model_ignored_tools'       // ответ прозой, ни одного вызова при агентной задаче
  | 'context_overflow'          // превышено контекстное окно
  | 'provider_auth_error'       // ключ отклонён (401/403)
  | 'provider_rate_limit'       // 429 / quota
  | 'provider_network'          // сеть/таймаут/5xx
  | 'provider_compat_error'     // прочая 4xx-несовместимость запроса
  | 'unknown'

export interface FallbackPlan {
  /** Повторить на ТОЙ ЖЕ модели (транзиент). */
  retrySameModel: boolean
  /** Переключиться на fallback-провайдера/модель. */
  switchModel: boolean
  /** Перейти из native tool-calling в JSON-text режим на той же модели. */
  switchToJsonMode: boolean
  /** Остановить прогон и вернуть понятную ошибку пользователю. */
  askUser: boolean
}

/** Классифицирует ошибку/ситуацию агентного цикла в FallbackReason (чистая логика). */
export function classifyFallbackReason(error: unknown): FallbackReason {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
  const status = (error && typeof error === 'object') ? (error as { status?: unknown }).status : null
  if (/tool|function.?call/.test(msg) && /not supported|unsupported|does not support|no tools|invalid/.test(msg)) {
    return 'tool_calling_unsupported'
  }
  if (/context.?length|maximum context|context_length_exceeded|too many tokens|prompt is too long/.test(msg)) {
    return 'context_overflow'
  }
  if (status === 401 || status === 403 || AUTH_PATTERNS.some(p => msg.includes(p))) return 'provider_auth_error'
  if (status === 429 || /rate.?limit|too.?many.?requests|quota/.test(msg)) return 'provider_rate_limit'
  if (/econnreset|etimedout|econnrefused|timeout|timed.?out|network|fetch failed|socket hang up|\b50[239]\b|overloaded|unavailable/.test(msg)) {
    return 'provider_network'
  }
  if (status === 400 || status === 422 || /\b4(00|22)\b|invalid.?request|bad request/.test(msg)) return 'provider_compat_error'
  return 'unknown'
}

/** Стратегия реакции цикла на класс сбоя. Чистая таблица. */
export function fallbackPlan(reason: FallbackReason): FallbackPlan {
  const P = (retrySameModel: boolean, switchModel: boolean, switchToJsonMode: boolean, askUser: boolean): FallbackPlan =>
    ({ retrySameModel, switchModel, switchToJsonMode, askUser })
  switch (reason) {
    case 'tool_calling_unsupported': return P(false, false, true, false)   // сначала JSON-режим, не менять модель
    case 'malformed_tool_call':      return P(true, false, false, false)   // corrective retry на той же
    case 'empty_tool_call_arguments':return P(true, false, false, false)
    case 'model_ignored_tools':      return P(true, false, true, false)    // nudge + JSON-режим
    case 'context_overflow':         return P(false, false, false, true)   // смена модели не спасёт — компакция/юзер
    case 'provider_auth_error':      return P(false, true, false, false)   // ключ битый → другой провайдер
    case 'provider_rate_limit':      return P(true, true, false, false)
    case 'provider_network':         return P(true, true, false, false)
    case 'provider_compat_error':    return P(false, true, false, false)
    case 'unknown':                  return P(true, false, false, false)
  }
}

/**
 * Возвращает следующего кандидата для fallback.
 * @param current  — текущий провайдер, который упал
 * @param tried    — уже попробованные (включая current)
 * @param configured — провайдеры с настроенными API-ключами
 */
export function getNextFallback(
  current: ProviderId,
  tried: Set<ProviderId>,
  configured: Set<ProviderId>
): ProviderId | null {
  const chain = FALLBACK_CHAINS[current] ?? []
  for (const candidate of chain) {
    if (!tried.has(candidate) && configured.has(candidate)) {
      return candidate
    }
  }
  return null
}
