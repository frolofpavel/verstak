type UpdaterErrorT = {
  updateError: string
  updateNoRelease: string
  updateRateLimitMinutes: string
  updateRateLimitHour: string
}

export type UpdaterErrorPayload = {
  error?: string
  errorCode?: string
  rateLimitMinutes?: number
}

export function formatUpdaterError(
  payload: UpdaterErrorPayload,
  t: UpdaterErrorT,
): string {
  if (payload.errorCode === 'github-rate-limit') {
    const minutes = payload.rateLimitMinutes ?? 60
    if (minutes >= 55) {
      return t.updateRateLimitHour.replace('{minutes}', String(minutes))
    }
    return t.updateRateLimitMinutes.replace('{minutes}', String(minutes))
  }

  const raw = payload.error || ''
  if (!raw) return t.updateError

  const m = raw.toLowerCase()
  if (
    m.includes('404')
    || m.includes('not found')
    || m.includes('latest.yml')
    || m.includes('no published')
    || m.includes('cannot find')
  ) {
    return t.updateNoRelease
  }

  if (m.includes('please check update first')) {
    return t.updateError
  }

  return raw.length > 160 ? t.updateError : raw
}