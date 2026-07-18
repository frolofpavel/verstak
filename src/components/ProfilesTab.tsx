import { useCallback, useEffect, useState } from 'react'
import type { UserProfile } from '../types/api'

// 2.0.8-G: живая вкладка «Профили» поверх userProfiles API (list/setActive). Раньше был
// «Скоро»-плейсхолдер; теперь показывает РЕАЛЬНЫЕ профили устройства и даёт переключить
// активный (та же семантика, что вход по существующему профилю в AuthScreen — setActive,
// без насильной смены провайдера текущей сессии). Организация/команда/доступы — следующий этап.

// Иконки под роли онбординга (AuthScreen ROLES). Неизвестная роль → нейтральный аватар.
const ROLE_ICON: Record<string, string> = {
  developer: '⚡', designer: '🎨', manager: '📋', student: '📚',
}

export function ProfilesTab() {
  const [profiles, setProfiles] = useState<UserProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState<number | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    void window.api.userProfiles
      .list()
      .then(list => { setProfiles(list); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const makeActive = useCallback(async (id: number) => {
    setSwitching(id)
    try {
      await window.api.userProfiles.setActive(id)
      load()
    } finally {
      setSwitching(null)
    }
  }, [load])

  return (
    <div className="gg-settings-extra gg-profiles-tab">
      <h2 className="gg-settings-page-title">Профиль и организация</h2>
      <p className="gg-models-intro">
        Профили пользователей этого устройства — у каждого своя роль и модель по умолчанию.
        Активный профиль определяет, под кем вы работаете. Новый профиль создаётся на экране
        входа; организация, команда и доступы — следующий этап.
      </p>

      {loading && <p className="gg-models-card-desc">Загрузка…</p>}
      {!loading && profiles.length === 0 && (
        <p className="gg-models-card-desc">Пока нет профилей. Создайте первый на экране входа.</p>
      )}

      <div className="gg-profiles-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {profiles.map(p => (
          <div
            key={p.id}
            className={`gg-profile-row${p.isActive ? ' is-active' : ''}`}
            style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
          >
            <span className="gg-profile-avatar" aria-hidden>{ROLE_ICON[p.role ?? ''] ?? '👤'}</span>
            <span className="gg-profile-name" style={{ fontWeight: 600 }}>{p.name}</span>
            {p.role && <span className="gg-profile-role gg-models-card-desc">{p.role}</span>}
            {p.defaultModel && <span className="gg-profile-model gg-models-card-desc">· {p.defaultModel}</span>}
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {p.isActive ? (
                <span className="gg-profile-active-badge">Активен</span>
              ) : (
                <button
                  type="button"
                  className="gg-btn"
                  disabled={switching != null}
                  onClick={() => { void makeActive(p.id) }}
                >
                  {switching === p.id ? 'Переключаю…' : 'Сделать активным'}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
