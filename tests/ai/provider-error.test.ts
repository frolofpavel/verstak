import { describe, it, expect } from 'vitest'
import { classifyProviderError } from '../../electron/ai/provider-error'

// Классификатор ошибок провайдера (конкурентный разбор OpenCode): сырое «429» /
// «AuthenticationError» юзеру непонятно — нужна категория + понятный совет.
describe('classifyProviderError', () => {
  it('429 → rate_limit, retriable, RU-сообщение про лимит', () => {
    const c = classifyProviderError({ status: 429, message: 'Rate limit exceeded' })
    expect(c.category).toBe('rate_limit')
    expect(c.retriable).toBe(true)
    expect(c.userMessage).toMatch(/лимит запросов/i)
  })
  it('503 overloaded → overloaded, retriable', () => {
    const c = classifyProviderError({ status: 503, message: 'overloaded' })
    expect(c.category).toBe('overloaded')
    expect(c.retriable).toBe(true)
  })
  it('401 → auth, НЕ retriable, совет про ключ', () => {
    const c = classifyProviderError({ status: 401, message: 'Unauthorized' })
    expect(c.category).toBe('auth')
    expect(c.retriable).toBe(false)
    expect(c.userMessage).toMatch(/ключ/i)
  })
  it('context length → context_length, НЕ retriable', () => {
    const c = classifyProviderError({ status: 400, message: 'This model maximum context length is 128000 tokens' })
    expect(c.category).toBe('context_length')
    expect(c.retriable).toBe(false)
    expect(c.userMessage).toMatch(/контекст/i)
  })
  it('content filter → content_filter', () => {
    const c = classifyProviderError({ message: 'Your request was flagged by content safety policy' })
    expect(c.category).toBe('content_filter')
  })
  it('network ECONNRESET → network, retriable', () => {
    const c = classifyProviderError({ code: 'ECONNRESET', message: 'socket hang up' })
    expect(c.category).toBe('network')
    expect(c.retriable).toBe(true)
  })
  it('timeout → timeout, retriable', () => {
    const c = classifyProviderError({ message: 'Request timed out after 60s' })
    expect(c.category).toBe('timeout')
    expect(c.retriable).toBe(true)
  })
  it('400 bad request → bad_request, НЕ retriable', () => {
    const c = classifyProviderError({ status: 400, message: 'invalid request: bad params' })
    expect(c.category).toBe('bad_request')
    expect(c.retriable).toBe(false)
  })
  it('неизвестная → unknown с обрезанным message', () => {
    const c = classifyProviderError({ message: 'Some weird error '.repeat(20) })
    expect(c.category).toBe('unknown')
    expect(c.userMessage.length).toBeLessThanOrEqual(180)
  })
  it('строка / null — без падения, unknown', () => {
    expect(classifyProviderError('boom').category).toBe('unknown')
    expect(classifyProviderError(null).category).toBe('unknown')
  })
  it('retriable консистентен с isRetriableError', () => {
    expect(classifyProviderError({ status: 429 }).retriable).toBe(true)
    expect(classifyProviderError({ status: 400, message: 'bad' }).retriable).toBe(false)
  })
})
