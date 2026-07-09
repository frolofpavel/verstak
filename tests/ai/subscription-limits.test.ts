import { describe, it, expect } from 'vitest'
import { detectSubscriptionLimit } from '../../electron/ai/subscription-limits'

describe('detectSubscriptionLimit', () => {
  it('detects Claude Code usage-limit message and parses reset ETA (relative)', () => {
    const now = 1_000_000_000_000
    const hit = detectSubscriptionLimit('Claude usage limit reached. Try again in 2 hours.', now)
    expect(hit.limited).toBe(true)
    expect(hit.kind).toBe('usage')
    expect(hit.resetEta).toBe(now + 2 * 60 * 60_000)
  })

  it('detects "5-hour limit reached"', () => {
    const hit = detectSubscriptionLimit('You have hit the 5-hour limit reached for your plan.')
    expect(hit.limited).toBe(true)
    expect(hit.kind).toBe('usage')
  })

  it('parses "reset in 45 minutes"', () => {
    const now = 2_000_000_000_000
    const hit = detectSubscriptionLimit('usage limit reached, resets in 45 minutes', now)
    expect(hit.limited).toBe(true)
    expect(hit.resetEta).toBe(now + 45 * 60_000)
  })

  it('detects rate limit / 429', () => {
    expect(detectSubscriptionLimit('HTTP 429 Too Many Requests').limited).toBe(true)
    expect(detectSubscriptionLimit('rate_limit_exceeded').kind).toBe('rate')
  })

  it('detects quota exhaustion', () => {
    const hit = detectSubscriptionLimit('Your quota has been exceeded for this billing period')
    expect(hit.limited).toBe(true)
    expect(hit.kind).toBe('quota')
  })

  it('does NOT flag normal errors', () => {
    expect(detectSubscriptionLimit('SyntaxError: unexpected token').limited).toBe(false)
    expect(detectSubscriptionLimit('file not found').limited).toBe(false)
    expect(detectSubscriptionLimit('').limited).toBe(false)
  })

  it('resetEta is null when no time present', () => {
    const hit = detectSubscriptionLimit('usage limit reached')
    expect(hit.limited).toBe(true)
    expect(hit.resetEta).toBeNull()
  })

  it('accepts Error objects and status codes', () => {
    const err = Object.assign(new Error('too many requests'), { status: 429 })
    expect(detectSubscriptionLimit(err).limited).toBe(true)
  })
})
