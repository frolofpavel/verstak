import { describe, it, expect, vi } from 'vitest'
import { isRetriableError, withInitialRetry, parseRetryAfter, computeRetryDelay } from '../../electron/ai/with-retry'

describe('isRetriableError', () => {
  it('429 → retriable', () => {
    expect(isRetriableError({ status: 429 })).toBe(true)
    expect(isRetriableError({ statusCode: 429 })).toBe(true)
  })

  it('5xx → retriable (только список: 500/502/503/504/522/524)', () => {
    expect(isRetriableError({ status: 500 })).toBe(true)
    expect(isRetriableError({ status: 503 })).toBe(true)
    expect(isRetriableError({ status: 504 })).toBe(true)
    expect(isRetriableError({ status: 522 })).toBe(true)
  })

  it('4xx (не 429) → NOT retriable', () => {
    expect(isRetriableError({ status: 400 })).toBe(false)
    expect(isRetriableError({ status: 401 })).toBe(false)
    expect(isRetriableError({ status: 403 })).toBe(false)
    expect(isRetriableError({ status: 404 })).toBe(false)
  })

  it('node net codes → retriable', () => {
    expect(isRetriableError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetriableError({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isRetriableError({ code: 'ENOTFOUND' })).toBe(true)
  })

  it('wrapped in cause (undici fetch) → retriable', () => {
    expect(isRetriableError({ message: 'fetch failed', cause: { code: 'ECONNRESET' } })).toBe(true)
  })

  it('textual fallback (RU/EN substrings)', () => {
    expect(isRetriableError(new Error('Rate limit exceeded'))).toBe(true)
    expect(isRetriableError(new Error('Service Unavailable'))).toBe(true)
    expect(isRetriableError(new Error('socket hang up'))).toBe(true)
    expect(isRetriableError(new Error('overloaded_error'))).toBe(true)
  })

  it('обычная application-ошибка → NOT retriable', () => {
    expect(isRetriableError(new Error('Invalid argument'))).toBe(false)
    expect(isRetriableError({ status: 422, message: 'validation' })).toBe(false)
  })

  it('null / undefined / strings → NOT retriable', () => {
    expect(isRetriableError(null)).toBe(false)
    expect(isRetriableError(undefined)).toBe(false)
    expect(isRetriableError('boom')).toBe(false)
  })
})

describe('withInitialRetry', () => {
  it('успех с первой попытки — никакого retry', async () => {
    const factory = vi.fn(async function* () {
      yield 'a'
      yield 'b'
    })
    const out: string[] = []
    for await (const v of withInitialRetry(factory)) out.push(v)
    expect(out).toEqual(['a', 'b'])
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('retry при retriable error до первого yield', async () => {
    let attempt = 0
    const factory = vi.fn(async function* () {
      attempt++
      if (attempt < 3) {
        const err: Error & { status?: number } = new Error('rate limit')
        err.status = 429
        throw err
      }
      yield 'finally'
    })
    const out: string[] = []
    for await (const v of withInitialRetry(factory, { maxAttempts: 4 })) out.push(v)
    expect(out).toEqual(['finally'])
    expect(factory).toHaveBeenCalledTimes(3)
  })

  it('НЕ retry если ошибка ПОСЛЕ первого yield (стрим уже стартовал)', async () => {
    const factory = vi.fn(async function* () {
      yield 'first'
      const err: Error & { status?: number } = new Error('rate limit')
      err.status = 429
      throw err
    })
    const out: string[] = []
    let caught: unknown = null
    try {
      for await (const v of withInitialRetry(factory)) out.push(v)
    } catch (e) {
      caught = e
    }
    expect(out).toEqual(['first'])
    expect((caught as Error).message).toBe('rate limit')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('НЕ retry если ошибка non-retriable', async () => {
    const factory = vi.fn(async function* () {
      const err: Error & { status?: number } = new Error('bad request')
      err.status = 400
      throw err
      yield 'unreachable'
    })
    let caught: unknown = null
    try {
      for await (const _ of withInitialRetry(factory)) { /* */ }
    } catch (e) { caught = e }
    expect((caught as Error).message).toBe('bad request')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('исчерпывает попытки если все падают, выбрасывает последнюю ошибку', async () => {
    const factory = vi.fn(async function* () {
      const err: Error & { status?: number } = new Error('503')
      err.status = 503
      throw err
      yield 'never'
    })
    let caught: unknown = null
    try {
      for await (const _ of withInitialRetry(factory, { maxAttempts: 3 })) { /* */ }
    } catch (e) { caught = e }
    expect((caught as Error).message).toBe('503')
    expect(factory).toHaveBeenCalledTimes(3)
  })

  it('вызывает onRetry callback на каждую попытку', async () => {
    let attempt = 0
    const factory = vi.fn(async function* () {
      attempt++
      if (attempt < 2) {
        const err: Error & { status?: number } = new Error('rate')
        err.status = 429
        throw err
      }
      yield 'ok'
    })
    const retries: Array<{ attempt: number }> = []
    for await (const _ of withInitialRetry(factory, {
      onRetry: info => retries.push({ attempt: info.attempt })
    })) { /* */ }
    expect(retries).toHaveLength(1)
    expect(retries[0].attempt).toBe(0)
  })
})

// Retry-After (конкурентный разбор OpenCode): провайдер в заголовке говорит,
// сколько ждать — раньше игнорировали (jitter ретраил слишком рано, жёг попытки).
describe('parseRetryAfter / computeRetryDelay', () => {
  it('заголовок retry-after секундами → ms', () => {
    expect(parseRetryAfter({ headers: { 'retry-after': '5' } })).toBe(5000)
    expect(parseRetryAfter({ headers: { 'Retry-After': '0' } })).toBe(0)
  })
  it('Headers-инстанс, case-insensitive', () => {
    const h = new Headers(); h.set('Retry-After', '3')
    expect(parseRetryAfter({ headers: h })).toBe(3000)
  })
  it('прямые поля retryAfter/retry_after (секунды)', () => {
    expect(parseRetryAfter({ retryAfter: 2 })).toBe(2000)
    expect(parseRetryAfter({ retry_after: 1.5 })).toBe(1500)
  })
  it('HTTP-date → ms от now (примерно)', () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    const ms = parseRetryAfter({ headers: { 'retry-after': future } })!
    expect(ms).toBeGreaterThan(8_000)
    expect(ms).toBeLessThanOrEqual(10_000)
  })
  it('нет заголовка / мусор / не-объект → null', () => {
    expect(parseRetryAfter({ status: 429 })).toBeNull()
    expect(parseRetryAfter({ headers: { 'retry-after': 'скоро' } })).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('строка')).toBeNull()
  })
  it('computeRetryDelay: Retry-After выигрывает над jitter (детерминирован)', () => {
    // jitter для attempt 0 ∈ [0,800); 7000 невозможно из jitter → точно из заголовка
    expect(computeRetryDelay(0, { headers: { 'retry-after': '7' } })).toBe(7000)
  })
  it('computeRetryDelay: огромный Retry-After клампится до 30с', () => {
    expect(computeRetryDelay(0, { headers: { 'retry-after': '9999' } })).toBe(30_000)
  })
  it('computeRetryDelay: без Retry-After → jitter в окне attempt 0', () => {
    const d = computeRetryDelay(0, { status: 503 })
    expect(d).toBeGreaterThanOrEqual(0)
    expect(d).toBeLessThan(800)
  })
})
