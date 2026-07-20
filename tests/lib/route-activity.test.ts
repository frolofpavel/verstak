import { describe, it, expect } from 'vitest'
import { routeChangedActivity } from '../../src/lib/route-activity'
import type { ChatEvent } from '../../src/types/api'

/**
 * 2.1.3-CD: подпись route-changed для Timeline/Activity.
 *
 * Требования карточки:
 * - ротация АККАУНТА и fallback МОДЕЛИ — два разных события с разными подписями;
 * - причина человеческая (quota/rate-limit/auth/unavailable), не сырая;
 * - время восстановления — только если реально известно; неизвестное не превращается
 *   в выдуманный срок или «безлимит»;
 * - аккаунты называются безопасными label'ами, внутренние id не показываем.
 */

type RouteChanged = Extract<ChatEvent, { type: 'route-changed' }>

const ev = (over: Partial<RouteChanged>): RouteChanged => ({
  type: 'route-changed',
  action: 'rotate-account',
  reason: 'quota',
  attempt: 1,
  requested: { providerId: 'claude-cli', model: 'auto' },
  actual: { providerId: 'claude-cli', model: 'auto' },
  resetAt: null,
  accounts: null,
  ...over,
})

describe('routeChangedActivity — подписи переключений маршрута (2.1.3-CD)', () => {
  it('ротация аккаунта: label зовёт аккаунты по именам, причина человеческая', () => {
    const a = routeChangedActivity(ev({
      accounts: { fromLabel: 'Рабочий Max', toLabel: 'Личный Max' },
      resetAt: Date.now() + 2 * 3600_000,
    }))
    expect(a.label).toBe('⇄ Аккаунт Рабочий Max → Личный Max')
    expect(a.detail).toContain('квота исчерпана')
    expect(a.detail).toMatch(/· до \d{2}:\d{2}$/) // срок известен → показан
  })

  it('срок восстановления неизвестен → НИКАКИХ выдуманных «до …»', () => {
    const a = routeChangedActivity(ev({ accounts: { fromLabel: 'A', toLabel: 'B' }, resetAt: null }))
    expect(a.detail).toBe('квота исчерпана')
    expect(a.detail).not.toContain('до')
    expect(a.detail).not.toContain('безлимит')
  })

  it('rate-limit и quota — РАЗНЫЕ подписи (сценарий E карточки)', () => {
    const q = routeChangedActivity(ev({ reason: 'quota', accounts: { fromLabel: 'A', toLabel: 'B' } }))
    const r = routeChangedActivity(ev({ reason: 'rate-limit', accounts: { fromLabel: 'A', toLabel: 'B' } }))
    expect(q.detail).toContain('квота исчерпана')
    expect(r.detail).toContain('лимит частоты')
    expect(q.detail).not.toBe(r.detail)
  })

  it('model-fallback — другое событие: провайдеры и модель, не аккаунты', () => {
    const a = routeChangedActivity(ev({
      action: 'model-fallback',
      reason: 'provider-unavailable',
      requested: { providerId: 'gemini-api', model: 'gemini-3-flash' },
      actual: { providerId: 'claude', model: 'claude-sonnet' },
    }))
    expect(a.label).toBe('⚡ gemini-api → claude')
    expect(a.detail).toContain('claude-sonnet')
    expect(a.detail).toContain('провайдер недоступен')
  })

  it('легаси-событие без accounts (старый main) — не падает, зовёт провайдера', () => {
    const a = routeChangedActivity(ev({ accounts: null }))
    expect(a.label).toContain('claude-cli')
  })

  it('незнакомый reason проходит как есть (не исчезает и не ломает верстку)', () => {
    const a = routeChangedActivity(ev({ reason: 'weird-new-reason', accounts: { fromLabel: 'A', toLabel: 'B' } }))
    expect(a.detail).toContain('weird-new-reason')
  })

  it('refresh-auth — отдельная подпись', () => {
    const a = routeChangedActivity(ev({ action: 'refresh-auth', reason: 'auth' }))
    expect(a.label).toContain('claude-cli')
    expect(a.detail).toContain('ошибка авторизации')
  })
})
