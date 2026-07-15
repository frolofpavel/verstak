// Срез 2.0.8-D-core: детерминированный движок route-policy. Матрица карточки:
// strict 401/429/model-not-found; allow rotation; exhausted pool → model fallback; pinned;
// истёкший cooldown; network retry без бана аккаунта; loop guard; два параллельных чата.
import { describe, it, expect } from 'vitest'
import {
  decideRoute, classifyRouteReason, attemptKey, routeChangedText, resolveChatAccount,
  type RouteDecisionInput, type RouteAttempt, type RoutePolicy, type RouteReason,
} from '../../electron/ai/route-policy'
import { MAX_FALLBACK_ATTEMPTS, MAX_ACCOUNT_SWITCHES } from '../../electron/ai/runner-shared'

const A = (providerId: string, model: string, accountId: number | null = null): RouteAttempt =>
  ({ providerId, model, accountId })

const CUR = A('claude', 'sonnet', 1)

function input(over: Partial<RouteDecisionInput>): RouteDecisionInput {
  return {
    policy: 'chat-default', pinned: false, current: CUR, reason: 'quota',
    triedKeys: [attemptKey(CUR)], readyAccounts: [], modelFallbacks: [], maxAttempts: 6,
    ...over,
  }
}

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

describe('routeChangedText — человекочитаемая пилюля', () => {
  it('rotate-account упоминает провайдера аккаунта', () => {
    expect(routeChangedText('rotate-account', { providerId: 'claude-cli' }, { providerId: 'claude-cli', model: 'sonnet' })).toContain('claude-cli')
  })
  it('model-fallback упоминает и упавшего, и нового провайдера', () => {
    const t = routeChangedText('model-fallback', { providerId: 'claude' }, { providerId: 'gemini-api', model: 'flash' })
    expect(t).toContain('claude')
    expect(t).toContain('gemini-api')
  })
  it('refresh-auth упоминает провайдера', () => {
    expect(routeChangedText('refresh-auth', { providerId: 'openai-codex-oauth' }, { providerId: 'openai-codex-oauth', model: 'gpt-5' })).toContain('openai-codex-oauth')
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

describe('decideRoute — locked (strict || pinned): маршрут не меняется (инвариант 1)', () => {
  const locks: Array<[string, Partial<RouteDecisionInput>]> = [
    ['strict', { policy: 'strict' }],
    ['pinned', { policy: 'chat-default', pinned: true }],
  ]
  for (const [name, lock] of locks) {
    it(`${name} + auth → refresh-auth на ТОМ ЖЕ аккаунте (не смена маршрута)`, () => {
      const d = decideRoute(input({ ...lock, reason: 'auth' }))
      expect(d.action).toBe('refresh-auth')
      expect(d.next).toEqual(CUR)
      expect(d.cooldown).toBeNull()
      expect(d.visibleWarning).toBe(false)
    })
    it(`${name} + quota → stop (ротация запрещена)`, () => {
      const d = decideRoute(input({ ...lock, reason: 'quota', readyAccounts: [A('claude', 'sonnet', 2)] }))
      expect(d.action).toBe('stop')
      expect(d.next).toBeNull()
    })
    it(`${name} + model-not-found → stop (смена модели запрещена)`, () => {
      expect(decideRoute(input({ ...lock, reason: 'model-not-found', modelFallbacks: [A('gemini-api', 'flash')] })).action).toBe('stop')
    })
    it(`${name} + network → stop (провайдер недоступен, смена запрещена)`, () => {
      expect(decideRoute(input({ ...lock, reason: 'network', modelFallbacks: [A('gemini-api', 'flash')] })).action).toBe('stop')
    })
  }
})

describe('decideRoute — allow: смена только с видимым предупреждением (инвариант 2)', () => {
  it('allow + quota + готовый аккаунт → rotate-account, visibleWarning=true', () => {
    const acc2 = A('claude', 'sonnet', 2)
    const d = decideRoute(input({ policy: 'allow', reason: 'quota', readyAccounts: [acc2] }))
    expect(d.action).toBe('rotate-account')
    expect(d.next).toEqual(acc2)
    expect(d.visibleWarning).toBe(true)
    expect(d.cooldown).toEqual({ scope: 'account', reason: 'quota' })
  })
  it('allow + auth → refresh-auth без предупреждения (не смена маршрута)', () => {
    expect(decideRoute(input({ policy: 'allow', reason: 'auth' })).visibleWarning).toBe(false)
  })
})

describe('decideRoute — chat-default quota: ротация → model-fallback (инвариант 3)', () => {
  it('есть готовый аккаунт → rotate-account (visibleWarning=false у chat-default)', () => {
    const acc2 = A('claude', 'sonnet', 2)
    const d = decideRoute(input({ reason: 'quota', readyAccounts: [acc2], modelFallbacks: [A('gemini-api', 'flash')] }))
    expect(d.action).toBe('rotate-account')
    expect(d.next).toEqual(acc2)
    expect(d.visibleWarning).toBe(false)
  })
  it('пул аккаунтов исчерпан → model-fallback', () => {
    const fb = A('gemini-api', 'flash')
    const d = decideRoute(input({ reason: 'quota', readyAccounts: [], modelFallbacks: [fb] }))
    expect(d.action).toBe('model-fallback')
    expect(d.next).toEqual(fb)
  })
  it('готовый аккаунт УЖЕ в triedKeys → не берём его, идём в model-fallback', () => {
    const acc2 = A('claude', 'sonnet', 2)
    const fb = A('gemini-api', 'flash')
    const d = decideRoute(input({ reason: 'quota', readyAccounts: [acc2], modelFallbacks: [fb], triedKeys: [attemptKey(CUR), attemptKey(acc2)] }))
    expect(d.action).toBe('model-fallback')
    expect(d.next).toEqual(fb)
  })
})

describe('decideRoute — reason-специфичные cooldown-области (инвариант 4/5/6)', () => {
  it('auth → refresh-auth, cooldown НЕ применяется (не квота)', () => {
    const d = decideRoute(input({ reason: 'auth' }))
    expect(d.action).toBe('refresh-auth')
    expect(d.cooldown).toBeNull()
  })
  it('rate-limit → rotate-account, cooldown account/rate-limit (отличается от quota)', () => {
    const d = decideRoute(input({ reason: 'rate-limit', readyAccounts: [A('claude', 'sonnet', 2)] }))
    expect(d.action).toBe('rotate-account')
    expect(d.cooldown).toEqual({ scope: 'account', reason: 'rate-limit' })
  })
  it('provider-unavailable → model-fallback, cooldown provider (не весь бренд по аккаунту)', () => {
    const fb = A('gemini-api', 'flash')
    const d = decideRoute(input({ reason: 'provider-unavailable', modelFallbacks: [fb] }))
    expect(d.action).toBe('model-fallback')
    expect(d.cooldown).toEqual({ scope: 'provider', reason: 'provider-unavailable' })
  })
  it('network → model-fallback БЕЗ cooldown (аккаунт не банится, инвариант 5)', () => {
    const fb = A('gemini-api', 'flash')
    const d = decideRoute(input({ reason: 'network', modelFallbacks: [fb] }))
    expect(d.action).toBe('model-fallback')
    expect(d.cooldown).toBeNull()
  })
  it('model-not-found → model-fallback, cooldown model', () => {
    const fb = A('gemini-api', 'flash')
    const d = decideRoute(input({ reason: 'model-not-found', modelFallbacks: [fb] }))
    expect(d.action).toBe('model-fallback')
    expect(d.cooldown?.scope).toBe('model')
  })
  it('context-overflow → stop (маршрутизация не спасёт)', () => {
    expect(decideRoute(input({ reason: 'context-overflow', modelFallbacks: [A('gemini-api', 'flash')] })).action).toBe('stop')
  })
  it('none → stop', () => {
    expect(decideRoute(input({ reason: 'none' })).action).toBe('stop')
  })
})

describe('decideRoute — loop guard (инвариант 7): один источник ограничения', () => {
  it('triedKeys.length >= maxAttempts → stop, даже если есть кандидаты', () => {
    const acc2 = A('claude', 'sonnet', 2)
    const d = decideRoute(input({ reason: 'quota', readyAccounts: [acc2], maxAttempts: 1, triedKeys: [attemptKey(CUR)] }))
    expect(d.action).toBe('stop')
  })
  it('никогда не возвращает next, который уже в triedKeys', () => {
    const acc2 = A('claude', 'sonnet', 2)
    const acc3 = A('claude', 'sonnet', 3)
    const d = decideRoute(input({ reason: 'quota', readyAccounts: [acc2, acc3], triedKeys: [attemptKey(CUR), attemptKey(acc2)] }))
    expect(d.next).toEqual(acc3)
  })
  it('сценарий 1.9.7 (resetEta=null, пул из 2): оба аккаунта попробованы → stop, без вечного цикла', () => {
    const acc2 = A('claude', 'sonnet', 2)
    // Ротация A→B прошла; B тоже уперся в quota; A и B оба в tried; пул пуст → stop.
    const d = decideRoute(input({ reason: 'quota', readyAccounts: [], modelFallbacks: [], triedKeys: [attemptKey(CUR), attemptKey(acc2)] }))
    expect(d.action).toBe('stop')
  })
  it('attemptNumber = triedKeys.length + 1', () => {
    expect(decideRoute(input({ triedKeys: [attemptKey(CUR)] })).attemptNumber).toBe(2)
    expect(decideRoute(input({ triedKeys: [] })).attemptNumber).toBe(1)
  })

  // Согласование с руннером (каветат координатора): фактический потолок исполнения — бонды
  // руннера (MAX_FALLBACK_ATTEMPTS + MAX_ACCOUNT_SWITCHES, НЕ тронуты в D-core). Движок как
  // спека при этом же бюджете гарантированно ОСТАНАВЛИВАЕТСЯ (не ослабляет, не зацикливает).
  // Когда D2 подаст decideRoute как драйвер — maxAttempts = этот суммарный бюджет (единый источник).
  it('единый бюджет попыток: при maxAttempts = сумма руннер-бондов движок терминирует', () => {
    const budget = MAX_FALLBACK_ATTEMPTS + MAX_ACCOUNT_SWITCHES
    const tried = Array.from({ length: budget }, (_, i) => attemptKey(A('claude', 'sonnet', i)))
    const d = decideRoute(input({ reason: 'quota', maxAttempts: budget, triedKeys: tried, readyAccounts: [A('claude', 'sonnet', 99)] }))
    expect(d.action).toBe('stop')
  })
})

describe('decideRoute — детерминизм (DoD: один input → одно решение; два параллельных чата)', () => {
  it('одинаковый input → идентичное решение (deep equal, дважды)', () => {
    const mk = () => input({ policy: 'allow', reason: 'quota', readyAccounts: [A('claude', 'sonnet', 2), A('claude', 'sonnet', 3)], modelFallbacks: [A('openai', 'gpt-5')] })
    expect(decideRoute(mk())).toEqual(decideRoute(mk()))
  })
  it('два «параллельных чата» (разные current/tried) не влияют друг на друга', () => {
    const chatA = decideRoute(input({ policy: 'allow', current: A('claude', 'sonnet', 1), reason: 'quota', readyAccounts: [A('claude', 'sonnet', 2)] }))
    const chatB = decideRoute(input({ policy: 'chat-default', current: A('grok', 'grok-4', 5), reason: 'network', modelFallbacks: [A('openai', 'gpt-5')] }))
    expect(chatA.action).toBe('rotate-account')
    expect(chatA.next).toEqual(A('claude', 'sonnet', 2))
    expect(chatB.action).toBe('model-fallback')
    expect(chatB.next).toEqual(A('openai', 'gpt-5'))
  })
})
