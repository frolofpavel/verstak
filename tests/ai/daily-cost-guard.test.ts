import { describe, expect, it, vi } from 'vitest'
import { createDailyCostGuard } from '../../electron/ai/daily-cost-guard'

function settings(values: Record<string, string>) {
  return {
    getSecret: (key: string) => values[key] ?? null,
    setSecret: vi.fn((key: string, value: string) => {
      values[key] = value
    }),
  }
}

describe('createDailyCostGuard', () => {
  it('продолжает дневной счётчик и сохраняет новый итог', () => {
    const values = {
      cost_cap_usd_per_day: '2,00',
      cost_cap_daily_date: '2026-07-26',
      cost_cap_daily_cents: '50',
    }
    const store = settings(values)
    const guard = createDailyCostGuard(store, new Date(2026, 6, 26, 12))

    const result = guard.recordAndCheck('openai', 'gpt-5', 1_000_000, 0, 0)

    expect(result).toMatchObject({ exceeded: false, capCents: 200 })
    expect(values.cost_cap_daily_cents).toBe('175')
    expect(store.setSecret).toHaveBeenCalledWith('cost_cap_daily_date', '2026-07-26')
  })

  it('на новом локальном дне сбрасывает старый расход до первого запроса', () => {
    const values = {
      cost_cap_usd_per_session: '5',
      cost_cap_daily_date: '2026-07-25',
      cost_cap_daily_cents: '499',
    }
    const store = settings(values)

    const guard = createDailyCostGuard(store, new Date(2026, 6, 26, 0, 1))

    expect(guard.current()).toBe(0)
    expect(values).toMatchObject({
      cost_cap_daily_date: '2026-07-26',
      cost_cap_daily_cents: '0',
    })
  })
})
