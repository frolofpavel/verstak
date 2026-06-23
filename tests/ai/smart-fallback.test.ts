import { describe, it, expect } from 'vitest'
import { shouldFallback } from '../../electron/ai/smart-fallback'

describe('shouldFallback', () => {
  it('матчит по тексту message (rate limit / 5xx)', () => {
    expect(shouldFallback(new Error('503 service unavailable'))).toBe(true)
    expect(shouldFallback(new Error('Rate limit exceeded'))).toBe(true)
    expect(shouldFallback('overloaded')).toBe(true)
  })

  it('не фолбэкает бизнес-ошибки (auth/validation)', () => {
    expect(shouldFallback(new Error('invalid api key'))).toBe(false)
    expect(shouldFallback(new Error('bad request: missing field'))).toBe(false)
  })

  // Ревью 23.06 (F1): сетевые ошибки несут код в .code (ECONNRESET и т.п.).
  // Обёрнутая/кастомная ошибка может НЕ содержать паттерн в message — раньше
  // shouldFallback смотрел только message и пропускал такой фолбэк.
  it('матчит по error.code даже если message без паттерна', () => {
    const econn = Object.assign(new Error('socket failure'), { code: 'ECONNRESET' })
    expect(shouldFallback(econn)).toBe(true)
    const etimeout = Object.assign(new Error('network glitch'), { code: 'ETIMEDOUT' })
    expect(shouldFallback(etimeout)).toBe(true)
  })

  it('не матчит по нерелевантному коду', () => {
    const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    expect(shouldFallback(enoent)).toBe(false)
  })
})
