import { createCostGuard } from './cost-guard'

const COST_CAP_USD_PER_DAY_KEY = 'cost_cap_usd_per_day'
const COST_CAP_LEGACY_SESSION_KEY = 'cost_cap_usd_per_session'
const COST_CAP_DAY_KEY = 'cost_cap_daily_date'
const COST_CAP_DAILY_CENTS_KEY = 'cost_cap_daily_cents'

export interface DailyCostSettings {
  getSecret: (key: string) => string | null
  setSecret?: (key: string, value: string) => void
}

function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parsePositiveFloat(raw: string | null): number | null {
  if (!raw) return null
  const value = Number.parseFloat(raw.replace(',', '.'))
  return Number.isFinite(value) && value > 0 ? value : null
}

function parseStoredCents(raw: string | null): number {
  if (!raw) return 0
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Creates the process guard from the durable per-day settings snapshot. */
export function createDailyCostGuard(
  settings: DailyCostSettings,
  now = new Date(),
): ReturnType<typeof createCostGuard> {
  const capUsd = parsePositiveFloat(
    settings.getSecret(COST_CAP_USD_PER_DAY_KEY) ?? settings.getSecret(COST_CAP_LEGACY_SESSION_KEY),
  )
  const today = localDayKey(now)
  const shouldReset = settings.getSecret(COST_CAP_DAY_KEY) !== today
  const initialCents = shouldReset ? 0 : parseStoredCents(settings.getSecret(COST_CAP_DAILY_CENTS_KEY))

  if (shouldReset) {
    settings.setSecret?.(COST_CAP_DAY_KEY, today)
    settings.setSecret?.(COST_CAP_DAILY_CENTS_KEY, '0')
  }

  return createCostGuard(capUsd, {
    initialCents,
    periodLabel: 'сутки',
    onDailyCentsChange: cents => {
      settings.setSecret?.(COST_CAP_DAY_KEY, today)
      settings.setSecret?.(COST_CAP_DAILY_CENTS_KEY, String(Math.max(0, cents)))
    },
  })
}
