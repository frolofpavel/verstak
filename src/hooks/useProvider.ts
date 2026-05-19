import { useEffect, useState } from 'react'

export type ProviderId = 'gemini-api' | 'gemini-cli'

export interface ProviderInfo {
  id: ProviderId
  /** Human-readable model label shown in the chat status bar */
  model: string
  /** Short transport label ("API", "CLI") */
  transport: string
}

const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  'gemini-api': { id: 'gemini-api', model: 'Gemini 2.5 Pro', transport: 'API' },
  'gemini-cli': { id: 'gemini-cli', model: 'Gemini Ultra', transport: 'CLI' }
}

const POLL_INTERVAL_MS = 1500

/** Polls settings storage so the UI reflects provider changes without a page reload. */
export function useProvider(): ProviderInfo {
  const [id, setId] = useState<ProviderId>('gemini-api')

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const v = await window.api.settings.getKey('provider')
      if (!cancelled) setId(v === 'gemini-cli' ? 'gemini-cli' : 'gemini-api')
    }
    void refresh()
    const t = window.setInterval(refresh, POLL_INTERVAL_MS)
    return () => { cancelled = true; window.clearInterval(t) }
  }, [])

  return PROVIDER_INFO[id]
}
