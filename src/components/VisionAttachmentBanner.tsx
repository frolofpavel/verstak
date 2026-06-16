import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import type { ProviderId } from '../hooks/useProvider'
import {
  buildVisionAlternatives,
  familyLabelForProvider,
  type VisionAlternative,
} from '../lib/vision-support'
import { isProviderAuthorized, type CliAuthId, type CliAuthStatus } from '../lib/model-catalog'
import type { ProviderDescriptorDTO } from '../types/api'

type CliStatusMap = Partial<Record<CliAuthId, CliAuthStatus>>

interface Props {
  currentProviderId: ProviderId
  currentProviderLabel: string
  onSwitch: (providerId: ProviderId, model: string) => void | Promise<void>
  onOpenSettings: () => void
  onDismiss: () => void
}

function shortModel(m: string): string {
  if (m === 'auto') return 'auto'
  const dateMatch = m.match(/(.*)-\d{8}$/)
  if (dateMatch) return dateMatch[1]
  return m
}

export function VisionAttachmentBanner({
  currentProviderId,
  currentProviderLabel,
  onSwitch,
  onOpenSettings,
  onDismiss,
}: Props) {
  const t = useT()
  const [alternatives, setAlternatives] = useState<VisionAlternative[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const list = await window.api.providers.list()
        const [rawEnabled, rawCustomUrl, cliStatus, ...rest] = await Promise.all([
          window.api.settings.getKey('enabled_models'),
          window.api.settings.getKey('custom_openai_baseurl'),
          window.api.cliAuth.statusAll().catch(() => null as CliStatusMap | null),
          ...list.map(async p => ({
            keyVal: p.secretKey ? await window.api.settings.getKey(p.secretKey) : null,
          })),
        ])
        if (cancelled) return

        const keys: Record<string, string> = {}
        list.forEach((p, i) => {
          if (p.secretKey && rest[i].keyVal) keys[p.secretKey] = rest[i].keyVal
        })

        let enabledModels: Set<string>
        if (!rawEnabled) {
          const pid = (await window.api.settings.getKey('provider')) ?? 'gemini-api'
          const m = (await window.api.settings.getKey(`model_${pid}`)) ?? 'auto'
          enabledModels = new Set([`${pid}::${m}`])
        } else {
          const arr = JSON.parse(rawEnabled) as string[]
          enabledModels = new Set(Array.isArray(arr) ? arr : [])
        }

        const authorizedIds = new Set<string>()
        for (const p of list) {
          const lite = {
            id: p.id as ProviderId,
            name: p.name,
            transport: p.transport,
            supportsTools: p.supportsTools,
            models: p.models,
            defaultModel: p.defaultModel,
            secretKey: p.secretKey,
          }
          if (isProviderAuthorized(lite, keys, cliStatus, { customOpenaiBaseUrl: rawCustomUrl ?? '' })) {
            authorizedIds.add(p.id)
          }
        }

        const providers = list.map((p: ProviderDescriptorDTO) => ({
          id: p.id as ProviderId,
          name: p.name,
          shortLabel: p.shortLabel,
          models: p.models,
          defaultModel: p.defaultModel,
          transport: p.transport,
        }))

        setAlternatives(buildVisionAlternatives(currentProviderId, providers, enabledModels, authorizedIds))
      } catch {
        if (!cancelled) setAlternatives([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [currentProviderId])

  const family = familyLabelForProvider(currentProviderId)
  const ready = alternatives.filter(a => a.authorized)
  const needsAuth = alternatives.filter(a => !a.authorized)

  return (
    <div className="gg-vision-banner" role="status">
      <div className="gg-vision-banner-text">
        <strong>{t.chat.visionBannerTitle}</strong>
        <p>
          {t.chat.visionBannerBody
            .replace('{current}', currentProviderLabel)
            .replace('{family}', family)}
        </p>
      </div>

      {!loading && ready.length > 0 && (
        <div className="gg-vision-banner-models">
          <span className="gg-vision-banner-label">{t.chat.visionBannerSwitchTo}</span>
          {ready.map(a => (
            <button
              key={`${a.providerId}::${a.model}`}
              type="button"
              className="gg-vision-model-btn"
              onClick={() => void onSwitch(a.providerId, a.model)}
              title={t.chat.visionBannerSwitchHint}
            >
              {a.providerLabel} · {shortModel(a.model)}
            </button>
          ))}
        </div>
      )}

      {!loading && ready.length === 0 && needsAuth.length > 0 && (
        <p className="gg-vision-banner-hint">
          {t.chat.visionBannerNeedKey.replace('{family}', family)}
        </p>
      )}

      {!loading && alternatives.length === 0 && (
        <p className="gg-vision-banner-hint">{t.chat.visionBannerNoFamily}</p>
      )}

      <div className="gg-vision-banner-actions">
        {(needsAuth.length > 0 || alternatives.length === 0) && (
          <button type="button" className="gg-btn gg-btn-ghost" onClick={onOpenSettings}>
            {t.chat.visionBannerOpenSettings}
          </button>
        )}
        <button type="button" className="gg-btn gg-btn-ghost" onClick={onDismiss}>
          {t.chat.visionBannerDismiss}
        </button>
      </div>
    </div>
  )
}