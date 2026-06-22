/**
 * Exponential backoff с jitter для AI-провайдеров.
 *
 * Источник: V3 рефактор, recommendation #4 из аудита Grok.
 *
 * ПРОБЛЕМА:
 * При длительных агентных сессиях (20-40 turns) один сетевой сбой (HTTP 503),
 * rate limit (HTTP 429) или транзиентный ECONNRESET убивает всю сессию.
 * Пользователь теряет 20 минут работы из-за одной мигнувшей API-ошибки.
 *
 * СТРАТЕГИЯ:
 * Wrap async generator factories with retry-on-initial-failure. Если ошибка
 * случилась ДО первого yield (т.е. на этапе соединения с API), делаем
 * экспоненциальный backoff с jitter и пробуем заново. Если ошибка случилась
 * ПОСЛЕ начала streaming — НЕ повторяем (мы бы дублировали уже выданный
 * пользователю текст).
 *
 * ЧТО СЧИТАЕМ RETRIABLE:
 * - HTTP 429 (rate limit)
 * - HTTP 5xx (server errors)
 * - Network errors: ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, EPIPE
 * - Generic timeout / network в тексте
 *
 * ЧТО НЕ retriable:
 * - 4xx кроме 429 (бизнес-ошибки: auth, validation, bad request)
 * - Anything после первого успешного chunk'а
 */

const MAX_ATTEMPTS = 4
const BASE_DELAY_MS = 800
const MAX_DELAY_MS = 8_000
// Retry-After провайдера авторитетен, но клампим: если провайдер просит ждать
// дольше — выгоднее исчерпать попытки и уйти на smart-fallback, чем висеть.
const RETRY_AFTER_CAP_MS = 30_000

const RETRIABLE_HTTP_CODES = new Set([408, 429, 500, 502, 503, 504, 522, 524])
const RETRIABLE_ERR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'])

interface ErrorWithMaybeStatus {
  status?: number
  statusCode?: number
  code?: string
  message?: string
  cause?: unknown
}

/** Решает, имеет ли смысл ретраить — на основе формы ошибки. */
export function isRetriableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as ErrorWithMaybeStatus
  // HTTP status: anthropic SDK кладёт в status, openai тоже, google в statusCode
  const code = e.status ?? e.statusCode
  if (typeof code === 'number' && RETRIABLE_HTTP_CODES.has(code)) return true
  // Node net errors
  if (typeof e.code === 'string' && RETRIABLE_ERR_CODES.has(e.code)) return true
  // Иногда обёрнуто в cause (fetch undici)
  if (e.cause && typeof e.cause === 'object') {
    const causeCode = (e.cause as ErrorWithMaybeStatus).code
    if (typeof causeCode === 'string' && RETRIABLE_ERR_CODES.has(causeCode)) return true
  }
  // Текстовый fallback: иногда ошибки приходят как строки или без структуры
  if (typeof e.message === 'string') {
    const m = e.message.toLowerCase()
    if (/\b(429|rate.?limit|too.many.requests)\b/.test(m)) return true
    if (/(503|service.unavailable|overloaded|temporarily)/.test(m)) return true
    if (/\b(timeout|timed.out|socket hang up|econnreset)\b/.test(m)) return true
  }
  return false
}

/** Backoff с full jitter (Amazon recipe): wait ∈ [0, base * 2^attempt]. */
function nextDelay(attempt: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** attempt))
  return Math.floor(Math.random() * exp)
}

/** Достаёт заголовок (case-insensitive) из Headers-инстанса или plain-объекта. */
function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null
  const get = (headers as { get?: unknown }).get
  if (typeof get === 'function') {
    const v = (headers as Headers).get(name)
    return v ?? null
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === name) return v == null ? null : String(v)
  }
  return null
}

/**
 * Извлекает Retry-After из ошибки провайдера → задержка в ms (или null).
 * Поддержка: прямые поля retryAfter/retry_after (секунды-число), заголовок
 * `retry-after` секундами (int) ИЛИ HTTP-date. Headers-инстанс и plain-объект.
 */
export function parseRetryAfter(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { headers?: unknown; retryAfter?: unknown; retry_after?: unknown }
  const direct = typeof e.retryAfter === 'number' ? e.retryAfter
    : typeof e.retry_after === 'number' ? e.retry_after : null
  if (direct != null && Number.isFinite(direct) && direct >= 0) return Math.round(direct * 1000)
  const raw = readHeader(e.headers, 'retry-after')
  if (raw == null) return null
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 1000   // секунды
  const dateMs = Date.parse(trimmed)                               // HTTP-date
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
  return null
}

/** Задержка перед ретраем: Retry-After провайдера (клампится) выигрывает над jitter. */
export function computeRetryDelay(attempt: number, err: unknown): number {
  const ra = parseRetryAfter(err)
  if (ra != null) return Math.min(RETRY_AFTER_CAP_MS, ra)
  return nextDelay(attempt)
}

export interface RetryOptions {
  /** Имя для логов. */
  label?: string
  /** Лимит попыток (default 4). */
  maxAttempts?: number
  /** Callback на каждый retry — для UI / observability. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
  /** AbortSignal — если abort сработал, прерываем без retry. */
  signal?: AbortSignal
}

/**
 * Обёртка для async generator (provider.send). Делает retry ТОЛЬКО на initial
 * connection failure. Если первый chunk уже вышел из inner generator — наружу
 * пробрасываем дальше без retry.
 */
export async function* withInitialRetry<T>(
  factory: () => AsyncIterable<T>,
  opts: RetryOptions = {}
): AsyncIterable<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) return
    let firstYielded = false
    try {
      const iter = factory()[Symbol.asyncIterator]()
      while (true) {
        const next = await iter.next()
        if (next.done) return
        firstYielded = true
        yield next.value
      }
    } catch (err) {
      if (firstYielded) {
        // Stream уже стартовал — retry бы дублировал. Пробрасываем.
        throw err
      }
      if (!isRetriableError(err)) throw err
      if (attempt === maxAttempts - 1) throw err
      const delayMs = computeRetryDelay(attempt, err)
      opts.onRetry?.({ attempt, delayMs, error: err })
      await sleep(delayMs, opts.signal)
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
