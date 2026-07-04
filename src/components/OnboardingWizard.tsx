import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { DetectedProvidersList } from './DetectedProvidersList'
import { initEmptyEnabledModelsIfUnset, seedEnabledModelsIfUnset } from '../lib/enabled-models'
import type { DetectedCli, DetectedLocalServer } from '../types/api'

interface Props {
  onComplete: () => void
}

type Role = 'developer' | 'designer' | 'manager' | 'student'
type ApiProvider = 'verstak-gateway' | 'gemini-api' | 'anthropic' | 'yandexgpt'

const ROLE_PRESETS: Record<Role, {
  labelKey: 'roleDeveloper' | 'roleDesigner' | 'roleManager' | 'roleStudent'
  defaultProvider: string
  defaultModel: string
  skills: string[]
}> = {
  developer: { labelKey: 'roleDeveloper', defaultProvider: 'gemini-api', defaultModel: 'gemini-2.5-flash', skills: ['code-review', 'git-summary', 'explain-code'] },
  designer:  { labelKey: 'roleDesigner',  defaultProvider: 'gemini-api', defaultModel: 'gemini-2.5-flash', skills: ['explain-code'] },
  manager:   { labelKey: 'roleManager',   defaultProvider: 'gemini-api', defaultModel: 'gemini-2.5-flash', skills: ['git-summary'] },
  student:   { labelKey: 'roleStudent',   defaultProvider: 'gemini-api', defaultModel: 'gemini-2.5-flash', skills: ['explain-code'] },
}

const API_KEYS: Record<ApiProvider, { settingKey: string; provider: string; model: string }> = {
  // Рекомендованный для РФ: один ключ vsk_live_ → все модели, рубли, без VPN.
  'verstak-gateway': { settingKey: 'verstak_gateway_api_key', provider: 'verstak-gateway', model: 'kimi-k2.7-code' },
  'gemini-api': { settingKey: 'gemini_api_key', provider: 'gemini-api', model: 'gemini-2.5-flash' },
  anthropic: { settingKey: 'anthropic_api_key', provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  yandexgpt: { settingKey: 'yandex_api_key', provider: 'yandexgpt', model: 'yandexgpt/latest' },
}

export function OnboardingWizard({ onComplete }: Props) {
  const t = useT()
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('developer')
  const [apiProvider, setApiProvider] = useState<ApiProvider>('verstak-gateway')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clis, setClis] = useState<DetectedCli[]>([])
  const [localServers, setLocalServers] = useState<DetectedLocalServer[]>([])
  const [scanLoading, setScanLoading] = useState(true)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [connectedLabel, setConnectedLabel] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.api.userProfiles.list()
        if (list.length > 0) setName(prev => prev || list[0].name)
      } catch { /* */ }
    })()
    Promise.all([
      import('../lib/prefetch-cli').then(m => m.getDetectedClisCached()),
      window.api.localModels.scan().catch(() => [] as DetectedLocalServer[]),
    ]).then(([cliList, serverList]) => {
      setClis(cliList)
      setLocalServers(serverList)
    }).finally(() => setScanLoading(false))
  }, [])

  async function ensureProfile(provider: string, model: string) {
    const preset = ROLE_PRESETS[role]
    const list = await window.api.userProfiles.list()
    if (list.length === 0) {
      const profile = await window.api.userProfiles.create({
        name: name.trim() || 'User',
        role,
        defaultProvider: provider,
        defaultModel: model,
        skillsEnabled: preset.skills.length > 0 ? preset.skills : undefined,
      })
      await window.api.userProfiles.setActive(profile.id)
      return
    }
    const active = list.find(p => p.isActive) ?? list[0]
    await window.api.userProfiles.setActive(active.id)
  }

  async function applyProvider(provider: string, model: string, label?: string) {
    await window.api.settings.setKey('provider', provider)
    await window.api.settings.setKey(`model_${provider}`, model)
    await seedEnabledModelsIfUnset(provider, model)
    if (label) setConnectedLabel(label)
  }

  async function connectCli(cli: DetectedCli) {
    const supported = ['claude-cli', 'codex-cli', 'gemini-cli', 'grok-cli']
    if (!supported.includes(cli.id)) return
    setBusy(true)
    setConnectingId(cli.id)
    setError(null)
    try {
      await ensureProfile(cli.id, 'auto')
      await applyProvider(cli.id, 'auto', cli.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setConnectingId(null)
    }
  }

  async function connectLocalServer(server: DetectedLocalServer) {
    const model = server.models[0] ?? ''
    if (!model) {
      setError(t.auth.emptyModels.replace('{name}', server.name))
      return
    }
    const provider = server.id === 'ollama' ? 'ollama' : 'custom-openai'
    setBusy(true)
    setConnectingId(server.id)
    setError(null)
    try {
      if (provider === 'custom-openai') {
        await window.api.settings.setKey('custom_openai_baseurl', server.baseUrl)
        await window.api.settings.setKey('custom_openai_models', server.models.join(', '))
      }
      await ensureProfile(provider, model)
      await applyProvider(provider, model, server.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setConnectingId(null)
    }
  }

  async function complete(tryPipeline = false) {
    setBusy(true)
    setError(null)
    try {
      const preset = ROLE_PRESETS[role]
      const apiMeta = API_KEYS[apiProvider]

      if (!connectedLabel) {
        await ensureProfile(preset.defaultProvider, preset.defaultModel)
        await window.api.settings.setKey('provider', preset.defaultProvider)
        await window.api.settings.setKey(`model_${preset.defaultProvider}`, preset.defaultModel)
      }

      if (apiKey.trim()) {
        await window.api.settings.setKey(apiMeta.settingKey, apiKey.trim())
        if (!connectedLabel) {
          await applyProvider(apiMeta.provider, apiMeta.model)
        } else {
          await seedEnabledModelsIfUnset(apiMeta.provider, apiMeta.model)
        }
      } else if (!connectedLabel) {
        await initEmptyEnabledModelsIfUnset()
      }

      await window.api.settings.setKey('onboarding_completed', '1')
      // First Win (D10): открыть Pipeline с демо-брифом после онбординга.
      if (tryPipeline) await window.api.settings.setKey('pipeline_sample_pending', '1')
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  async function skip() {
    setBusy(true)
    try {
      const list = await window.api.userProfiles.list()
      if (list.length === 0) {
        const p = await window.api.userProfiles.create({ name: 'User', role: 'developer' })
        await window.api.userProfiles.setActive(p.id)
      } else if (!list.some(p => p.isActive)) {
        await window.api.userProfiles.setActive(list[0].id)
      }
      await initEmptyEnabledModelsIfUnset()
      await window.api.settings.setKey('onboarding_completed', '1')
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const preset = ROLE_PRESETS[role]
  const roleLabel = t.onboarding[preset.labelKey]
  const skillsHint = preset.skills.length > 0
    ? t.onboarding.roleHintSkills.replace('{list}', preset.skills.join(', '))
    : ''

  const apiPlaceholder = apiProvider === 'verstak-gateway'
    ? t.onboarding.apiVerstakGatewayPlaceholder
    : apiProvider === 'gemini-api'
      ? t.onboarding.apiGeminiPlaceholder
      : apiProvider === 'anthropic'
        ? t.onboarding.apiAnthropicPlaceholder
        : t.onboarding.apiYandexPlaceholder

  return (
    <div className="gg-onboarding-overlay">
      <div className="gg-onboarding-card">
        <div className="gg-onboarding-header">
          <span className="gg-onboarding-step">
            {t.onboarding.stepOf.replace('{step}', String(step)).replace('{total}', '3')}
          </span>
          <h2 className="gg-onboarding-title">
            {step === 1 && t.onboarding.step1Title}
            {step === 2 && t.onboarding.step2Title}
            {step === 3 && t.onboarding.step3Title}
          </h2>
        </div>

        <div className="gg-onboarding-body">
          {step === 1 && (
            <>
              <p className="gg-onboarding-text">{t.onboarding.intro}</p>
              <div className="gg-onboarding-field">
                <label>{t.onboarding.nameLabel}</label>
                <input
                  type="text"
                  className="gg-input"
                  placeholder={t.onboarding.namePlaceholder}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="gg-onboarding-field">
                <label>{t.onboarding.roleLabel}</label>
                <div className="gg-onboarding-roles">
                  {(Object.keys(ROLE_PRESETS) as Role[]).map(r => (
                    <button
                      key={r}
                      type="button"
                      className={`gg-onboarding-role ${role === r ? 'is-active' : ''}`}
                      onClick={() => setRole(r)}
                    >
                      {t.onboarding[ROLE_PRESETS[r].labelKey]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="gg-onboarding-hint">
                {t.onboarding.roleHint
                  .replace('{provider}', preset.defaultProvider)
                  .replace('{model}', preset.defaultModel)
                  .replace('{skills}', skillsHint)}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="gg-onboarding-text">{t.onboarding.step2Intro}</p>
              <DetectedProvidersList
                clis={clis}
                localServers={localServers}
                scanLoading={scanLoading}
                busy={busy}
                connectingId={connectingId}
                onConnectCli={cli => void connectCli(cli)}
                onConnectLocal={server => void connectLocalServer(server)}
                className="gg-auth-detected gg-onboarding-detected"
              />
              {connectedLabel && (
                <div className="gg-onboarding-hint">
                  {t.onboarding.summaryConnected.replace('{name}', connectedLabel)}
                </div>
              )}
              <div className="gg-onboarding-field">
                <label>{t.onboarding.apiOptional}</label>
                <select
                  className="gg-input"
                  value={apiProvider}
                  onChange={e => {
                    setApiProvider(e.target.value as ApiProvider)
                    setApiKey('')
                  }}
                >
                  <option value="verstak-gateway">{t.onboarding.apiVerstakGateway}</option>
                  <option value="gemini-api">{t.onboarding.apiGemini}</option>
                  <option value="anthropic">{t.onboarding.apiAnthropic}</option>
                  <option value="yandexgpt">{t.onboarding.apiYandex}</option>
                </select>
              </div>
              <div className="gg-onboarding-field">
                <input
                  type="password"
                  className="gg-input"
                  placeholder={apiPlaceholder}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                />
              </div>
              {apiProvider === 'verstak-gateway' && (
                <div className="gg-onboarding-hint">
                  {t.onboarding.apiVerstakGatewayHint}{' '}
                  <a
                    href="https://agi-iri.ru/gateway"
                    onClick={e => { e.preventDefault(); void window.api.app.openExternal('https://agi-iri.ru/gateway') }}
                  >agi-iri.ru/gateway</a>
                </div>
              )}
              <div className="gg-onboarding-hint">{t.onboarding.apiHint}</div>
            </>
          )}

          {step === 3 && (
            <>
              <p className="gg-onboarding-text">{t.onboarding.step3Intro}</p>
              <ul className="gg-onboarding-summary">
                <li>👤 <strong>{name || 'User'}</strong> · {roleLabel}</li>
                <li>
                  🤖 {connectedLabel
                    ? t.onboarding.summaryConnected.replace('{name}', connectedLabel)
                    : t.onboarding.summaryProvider
                      .replace('{provider}', preset.defaultProvider)
                      .replace('{model}', preset.defaultModel)}
                </li>
                <li>
                  🎭 {t.onboarding.summarySkills.replace(
                    '{list}',
                    preset.skills.length > 0 ? preset.skills.join(', ') : t.onboarding.summarySkillsNone,
                  )}
                </li>
                <li>🔑 {apiKey ? t.onboarding.summaryApiSet : t.onboarding.summaryApiLater}</li>
              </ul>
              <div className="gg-onboarding-hint">{t.onboarding.connectorsHint}</div>
            </>
          )}
          {error && <div className="gg-onboarding-error">⚠ {error}</div>}
        </div>

        <div className="gg-onboarding-actions">
          {step > 1 && (
            <button type="button" className="gg-btn" onClick={() => setStep(step - 1)} disabled={busy}>
              {t.onboarding.back}
            </button>
          )}
          <div style={{ flex: 1 }} />
          {step === 1 && (
            <>
              <button type="button" className="gg-btn gg-btn-ghost" onClick={() => void skip()} disabled={busy}>
                {t.onboarding.skip}
              </button>
              <button
                type="button"
                className="gg-btn gg-btn-primary"
                onClick={() => setStep(2)}
                disabled={busy || !name.trim()}
              >{t.onboarding.next}</button>
            </>
          )}
          {step === 2 && (
            <button type="button" className="gg-btn gg-btn-primary" onClick={() => setStep(3)} disabled={busy}>
              {t.onboarding.next}
            </button>
          )}
          {step === 3 && (
            <>
              <button type="button" className="gg-btn gg-btn-ghost" onClick={() => void complete(true)} disabled={busy}>
                ▶ {t.pipeline.tryIt}
              </button>
              <button type="button" className="gg-btn gg-btn-primary" onClick={() => void complete()} disabled={busy}>
                {busy ? t.onboarding.saving : t.onboarding.start}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
