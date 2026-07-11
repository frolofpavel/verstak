import { useEffect, useMemo, useRef, useState } from 'react'
import { useProvider, type ProviderId } from '../hooks/useProvider'
import { useProject } from '../store/projectStore'
import { useT, type Translations } from '../i18n'
import type { ProviderDescriptorDTO } from '../types/api'
import {
  isProviderAuthorized,
  modelPolicyHint,
  type CliAuthId,
  type CliAuthStatus,
} from '../lib/model-catalog'
import { runtimeCapability, secretProtectionLevel, SECRET_PROTECTION_UI, type RuntimeTier, type SecretProtectionLevel } from '../lib/runtime-capability'

// Ревью F1 + срез 3: честная degraded-индикация уровня контроля. Считаем tier
// из provider+transport (runtime-capability), а не из одного transport — после
// проекции tool-таймлайна (срезы 1-2) claude/codex CLI стали «наблюдаемыми»,
// прочие CLI остаются «урезанными». Ни один CLI не показывается как full control.
function tierBadge(t: Translations, tier: RuntimeTier): { label: string; hint: string; tone: 'observed' | 'limited' } | null {
  if (tier === 'observed') return { label: t.runtime.observedLabel, hint: t.runtime.observedHint, tone: 'observed' }
  if (tier === 'limited') return { label: t.runtime.limitedLabel, hint: t.runtime.limitedHint, tone: 'limited' }
  return null // full — контроль полный, бейдж не нужен (чистый дефолт).
}

// Честный бейдж защиты секретов (1.9.6 #2). full не показываем — чистый дефолт.
function secretBadge(t: Translations, level: SecretProtectionLevel): { label: string; hint: string; tone: 'ok' | 'warn' | 'danger' } | null {
  const tone = SECRET_PROTECTION_UI[level].tone
  if (level === 'partial') return { label: t.secretProtection.partialLabel, hint: t.secretProtection.partialHint, tone }
  if (level === 'none') return { label: t.secretProtection.noneLabel, hint: t.secretProtection.noneHint, tone }
  return null
}

type CliStatusMap = Partial<Record<CliAuthId, CliAuthStatus>>

interface PickerEntry {
  providerId: ProviderId
  providerLabel: string
  model: string
  transport: 'API' | 'CLI' | 'Tunnel'
  authorized: boolean
  enabled: boolean
  isCurrent: boolean
  sortRank: number
}

interface Props {
  onOpenSettings: () => void
  /** pill — в composer; footer — нижний левый угол sidebar */
  variant?: 'pill' | 'footer'
}

function modelKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

function isCliProvider(id: string): boolean {
  return id.endsWith('-cli')
}

function groupEntriesByProvider(entries: PickerEntry[]): Array<{ key: string; label: string; entries: PickerEntry[] }> {
  const groups: Array<{ key: string; label: string; entries: PickerEntry[] }> = []
  for (const entry of entries) {
    let group = groups.find(g => g.key === entry.providerId)
    if (!group) {
      group = { key: entry.providerId, label: entry.providerLabel, entries: [] }
      groups.push(group)
    }
    group.entries.push(entry)
  }
  return groups
}

// Verstak Gateway: пресеты показываем по-русски (в API уходит id verstak/...).
// Зеркало GATEWAY_PRESET_LABELS из electron/ai/extra-providers.ts (renderer без main).
const GATEWAY_PRESET_LABELS: Record<string, string> = {
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'deepseek-chat': 'DeepSeek Chat',
  'qwen3-coder': 'Qwen3 Coder',
  'verstak/economy': 'Эконом · DeepSeek',
  'verstak/balanced': 'Баланс · Kimi',
  'verstak/coder': 'Кодинг · Kimi',
  'verstak/long': 'Длинный контекст',
  'verstak/fast': 'Быстро · DeepSeek',
  'verstak/private': 'Приватно',
}

function shortModel(m: string): string {
  if (m === 'auto') return 'auto'
  if (GATEWAY_PRESET_LABELS[m]) return GATEWAY_PRESET_LABELS[m]
  const dateMatch = m.match(/(.*)-\d{8}$/)
  if (dateMatch) return dateMatch[1]
  return m
}

function buildPickerEntries(
  providers: ProviderDescriptorDTO[],
  enabledModels: Set<string>,
  authorizedIds: Set<ProviderId>,
  currentProviderId: ProviderId,
  currentModel: string,
  storedModels: Record<string, string>,
): PickerEntry[] {
  const entries: PickerEntry[] = []

  for (const p of providers) {
    const pid = p.id as ProviderId
    const authorized = authorizedIds.has(pid)
    const label = p.shortLabel || p.name
    const models = p.models.length > 0 ? p.models : [storedModels[pid] || p.defaultModel || ''].filter(Boolean)

    if (!authorized) {
      const model = storedModels[pid] || p.defaultModel || models[0] || '—'
      entries.push({
        providerId: pid,
        providerLabel: label,
        model,
        transport: p.transport,
        authorized: false,
        enabled: false,
        isCurrent: pid === currentProviderId,
        sortRank: 0,
      })
      continue
    }

    const visibleModels = models.filter(m => {
      const key = modelKey(pid, m)
      return enabledModels.has(key) || (pid === currentProviderId && m === currentModel)
    })

    const list = visibleModels.length > 0 ? visibleModels : models.slice(0, 1)
    for (const m of list) {
      const enabled = enabledModels.has(modelKey(pid, m))
      const isCurrent = pid === currentProviderId && m === currentModel
      let sortRank = 10
      if (isCurrent) sortRank = 100
      else if (enabled) sortRank = 50
      entries.push({
        providerId: pid,
        providerLabel: label,
        model: m,
        transport: p.transport,
        authorized: true,
        enabled,
        isCurrent,
        sortRank,
      })
    }
  }

  return entries.sort((a, b) => {
    if (b.sortRank !== a.sortRank) return b.sortRank - a.sortRank
    const prov = a.providerLabel.localeCompare(b.providerLabel, 'ru')
    if (prov !== 0) return prov
    return a.model.localeCompare(b.model, 'ru')
  })
}

export function ModelPicker({ onOpenSettings, variant = 'pill' }: Props) {
  const t = useT()
  const provider = useProvider()
  const activeChatId = useProject(s => s.activeChatId)
  const refreshChatSessions = useProject(s => s.refreshChatSessions)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [providers, setProviders] = useState<ProviderDescriptorDTO[]>([])
  const [enabledModels, setEnabledModels] = useState<Set<string>>(new Set())
  const [authorizedIds, setAuthorizedIds] = useState<Set<ProviderId>>(new Set())
  const [storedModels, setStoredModels] = useState<Record<string, string>>({})
  const [currentAuthorized, setCurrentAuthorized] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await window.api.providers.list()
        if (cancelled) return
        setProviders(list)

        const [rawEnabled, rawCustomUrl, cliStatus, ...rest] = await Promise.all([
          window.api.settings.getKey('enabled_models'),
          window.api.settings.getKey('custom_openai_baseurl'),
          window.api.cliAuth.statusAll().catch(() => null as CliStatusMap | null),
          ...list.map(async p => {
            const keyVal = p.secretKey ? await window.api.settings.getKey(p.secretKey) : null
            const modelVal = await window.api.settings.getKey(`model_${p.id}`)
            return { id: p.id, keyVal, modelVal }
          }),
        ])
        if (cancelled) return

        const keys: Record<string, string> = {}
        const models: Record<string, string> = {}
        for (const p of list) {
          if (p.secretKey) keys[p.secretKey] = ''
        }
        rest.forEach((row, i) => {
          const p = list[i]
          if (p.secretKey && row.keyVal) keys[p.secretKey] = row.keyVal
          if (row.modelVal) models[p.id] = row.modelVal
        })

        if (!rawEnabled) {
          const pid = (await window.api.settings.getKey('provider')) ?? 'gemini-api'
          const m = (await window.api.settings.getKey(`model_${pid}`)) ?? 'auto'
          setEnabledModels(new Set([modelKey(pid, m)]))
        } else {
          const arr = JSON.parse(rawEnabled) as string[]
          setEnabledModels(new Set(Array.isArray(arr) ? arr : []))
        }

        const authorized = new Set<ProviderId>()
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
            authorized.add(p.id as ProviderId)
          }
        }
        setAuthorizedIds(authorized)
        setStoredModels(models)
        setCurrentAuthorized(authorized.has(provider.id))
      } catch {
        if (!cancelled) {
          setEnabledModels(new Set())
          setAuthorizedIds(new Set())
        }
      }
    })()
    return () => { cancelled = true }
  }, [open, provider.id])

  const entries = useMemo(
    () => buildPickerEntries(
      providers,
      enabledModels,
      authorizedIds,
      provider.id,
      provider.model,
      storedModels,
    ),
    [providers, enabledModels, authorizedIds, provider.id, provider.model, storedModels],
  )

  const readyEntries = entries.filter(e => e.authorized)
  const readyGroups = useMemo(() => groupEntriesByProvider(readyEntries), [readyEntries])

  async function persistOnSession(providerId: ProviderId, model: string | null) {
    if (!activeChatId) return
    try {
      await window.api.chatSessions.setModel(
        activeChatId,
        providerId,
        model && model.length > 0 ? model : null,
      )
      await refreshChatSessions()
    } catch { /* don't block UX */ }
  }

  async function selectEntry(entry: PickerEntry) {
    if (!entry.authorized) {
      setOpen(false)
      onOpenSettings()
      return
    }
    await provider.setProviderModel(entry.providerId, entry.model)
    await provider.setProviderId(entry.providerId)
    await persistOnSession(entry.providerId, entry.model)
    setCurrentAuthorized(true)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const triggerTitle = !currentAuthorized
    ? `${provider.label} · ${shortModel(provider.model)} — провайдер не подключён`
    : t.modelPicker.changeModel

  return (
    <div className={`gg-mp-wrap ${variant === 'footer' ? 'is-footer' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className={variant === 'footer' ? 'gg-provider-badge gg-provider-badge-btn' : 'gg-model-pill'}
        onClick={() => setOpen(v => !v)}
        title={triggerTitle}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className={`gg-provider-dot ${isCliProvider(provider.id) ? 'cli' : ''} ${!currentAuthorized ? 'is-offline' : ''}`} />
        {variant === 'footer' ? (
          <span className="gg-provider-badge-text">
            <span className="gg-provider-badge-name">{provider.label}</span>
            <span className="gg-provider-badge-sep">·</span>
            <span className="gg-provider-badge-model">{shortModel(provider.model)}</span>
            {!currentAuthorized && <span className="gg-provider-badge-warn">не подключён</span>}
          </span>
        ) : (
          <>
            <span className="gg-model-pill-name">{provider.label}</span>
            <span className="gg-model-pill-sep">·</span>
            <span className="gg-model-pill-transport">{shortModel(provider.model)}</span>
          </>
        )}
        <span className="gg-mp-chevron" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="gg-mp-popover gg-mp-popover-opaque" role="listbox">
          {readyEntries.length > 0 && (
            <div className="gg-mp-section">
              <div className="gg-mp-section-title">{t.modelPicker.connected}</div>
              {readyGroups.map(group => (
                <div key={group.key} className="gg-mp-provider-group">
                  <div className="gg-mp-provider-title">{group.label}</div>
                  {group.entries.map(e => (
                    <PickerRow key={modelKey(e.providerId, e.model)} entry={e} onSelect={() => void selectEntry(e)} />
                  ))}
                </div>
              ))}
            </div>
          )}

          {readyEntries.length === 0 && (
            <div className="gg-mp-section">
              <div className="gg-mp-row gg-mp-row-empty">
                <span className="gg-mp-row-label">{t.modelPicker.noConnected}</span>
                <span className="gg-mp-row-meta">{t.modelPicker.enableIn}</span>
              </div>
            </div>
          )}

          <div className="gg-mp-section">
            <button
              type="button"
              className="gg-mp-row gg-mp-settings-row"
              onClick={() => { setOpen(false); onOpenSettings() }}
            >
              <span className="gg-mp-row-label">{t.settings.settingsAndKeys}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function PickerRow({
  entry,
  locked,
  onSelect,
}: {
  entry: PickerEntry
  locked?: boolean
  onSelect: () => void
}) {
  const t = useT()
  const isCli = isCliProvider(entry.providerId)
  const cap = runtimeCapability(entry.providerId, entry.transport)
  const badge = tierBadge(t, cap.tier)
  const secBadge = isCli ? secretBadge(t, secretProtectionLevel(entry.providerId)) : null
  const policy = modelPolicyHint(entry.model)
  const showHiddenBadge = !entry.enabled && entry.authorized && !entry.isCurrent
  let title: string | undefined
  if (locked) title = 'Нужна авторизация — откроются Настройки'
  else if (badge) title = badge.hint
  else if (policy) title = policy.title
  else if (!entry.enabled && entry.isCurrent) {
    title = 'Модель отключена в Настройки → Модели, но активна в чате'
  }

  return (
    <button
      type="button"
      className={`gg-mp-row gg-mp-row-stack ${entry.isCurrent ? 'is-active' : ''} ${locked ? 'is-unconfigured' : ''}`}
      title={title}
      onClick={onSelect}
      role="option"
      aria-selected={entry.isCurrent}
    >
      <span className="gg-mp-row-top">
        <span className="gg-mp-row-label">
          {locked && <span className="gg-mp-lock">🔒</span>}
          <span className="gg-mp-row-provider">{entry.providerLabel}</span>
          <span className="gg-mp-row-title">
            <span className="gg-mp-row-model">{shortModel(entry.model)}</span>
            <span className={`gg-mp-badge gg-mp-badge-transport ${entry.transport === 'API' ? 'is-api' : entry.transport === 'Tunnel' ? 'is-tunnel' : 'is-cli'}`}>{entry.transport === 'Tunnel' ? 'Туннель' : entry.transport}</span>
          </span>
        </span>
        <span className="gg-mp-row-state">
          {showHiddenBadge && (
            <span
              className="gg-mp-row-hidden-pill"
              title="Модель подключена, но скрыта в настройках отображения. Здесь она видна только потому, что сейчас выбрана в этом чате."
            >
              Скрыта
            </span>
          )}
          {entry.isCurrent ? '✓' : ''}
        </span>
      </span>
      {(badge || secBadge || (policy && !isCli)) && (
        <span className="gg-mp-row-badges">
          {badge && (
            <span className={`gg-mp-badge is-muted is-${badge.tone}`} title={badge.hint}>{badge.label}</span>
          )}
          {secBadge && (
            <span className={`gg-mp-badge gg-mp-badge-secret is-sec-${secBadge.tone}`} title={secBadge.hint}>{secBadge.label}</span>
          )}
          {policy && !isCli && (
            <span className={`gg-mp-badge gg-mp-row-policy is-${policy.tone}`} title={policy.title}>{policy.label}</span>
          )}
        </span>
      )}
    </button>
  )
}
