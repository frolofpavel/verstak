// 2.1.14: как телеметрия читается человеком.
//
// Проверяется одно свойство, ради которого функция и написана: цифра в интерфейсе не
// должна врать. «Учёт не вёлся», «учёт есть, но аккаунт не трогали» и «аккаунт работал»
// — три разных факта, и выглядеть они обязаны по-разному.
import { describe, it, expect } from 'vitest'
import { formatAccountTelemetry, successRate } from '../../src/lib/subscription-telemetry'
import type { SubscriptionAccountStatsDTO } from '../../shared/contracts/subscription'

const SINCE = Date.UTC(2026, 6, 26)

const stats = (over: Partial<SubscriptionAccountStatsDTO> = {}): SubscriptionAccountStatsDTO => ({
  attempts: 0, successes: 0, cooldowns: 0, quotaHits: 0, rateLimitHits: 0,
  authFailures: 0, rotationsOut: 0, rotationsIn: 0,
  lastErrorAt: null, lastErrorReason: null, lastSuccessAt: null, since: SINCE,
  ...over,
})

describe('successRate', () => {
  it('без попыток доля не считается — делить не на что', () => {
    expect(successRate({ attempts: 0, successes: 0 })).toBeNull()
  })
  it('считается от попыток и округляется', () => {
    expect(successRate({ attempts: 3, successes: 2 })).toBe(67)
    expect(successRate({ attempts: 10, successes: 10 })).toBe(100)
  })
})

describe('formatAccountTelemetry — «нет данных» и «ноль» это разное', () => {
  it('учёт не вёлся: так и пишем, без единой цифры', () => {
    const v = formatAccountTelemetry(stats({ since: null }))
    expect(v.line).toMatch(/не велась/i)
    expect(v.line, 'ноль здесь читался бы как «не пользовались»').not.toMatch(/\d/)
    expect(v.alarming).toBe(false)
  })

  it('stats вообще отсутствует (старый DTO) — то же самое, а не падение', () => {
    expect(formatAccountTelemetry(undefined).line).toMatch(/не велась/i)
  })

  it('учёт есть, попыток нет: сообщаем именно это и с какого момента', () => {
    const v = formatAccountTelemetry(stats({ attempts: 0 }))
    expect(v.line).toMatch(/не использовался/i)
    expect(v.line).toContain(new Date(SINCE).toLocaleDateString())
    expect(v.alarming).toBe(false)
  })

  it('рабочий аккаунт: попытки, ответы и доля', () => {
    const v = formatAccountTelemetry(stats({ attempts: 20, successes: 19 }))
    expect(v.line).toContain('20 попыток')
    expect(v.line).toContain('19 ответов')
    expect(v.line).toContain('95%')
    expect(v.alarming).toBe(false)
  })

  it('нулевые причины в строку не лезут — она не должна быть шумной', () => {
    const v = formatAccountTelemetry(stats({ attempts: 5, successes: 5 }))
    expect(v.line).not.toMatch(/лимитов/i)
    expect(v.line).not.toMatch(/уводов/i)
  })

  it('попытки есть, ответов нет — тревожный признак для UI', () => {
    const v = formatAccountTelemetry(stats({ attempts: 4, successes: 0 }))
    expect(v.alarming).toBe(true)
    expect(v.line).toContain('0%')
  })

  it('подсказка раскладывает причины, и сумма сходится с общим числом', () => {
    const v = formatAccountTelemetry(stats({
      attempts: 10, successes: 6, cooldowns: 4,
      quotaHits: 1, rateLimitHits: 1, authFailures: 1, rotationsIn: 2,
    }))
    expect(v.detail).toContain('квота: 1')
    expect(v.detail).toContain('рейт-лимит: 1')
    expect(v.detail).toContain('требовался вход: 1')
    // 4 охлаждения минус 3 именованных = 1 прочее: остаток не теряется.
    expect(v.detail).toContain('прочее: 1')
    expect(v.detail).toContain('переключений на него: 2')
  })

  it('когда все причины именованы — «прочее» не выдумывается', () => {
    const v = formatAccountTelemetry(stats({ attempts: 5, successes: 3, cooldowns: 2, quotaHits: 2 }))
    expect(v.detail).toContain('квота: 2')
    expect(v.detail).not.toMatch(/прочее/i)
  })

  it('время последнего ответа и последней ошибки — только когда они были', () => {
    const empty = formatAccountTelemetry(stats({ attempts: 1, successes: 1 }))
    expect(empty.detail).not.toMatch(/последний ответ/i)
    expect(empty.detail).not.toMatch(/последняя ошибка/i)
    const full = formatAccountTelemetry(stats({ attempts: 1, successes: 1, lastSuccessAt: SINCE, lastErrorAt: SINCE }))
    expect(full.detail).toMatch(/последний ответ/i)
    expect(full.detail).toMatch(/последняя ошибка/i)
  })
})
