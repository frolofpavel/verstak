// Срез 2.0.8-D-core: детерминированный движок route-policy. Матрица карточки:
// strict 401/429/model-not-found; allow rotation; exhausted pool → model fallback; pinned;
// истёкший cooldown; network retry без бана аккаунта; loop guard; два параллельных чата.
import { describe, it, expect } from 'vitest'
import {
  classifyRouteReason, attemptKey, resolveChatAccount, pickChatAccountId,
  type RouteDecisionInput, type RouteAttempt, type RouteReason,
} from '../../electron/ai/route-policy'

const A = (providerId: string, model: string, accountId: number | null = null): RouteAttempt =>
  ({ providerId, model, accountId })

const CUR = A('claude', 'sonnet', 1)

describe('attemptKey', () => {
  it('формат providerId:model:accountId, null → -', () => {
    expect(attemptKey(A('claude', 'sonnet', 7))).toBe('claude:sonnet:7')
    expect(attemptKey(A('gemini-api', 'flash', null))).toBe('gemini-api:flash:-')
  })
})

describe('resolveChatAccount — per-chat binding (D2, инвариант удаления карточки B)', () => {
  const exists = (ids: number[]) => (id: number) => ids.includes(id)

  it('нет binding → auto (глобально-активный)', () => {
    expect(resolveChatAccount(null, exists([1, 2]))).toEqual({ status: 'auto' })
  })
  it('mode auto → auto', () => {
    expect(resolveChatAccount({ mode: 'auto', accountId: null }, exists([1]))).toEqual({ status: 'auto' })
    expect(resolveChatAccount({ mode: 'auto', accountId: 5 }, exists([5]))).toEqual({ status: 'auto' })
  })
  it('pinned без accountId → auto (нормализация)', () => {
    expect(resolveChatAccount({ mode: 'pinned', accountId: null }, exists([1]))).toEqual({ status: 'auto' })
  })
  it('pinned на СУЩЕСТВУЮЩИЙ аккаунт → pinned', () => {
    expect(resolveChatAccount({ mode: 'pinned', accountId: 7 }, exists([7, 8]))).toEqual({ status: 'pinned', accountId: 7 })
  })
  // ГЛАВНЫЙ инвариант (координатор #3): удалили pinned-аккаунт → unavailable, НЕ тихая ротация.
  it('pinned на УДАЛЁННЫЙ аккаунт → unavailable (без тихой ротации на глобально-активный)', () => {
    expect(resolveChatAccount({ mode: 'pinned', accountId: 7 }, exists([8, 9]))).toEqual({ status: 'unavailable', accountId: 7 })
  })
})

describe('pickChatAccountId — решение аккаунта для прогона (main.ts glue, D2)', () => {
  // lookupProvider: id → providerId аккаунта, либо null (удалён).
  const accounts = (m: Record<number, string>) => (id: number) => m[id] ?? null

  it('нет binding → auto (глобально-активный)', () => {
    expect(pickChatAccountId('claude-cli', null, accounts({ 1: 'claude-cli' }))).toEqual({ kind: 'auto' })
  })
  it('pin на живой аккаунт ЭТОГО провайдера → pinned с id', () => {
    expect(pickChatAccountId('claude-cli', { mode: 'pinned', accountId: 7 }, accounts({ 7: 'claude-cli' }))).toEqual({ kind: 'pinned', accountId: 7 })
  })
  it('pin на аккаунт ДРУГОГО провайдера → auto (binding нерелевантен этому прогону)', () => {
    expect(pickChatAccountId('gemini-cli', { mode: 'pinned', accountId: 7 }, accounts({ 7: 'claude-cli' }))).toEqual({ kind: 'auto' })
  })
  // Инвариант удаления (координатор #3) на уровне main.ts-решения.
  it('pin на УДАЛЁННЫЙ аккаунт → unavailable (стоп-с-вопросом, НЕ тихая ротация)', () => {
    expect(pickChatAccountId('claude-cli', { mode: 'pinned', accountId: 7 }, accounts({ 8: 'claude-cli' }))).toEqual({ kind: 'unavailable' })
  })
})


describe('classifyRouteReason — разные коды (инвариант 5)', () => {
  const cases: Array<[unknown, RouteReason]> = [
    [{ status: 401 }, 'auth'],
    [new Error('403 Forbidden'), 'auth'],
    [new Error('invalid api key'), 'auth'],
    [new Error('You have exceeded your usage limit for this plan'), 'quota'],
    [new Error('quota exceeded'), 'quota'],
    [{ status: 429, message: 'Too Many Requests' }, 'rate-limit'],
    [new Error('rate limit reached'), 'rate-limit'],
    [new Error('model not found: gpt-9'), 'model-not-found'],
    [new Error('no such model'), 'model-not-found'],
    [new Error('ECONNRESET'), 'network'],
    [new Error('fetch failed: socket hang up'), 'network'],
    [{ status: 503, message: 'Service Unavailable' }, 'provider-unavailable'],
    [new Error('overloaded, capacity exceeded'), 'provider-unavailable'],
    [new Error('maximum context length exceeded'), 'context-overflow'],
    [new Error('какая-то непонятная ошибка'), 'none'],
    ['', 'none'],
    // Ревью D-core (edge-cases классификатора):
    [{ status: 504 }, 'provider-unavailable'],                       // #1: 5xx целиком, не 'none'
    [{ status: 529 }, 'provider-unavailable'],                       // #1: Cloudflare overload
    [{ status: 508 }, 'provider-unavailable'],                       // #1: не в старом списке
    [new Error('Error 429: too many requests, retry after 401 seconds'), 'rate-limit'], // #2: «401 seconds» не auth
    [{ status: 403, message: 'usage limit reached for your plan' }, 'quota'],           // #2: 403+quota-текст → quota, не auth
    ['path does not exist', 'none'],                                 // #1: «does not exist» без model → не model-not-found
  ]
  for (const [err, expected] of cases) {
    it(`${JSON.stringify(err instanceof Error ? err.message : err).slice(0, 40)} → ${expected}`, () => {
      expect(classifyRouteReason(err)).toBe(expected)
    })
  }

  it('quota имеет приоритет над 429 rate-limit (usage limit — не транзиент)', () => {
    expect(classifyRouteReason({ status: 429, message: 'usage limit reached for your plan' })).toBe('quota')
  })
})







/**
 * Honesty & unbrick срез (ре-ревью 2.0.11-B, находка #4): выход из чата-кирпича.
 *
 * Сценарий целиком: чат закреплён за аккаунтом → аккаунт удалили → движок честно
 * останавливает прогон (unavailable) → человек жмёт «Открепить и вернуть автовыбор»
 * (binding.mode='auto') → прогон снова проходит.
 *
 * Проверяется движок: именно он решает, жив чат или нет. UI-половина — в
 * tests/lib/chat-account-binding (секция видна, пока закрепление висит).
 */
describe('unbrick: открепление оживляет чат (ре-ревью B #4)', () => {
  const noAccounts = () => null // все аккаунты провайдера удалены

  it('закрепление на удалённый аккаунт → прогон останавливается', () => {
    expect(pickChatAccountId('claude', { mode: 'pinned', accountId: 99 }, noAccounts))
      .toEqual({ kind: 'unavailable' })
  })

  // Ключевое: открепление возвращает чат к жизни ДАЖЕ когда аккаунтов не осталось вовсе.
  it('после открепления (mode=auto) прогон проходит — чат снова живой', () => {
    expect(pickChatAccountId('claude', { mode: 'auto', accountId: null }, noAccounts))
      .toEqual({ kind: 'auto' })
  })

  it('открепление игнорирует застрявший accountId мёртвого аккаунта', () => {
    // UI шлёт autoBinding без accountId, но даже если старый id где-то залипнет —
    // режим auto обязан победить, иначе тупик вернётся.
    expect(pickChatAccountId('claude', { mode: 'auto', accountId: 99 }, noAccounts))
      .toEqual({ kind: 'auto' })
  })

  it('открепление одного чата не оживляет и не ломает закрепление другого', () => {
    const live = (id: number) => (id === 1 ? 'claude' : null)
    expect(pickChatAccountId('claude', { mode: 'auto', accountId: null }, live)).toEqual({ kind: 'auto' })
    expect(pickChatAccountId('claude', { mode: 'pinned', accountId: 1 }, live)).toEqual({ kind: 'pinned', accountId: 1 })
  })
})
