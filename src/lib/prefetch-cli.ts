import type { DetectedCli } from '../types/api'

let cached: DetectedCli[] | null = null
let inflight: Promise<DetectedCli[]> | null = null

/** Один раз сканирует CLI на ПК — переиспользуется в Settings/Auth/Onboarding. */
export function prefetchDetectedClis(): Promise<DetectedCli[]> {
  if (cached) return Promise.resolve(cached)
  if (!inflight) {
    inflight = window.api.cli.detect()
      .then(list => {
        cached = list
        return list
      })
      .catch(() => {
        cached = []
        return []
      })
  }
  return inflight
}

export function getDetectedClisCached(): Promise<DetectedCli[]> {
  return prefetchDetectedClis()
}