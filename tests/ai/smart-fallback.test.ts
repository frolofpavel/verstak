import { describe, it, expect } from 'vitest'
import { shouldFallback, classifyFallbackReason, fallbackPlan } from '../../electron/ai/smart-fallback'

describe('shouldFallback', () => {
  it('матчит по тексту message (rate limit / 5xx)', () => {
    expect(shouldFallback(new Error('503 service unavailable'))).toBe(true)
    expect(shouldFallback(new Error('Rate limit exceeded'))).toBe(true)
    expect(shouldFallback('overloaded')).toBe(true)
  })

  // Изменение поведения (hardening 03.07): auth-ошибка (битый/отозванный ключ —
  // как бан Claude) теперь ТРИГГЕРИТ фолбэк на другого настроенного провайдера.
  // Повтор на том же бесполезен, но соседний провайдер может спасти прогон.
  it('фолбэкает на auth-ошибке (ключ отклонён → другой провайдер)', () => {
    expect(shouldFallback(new Error('invalid api key'))).toBe(true)
    expect(shouldFallback(Object.assign(new Error('nope'), { status: 401 }))).toBe(true)
    expect(shouldFallback(Object.assign(new Error('forbidden'), { status: 403 }))).toBe(true)
  })

  it('не фолбэкает чистую validation-ошибку (bad request)', () => {
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

describe('classifyFallbackReason', () => {
  it('распознаёт классы агентного цикла', () => {
    expect(classifyFallbackReason(new Error('this model does not support tools'))).toBe('tool_calling_unsupported')
    expect(classifyFallbackReason(new Error('maximum context length exceeded'))).toBe('context_overflow')
    expect(classifyFallbackReason(Object.assign(new Error('x'), { status: 401 }))).toBe('provider_auth_error')
    expect(classifyFallbackReason(Object.assign(new Error('x'), { status: 429 }))).toBe('provider_rate_limit')
    expect(classifyFallbackReason(new Error('ECONNRESET socket hang up'))).toBe('provider_network')
    expect(classifyFallbackReason(Object.assign(new Error('bad request'), { status: 400 }))).toBe('provider_compat_error')
    expect(classifyFallbackReason(new Error('что-то непонятное'))).toBe('unknown')
  })
})

describe('fallbackPlan', () => {
  it('tool_calling_unsupported → JSON-режим, не смена модели', () => {
    const p = fallbackPlan('tool_calling_unsupported')
    expect(p.switchToJsonMode).toBe(true)
    expect(p.switchModel).toBe(false)
  })
  it('provider_auth_error → смена провайдера, без повтора на том же', () => {
    const p = fallbackPlan('provider_auth_error')
    expect(p.switchModel).toBe(true)
    expect(p.retrySameModel).toBe(false)
  })
  it('malformed_tool_call → corrective retry на той же модели', () => {
    const p = fallbackPlan('malformed_tool_call')
    expect(p.retrySameModel).toBe(true)
    expect(p.switchModel).toBe(false)
  })
  it('context_overflow → спросить пользователя (смена модели не спасёт)', () => {
    expect(fallbackPlan('context_overflow').askUser).toBe(true)
  })
})
