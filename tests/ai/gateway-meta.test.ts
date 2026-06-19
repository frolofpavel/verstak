import { describe, it, expect } from 'vitest'
import { formatVerstakMeta, mapGatewayError } from '../../electron/ai/gateway-meta'

describe('formatVerstakMeta', () => {
  it('полная метадата → строка с ценой/балансом/кэшем', () => {
    expect(formatVerstakMeta({ cost_rub: 0.84, balance_rub: 923.1, cache_hit_ratio: 0.42 }))
      .toBe('Verstak · 0.84 ₽ · Баланс 923.10 ₽ · Кэш 42%')
  })
  it('только цена', () => {
    expect(formatVerstakMeta({ cost_rub: 1.5 })).toBe('Verstak · 1.50 ₽')
  })
  it('кэш 0 не показываем', () => {
    expect(formatVerstakMeta({ cost_rub: 1, cache_hit_ratio: 0 })).toBe('Verstak · 1.00 ₽')
  })
  it('пусто/нет полей → null (вызывающий ничего не эмитит)', () => {
    expect(formatVerstakMeta(null)).toBeNull()
    expect(formatVerstakMeta({})).toBeNull()
    expect(formatVerstakMeta(undefined)).toBeNull()
  })
})

describe('mapGatewayError', () => {
  it('402 / insufficient_balance → про баланс', () => {
    expect(mapGatewayError(402)).toMatch(/баланс/i)
    expect(mapGatewayError(500, 'insufficient_balance')).toMatch(/баланс/i)
  })
  it('401/403 → про ключ', () => {
    expect(mapGatewayError(401)).toMatch(/ключ/i)
    expect(mapGatewayError(403)).toMatch(/ключ/i)
  })
  it('429 → про лимит, 503 → про недоступность', () => {
    expect(mapGatewayError(429)).toMatch(/лимит/i)
    expect(mapGatewayError(503)).toMatch(/недоступн/i)
  })
  it('неизвестный статус → null (обычное сообщение)', () => {
    expect(mapGatewayError(400)).toBeNull()
    expect(mapGatewayError(undefined)).toBeNull()
  })
})
