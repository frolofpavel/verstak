import { describe, expect, it } from 'vitest'
import { formatUpdaterError } from '../src/lib/updater-error'

const t = {
  updateError: 'Network error',
  updateNoRelease: 'No release',
  updateRateLimitMinutes: 'Wait {minutes} min',
  updateRateLimitHour: 'Wait hour ({minutes} min)',
}

describe('formatUpdaterError', () => {
  it('formats github rate limit under an hour', () => {
    expect(formatUpdaterError({ errorCode: 'github-rate-limit', rateLimitMinutes: 12 }, t))
      .toBe('Wait 12 min')
  })

  it('formats github rate limit over an hour', () => {
    expect(formatUpdaterError({ errorCode: 'github-rate-limit', rateLimitMinutes: 60 }, t))
      .toBe('Wait hour (60 min)')
  })

  it('hides electron-updater Please check update first', () => {
    expect(formatUpdaterError({ error: 'Please check update first' }, t))
      .toBe('Network error')
  })
})