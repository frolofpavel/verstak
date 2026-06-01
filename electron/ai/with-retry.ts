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
      const delayMs = nextDelay(attempt)
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
