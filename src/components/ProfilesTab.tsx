import { useEffect, useState } from 'react'
import type { UserProfile } from '../types/api'

/**
 * Управление профилями пользователей в Settings → Профили.
 *
 * Источник: V3 Plan раздел 10.2.
 *
 * Каждый профиль = роль с пресетами
 * (provider, model, skills). При активации профиля settings обновляются
 * под него.
 */
export function ProfilesTab() {
  const [profiles, setProfiles] = useState<UserProfile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  async function reload() {
    try {
      const list = await window.api.userProfiles.list()
      setProfiles(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => { void reload() }, [])

  async function activate(id: number) {
    setBusy(true)
    try {
      await window.api.userProfiles.setActive(id)
      const profile = profiles.find(p => p.id === id)
      if (profile) {
        // Применяем provider/model
        if (profile.defaultProvider) {
          await window.api.settings.setKey('provider', profile.defaultProvider)
          if (profile.defaultModel) {
            await window.api.settings.setKey(`model_${profile.defaultProvider}`, profile.defaultModel)
          }
        }
      }
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: number, name: string) {
    if (!window.confirm(`Удалить профиль «${name}»?\n\nЕсли это активный профиль — другой нужно будет выбрать вручную.`)) return
    setBusy(true)
    try {
      await window.api.userProfiles.remove(id)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gg-settings-extra">
      <div className="gg-settings-section-title">Профили пользователей</div>
      <div className="gg-settings-hint" style={{ marginBottom: 14 }}>
        Каждый профиль — это роль с предустановленным провайдером/моделью/скиллами.
        Полезно когда Verstak установлен у нескольких сотрудников агентства, или
        когда нужно переключаться между «owner» и «sales» режимами.
      </div>

      {error && (
        <div className="gg-onboarding-error" style={{ marginBottom: 14 }}>⚠ {error}</div>
      )}

      {profiles.length === 0 ? (
        <div className="gg-settings-row">
          <div style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
            Профилей нет. Создай первый через кнопку ниже или через Onboarding wizard
            при первом запуске.
          </div>
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-default)' }}>
              <th style={{ textAlign: 'left', padding: '8px 6px', fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Имя</th>
              <th style={{ textAlign: 'left', padding: '8px 6px', fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Роль</th>
              <th style={{ textAlign: 'left', padding: '8px 6px', fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Провайдер / Модель</th>
              <th style={{ textAlign: 'right', padding: '8px 6px', fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map(p => (
              <tr key={p.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <td style={{ padding: '10px 6px', fontWeight: p.isActive ? 600 : 400 }}>
                  {p.isActive && <span style={{ color: 'var(--success)', marginRight: 6 }}>●</span>}
                  {p.name}
                </td>
                <td style={{ padding: '10px 6px', color: 'var(--text-secondary)', fontSize: 12 }}>
                  {p.role ?? '—'}
                </td>
                <td style={{ padding: '10px 6px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
                  {p.defaultProvider ?? '—'} {p.defaultModel ? `· ${p.defaultModel}` : ''}
                </td>
                <td style={{ padding: '10px 6px', textAlign: 'right' }}>
                  {!p.isActive && (
                    <button
                      type="button"
                      className="gg-btn gg-btn-ghost"
                      onClick={() => void activate(p.id)}
                      disabled={busy}
                      style={{ marginRight: 6 }}
                    >Активировать</button>
                  )}
                  <button
                    type="button"
                    className="gg-btn gg-btn-ghost"
                    onClick={() => void remove(p.id, p.name)}
                    disabled={busy}
                    style={{ color: 'var(--error)' }}
                  >×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!showCreate ? (
        <button
          type="button"
          className="gg-btn"
          onClick={() => setShowCreate(true)}
          disabled={busy}
        >+ Создать профиль</button>
      ) : (
        <CreateProfileForm
          onCancel={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); void reload() }}
        />
      )}
    </div>
  )
}

interface CreateProps {
  onCancel: () => void
  onCreated: () => void
}

function CreateProfileForm({ onCancel, onCreated }: CreateProps) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [provider, setProvider] = useState('claude-cli')
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!name.trim()) return
    setBusy(true)
    try {
      await window.api.userProfiles.create({
        name: name.trim(),
        role: role.trim() || undefined,
        defaultProvider: provider,
        defaultModel: model
      })
      onCreated()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="gg-settings-row" style={{ flexDirection: 'column', gap: 10, border: '1px solid var(--border-default)', padding: 16, borderRadius: 'var(--radius-md)' }}>
      <input
        type="text"
        className="gg-input"
        placeholder="Имя (например Кристина)"
        value={name}
        onChange={e => setName(e.target.value)}
        autoFocus
      />
      <input
        type="text"
        className="gg-input"
        placeholder="Роль (sales / delivery / analytics / finance / other)"
        value={role}
        onChange={e => setRole(e.target.value)}
      />
      <input
        type="text"
        className="gg-input"
        placeholder="Default provider (claude-cli / claude / gemini-api / grok / openai / codex-cli)"
        value={provider}
        onChange={e => setProvider(e.target.value)}
      />
      <input
        type="text"
        className="gg-input"
        placeholder="Default model (например claude-sonnet-4-6)"
        value={model}
        onChange={e => setModel(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="button" className="gg-btn gg-btn-ghost" onClick={onCancel} disabled={busy}>Отмена</button>
        <button type="button" className="gg-btn gg-btn-primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
          {busy ? 'Сохраняю…' : 'Создать'}
        </button>
      </div>
    </div>
  )
}
