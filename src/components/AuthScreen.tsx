import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import type { Lang } from '../i18n'
import authBgUrl from '../assets/auth-bg.webp'
import authVideoUrl from '../assets/auth-bg.mp4'
import iconUrl from '../assets/icon.png'
import type { DetectedCli, DetectedLocalServer } from '../types/api'
import { initEmptyEnabledModelsIfUnset, seedEnabledModelsIfUnset } from '../lib/enabled-models'
import { DetectedProvidersList } from './DetectedProvidersList'

/**
 * AuthScreen — экран регистрации/входа. Показывается ПЕРЕД основным приложением
 * если auth_completed не установлен в settings.
 *
 * Логика:
 * - Нет профилей → только Sign Up
 * - Есть профили (>1) → Sign In по умолчанию, ссылка на Sign Up
 * - Ровно 1 профиль → автовход без показа экрана (вызывается из App.tsx)
 */

interface Props {
  onComplete: () => void
  onLangChange: (lang: Lang) => void
}

type Role = 'developer' | 'designer' | 'manager' | 'student'

const ROLES: { value: Role; label: string; icon: string }[] = [
  { value: 'developer', label: 'Developer', icon: '⚡' },
  { value: 'designer',  label: 'Designer',  icon: '🎨' },
  { value: 'manager',   label: 'Manager',   icon: '📋' },
  { value: 'student',   label: 'Student',   icon: '📚' },
]

const ROLE_DEFAULTS: Record<Role, { provider: string; model: string }> = {
  developer: { provider: 'gemini-api', model: 'gemini-2.5-flash' },
  designer:  { provider: 'gemini-api', model: 'gemini-2.5-flash' },
  manager:   { provider: 'gemini-api', model: 'gemini-2.5-flash' },
  student:   { provider: 'gemini-api', model: 'gemini-2.5-flash' },
}

interface Profile {
  id: number
  name: string
  role?: string | null
  isActive?: boolean | null
}

export function AuthScreen({ onComplete, onLangChange }: Props) {
  const t = useT()
  const [langChosen, setLangChosen] = useState<boolean | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  // 'signup' | 'signin'
  const [mode, setMode] = useState<'signup' | 'signin'>('signup')

  // Sign Up state
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('developer')

  // Sign In state
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // fade-out animation при успешном входе
  const [leaving, setLeaving] = useState(false)
  const [clis, setClis] = useState<DetectedCli[]>([])
  const [localServers, setLocalServers] = useState<DetectedLocalServer[]>([])
  const [scanLoading, setScanLoading] = useState(true)
  const [connectingId, setConnectingId] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const langVal = await window.api.settings.getKey('app_language')
        setLangChosen(!!langVal)
      } catch {
        setLangChosen(false)
      }
      try {
        const list: Profile[] = await window.api.userProfiles.list()
        setProfiles(list)
        if (list.length > 0) {
          setMode('signin')
          const active = list.find(p => p.isActive) ?? list[0]
          setSelectedProfileId(active.id)
        }
      } catch { /* первый запуск */ }
      setLoading(false)
    })()
    Promise.all([
      import('../lib/prefetch-cli').then(m => m.getDetectedClisCached()),
      window.api.localModels.scan().catch(() => [] as DetectedLocalServer[])
    ]).then(([cliList, serverList]) => {
      setClis(cliList)
      setLocalServers(serverList)
    }).finally(() => setScanLoading(false))
  }, [])

  async function ensureProfile(provider: string, model: string) {
    const list: Profile[] = await window.api.userProfiles.list()
    if (list.length === 0) {
      const profile = await window.api.userProfiles.create({
        name: name.trim() || 'User',
        role,
        defaultProvider: provider,
        defaultModel: model,
      })
      await window.api.userProfiles.setActive(profile.id)
      return
    }
    const active = list.find(p => p.isActive) ?? list[0]
    await window.api.userProfiles.setActive(active.id)
  }

  async function activateProvider(provider: string, model: string) {
    await window.api.settings.setKey('provider', provider)
    await window.api.settings.setKey(`model_${provider}`, model)
    await seedEnabledModelsIfUnset(provider, model)
    await window.api.settings.setKey('auth_completed', 'true')
    await window.api.settings.setKey('onboarding_completed', '1')
  }

  async function connectCli(cli: DetectedCli) {
    const supported = ['claude-cli', 'codex-cli', 'gemini-cli', 'grok-cli']
    if (!supported.includes(cli.id)) return
    setBusy(true)
    setConnectingId(cli.id)
    setError(null)
    try {
      await ensureProfile(cli.id, 'auto')
      await activateProvider(cli.id, 'auto')
      doLeave()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
      await activateProvider(provider, model)
      doLeave()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
      setConnectingId(null)
    }
  }

  async function handleSignUp() {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const preset = ROLE_DEFAULTS[role]
      const profile = await window.api.userProfiles.create({
        name: name.trim(),
        role,
        defaultProvider: preset.provider,
        defaultModel: preset.model,
      })
      await window.api.userProfiles.setActive(profile.id)
      await window.api.settings.setKey('provider', preset.provider)
      await window.api.settings.setKey(`model_${preset.provider}`, preset.model)
      await initEmptyEnabledModelsIfUnset()
      await window.api.settings.setKey('auth_completed', 'true')
      await window.api.settings.setKey('onboarding_completed', '1')
      doLeave()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  async function handleSignIn() {
    if (!selectedProfileId) return
    setBusy(true)
    setError(null)
    try {
      await window.api.userProfiles.setActive(selectedProfileId)
      await window.api.settings.setKey('auth_completed', 'true')
      doLeave()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  function doLeave() {
    setLeaving(true)
    setTimeout(() => onComplete(), 450)
  }

  if (loading) return null

  // Language picker on first launch
  if (langChosen === false) {
    return (
      <div className="gg-lang-picker">
        <img src={iconUrl} alt="" className="gg-lang-picker-logo" width={60} height={60} />
        <h1>Verstak</h1>
        <p>Choose your language / Выберите язык</p>
        <div className="gg-lang-buttons">
          <button onClick={() => { setLangChosen(true); onLangChange('en'); void window.api.settings.setKey('app_language', 'en') }}>
            English
          </button>
          <button onClick={() => { setLangChosen(true); onLangChange('ru'); void window.api.settings.setKey('app_language', 'ru') }}>
            Русский
          </button>
        </div>
      </div>
    )
  }

  const hasProfiles = profiles.length > 0

  return (
    <div className={`gg-auth-root${leaving ? ' is-leaving' : ''}`}>
      {/* ── Left panel: visual / animation ── */}
      <div className="gg-auth-left">
        {/* Фоновое видео — Higgsfield Seedance 2.0 loop */}
        <video
          className="gg-auth-bg-video"
          src={authVideoUrl}
          autoPlay
          loop
          muted
          playsInline
          poster={authBgUrl}
        />

        {/* CSS orbs — fallback и подложка */}
        <div className="gg-auth-orb gg-auth-orb-1" />
        <div className="gg-auth-orb gg-auth-orb-2" />
        <div className="gg-auth-orb gg-auth-orb-3" />

        {/* Контент поверх */}
        <div className="gg-auth-left-content">
          <div className="gg-auth-logo-wrap">
            <img src={iconUrl} alt="" className="gg-auth-logo-icon" width={48} height={48} />
            <span className="gg-auth-logo-text">Verstak</span>
          </div>
          <p className="gg-auth-tagline">{t.auth.tagline}</p>

          <ul className="gg-auth-features">
            <li>
              <span className="gg-auth-feature-dot" />
              {t.auth.features.providers}
            </li>
            <li>
              <span className="gg-auth-feature-dot" />
              {t.auth.features.memory}
            </li>
            <li>
              <span className="gg-auth-feature-dot" />
              {t.auth.features.agents}
            </li>
          </ul>

          <DetectedProvidersList
            clis={clis}
            localServers={localServers}
            scanLoading={scanLoading}
            busy={busy}
            connectingId={connectingId}
            onConnectCli={cli => void connectCli(cli)}
            onConnectLocal={server => void connectLocalServer(server)}
          />
        </div>
      </div>

      {/* ── Right panel: auth form ── */}
      <div className="gg-auth-right">
        <div className="gg-auth-form-wrap">
          {/* Tab toggle — только если есть профили */}
          {hasProfiles && (
            <div className="gg-auth-tabs">
              <button
                type="button"
                className={`gg-auth-tab${mode === 'signin' ? ' is-active' : ''}`}
                onClick={() => { setMode('signin'); setError(null) }}
              >
                {t.auth.signIn}
              </button>
              <button
                type="button"
                className={`gg-auth-tab${mode === 'signup' ? ' is-active' : ''}`}
                onClick={() => { setMode('signup'); setError(null) }}
              >
                {t.auth.newProfile}
              </button>
            </div>
          )}

          {!hasProfiles && (
            <div className="gg-auth-form-header">
              <h1 className="gg-auth-form-title">{t.auth.welcome}</h1>
              <p className="gg-auth-form-sub">{t.auth.createProfile}</p>
            </div>
          )}

          {/* ── Sign In ── */}
          {mode === 'signin' && hasProfiles && (
            <div className="gg-auth-form">
              <div className="gg-auth-field">
                <label className="gg-auth-label">{t.auth.profile}</label>
                <select
                  className="gg-auth-input gg-auth-select"
                  value={selectedProfileId ?? ''}
                  onChange={e => setSelectedProfileId(Number(e.target.value))}
                >
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.role ? ` · ${p.role}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {error && <div className="gg-auth-error">{error}</div>}

              <button
                type="button"
                className="gg-auth-submit"
                onClick={() => void handleSignIn()}
                disabled={busy || !selectedProfileId}
              >
                {busy ? t.auth.enteringProfile : t.auth.enter}
              </button>
            </div>
          )}

          {/* ── Sign Up ── */}
          {(mode === 'signup' || !hasProfiles) && (
            <div className="gg-auth-form">
              <div className="gg-auth-field">
                <label className="gg-auth-label">{t.auth.name}</label>
                <input
                  type="text"
                  className="gg-auth-input"
                  placeholder={t.auth.nameHint}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && name.trim()) void handleSignUp() }}
                  autoFocus
                />
              </div>

              <div className="gg-auth-field">
                <label className="gg-auth-label">{t.auth.email}</label>
                <input
                  type="email"
                  className="gg-auth-input"
                  placeholder={t.auth.emailHint}
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </div>

              <div className="gg-auth-field">
                <label className="gg-auth-label">{t.auth.role}</label>
                <div className="gg-auth-roles">
                  {ROLES.map(r => (
                    <button
                      key={r.value}
                      type="button"
                      className={`gg-auth-role-btn${role === r.value ? ' is-active' : ''}`}
                      onClick={() => setRole(r.value)}
                    >
                      <span className="gg-auth-role-icon">{r.icon}</span>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              {error && <div className="gg-auth-error">{error}</div>}

              <button
                type="button"
                className="gg-auth-submit"
                onClick={() => void handleSignUp()}
                disabled={busy || !name.trim()}
              >
                {busy ? t.auth.creatingProfile : t.auth.startWorking}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
