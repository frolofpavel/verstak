import { useEffect, useState } from 'react'

/**
 * OnboardingWizard — мастер первого запуска для нового сотрудника.
 *
 * Источник: V3 Plan раздел 10.1.
 *
 * Шаги:
 *  1. Привет — кто ты? (имя + роль)
 *  2. API key Anthropic (минимально один; остальные опционально)
 *  3. Опционально — Google Sheets / Telegram / SSH (с подсказкой «можно позже»)
 *  4. Готово — открывается главный экран
 *
 * Триггер: при старте App.tsx проверяется settings.getKey('onboarding_completed').
 * Если пусто и user_profiles пустой → показывается wizard.
 *
 * Отмена/Skip: создаёт минимальный профиль «Pavel / без роли» и помечает
 * onboarding completed. Пользователь может донастроить через Settings.
 */

interface Props {
  onComplete: () => void
}

type Role = 'owner' | 'sales' | 'delivery' | 'analytics' | 'finance' | 'other'

const ROLE_PRESETS: Record<Role, { label: string; defaultProvider: string; defaultModel: string; skills: string[] }> = {
  owner:     { label: 'Владелец / Pavel',         defaultProvider: 'claude', defaultModel: 'claude-sonnet-4-6', skills: ['bos-mkt', 'bos-sales', 'bos-pilot', 'client-cycle'] },
  sales:     { label: 'Продажи / Кристина',       defaultProvider: 'claude', defaultModel: 'claude-haiku-4-5',  skills: ['bos-sales', 'client-cycle'] },
  delivery:  { label: 'Delivery / Ярослав',       defaultProvider: 'claude', defaultModel: 'claude-sonnet-4-6', skills: ['bos-pilot', 'client-cycle'] },
  analytics: { label: 'Аналитика / Игорь',        defaultProvider: 'gemini-api', defaultModel: 'gemini-3.5-flash', skills: ['bos-mkt'] },
  finance:   { label: 'Финансы / Надежда',        defaultProvider: 'claude', defaultModel: 'claude-haiku-4-5',  skills: [] },
  other:     { label: 'Другая роль',              defaultProvider: 'claude', defaultModel: 'claude-sonnet-4-6', skills: ['bos-mkt', 'bos-sales', 'client-cycle'] }
}

export function OnboardingWizard({ onComplete }: Props) {
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('owner')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Если уже есть профили — pre-fill name
    void (async () => {
      try {
        const list = await window.api.userProfiles.list()
        if (list.length > 0 && !name) setName(list[0].name)
      } catch { /* */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function complete() {
    setBusy(true)
    setError(null)
    try {
      const preset = ROLE_PRESETS[role]
      // 1) Создаём профиль
      const profile = await window.api.userProfiles.create({
        name: name.trim() || 'Pavel',
        role,
        defaultProvider: preset.defaultProvider,
        defaultModel: preset.defaultModel,
        skillsEnabled: preset.skills.length > 0 ? preset.skills : undefined
      })
      await window.api.userProfiles.setActive(profile.id)

      // 2) Сохраняем API key (если введён)
      if (apiKey.trim()) {
        await window.api.settings.setKey('anthropic_api_key', apiKey.trim())
      }

      // 3) Применяем default provider/model к settings
      if (preset.defaultProvider) {
        await window.api.settings.setKey('provider', preset.defaultProvider)
      }
      if (preset.defaultModel) {
        await window.api.settings.setKey(`model_${preset.defaultProvider}`, preset.defaultModel)
      }

      // 4) Помечаем onboarding completed
      await window.api.settings.setKey('onboarding_completed', '1')

      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  async function skip() {
    setBusy(true)
    try {
      // Создаём минимальный профиль если совсем нет
      const list = await window.api.userProfiles.list()
      if (list.length === 0) {
        const p = await window.api.userProfiles.create({ name: 'Pavel', role: 'owner' })
        await window.api.userProfiles.setActive(p.id)
      } else if (!list.some(p => p.isActive)) {
        await window.api.userProfiles.setActive(list[0].id)
      }
      await window.api.settings.setKey('onboarding_completed', '1')
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="gg-onboarding-overlay">
      <div className="gg-onboarding-card">
        <div className="gg-onboarding-header">
          <span className="gg-onboarding-step">Шаг {step} из 3</span>
          <h2 className="gg-onboarding-title">
            {step === 1 && 'Привет! Как тебя зовут?'}
            {step === 2 && 'API key Anthropic'}
            {step === 3 && 'Готово'}
          </h2>
        </div>

        <div className="gg-onboarding-body">
          {step === 1 && (
            <>
              <p className="gg-onboarding-text">
                GeminiGrok — твой второй мозг для работы в агентстве. Чтобы подобрать правильный
                набор скиллов и провайдеров — расскажи кто ты.
              </p>
              <div className="gg-onboarding-field">
                <label>Имя</label>
                <input
                  type="text"
                  className="gg-input"
                  placeholder="Например: Кристина"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="gg-onboarding-field">
                <label>Роль</label>
                <div className="gg-onboarding-roles">
                  {(Object.keys(ROLE_PRESETS) as Role[]).map(r => (
                    <button
                      key={r}
                      type="button"
                      className={`gg-onboarding-role ${role === r ? 'is-active' : ''}`}
                      onClick={() => setRole(r)}
                    >
                      {ROLE_PRESETS[r].label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="gg-onboarding-hint">
                Под выбранную роль автоматически настроится провайдер ({ROLE_PRESETS[role].defaultProvider}),
                модель ({ROLE_PRESETS[role].defaultModel}) и набор скиллов
                {ROLE_PRESETS[role].skills.length > 0 ? ` (${ROLE_PRESETS[role].skills.join(', ')})` : ''}.
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <p className="gg-onboarding-text">
                Для работы с Claude нужен API key. Получить: <code>console.anthropic.com</code> → Settings → API Keys.
              </p>
              <div className="gg-onboarding-field">
                <label>API Key (sk-ant-...)</label>
                <input
                  type="password"
                  className="gg-input"
                  placeholder="sk-ant-..."
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="gg-onboarding-hint">
                Ключ шифруется системным хранилищем Windows и никогда не покидает твою машину.
                Можно ввести позже через Settings — пропусти этот шаг если ещё нет ключа.
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <p className="gg-onboarding-text">
                Всё готово. После «Начать» откроется главный экран.
              </p>
              <ul className="gg-onboarding-summary">
                <li>👤 <strong>{name || 'Pavel'}</strong> · {ROLE_PRESETS[role].label}</li>
                <li>🤖 Провайдер: <code>{ROLE_PRESETS[role].defaultProvider}</code> / <code>{ROLE_PRESETS[role].defaultModel}</code></li>
                <li>🎭 Активные скиллы: {ROLE_PRESETS[role].skills.length > 0 ? ROLE_PRESETS[role].skills.join(', ') : '—'}</li>
                <li>🔑 API key: {apiKey ? '✓ задан' : '⚠ нужно ввести позже в Settings'}</li>
              </ul>
              <div className="gg-onboarding-hint">
                Коннекторы (Google Sheets, Telegram, Битрикс24, Я.Директ) и SSH — настраиваются в Settings
                по мере необходимости. См. DEVLOG.md в проекте geminigrok.
              </div>
            </>
          )}
          {error && <div className="gg-onboarding-error">⚠ {error}</div>}
        </div>

        <div className="gg-onboarding-actions">
          {step > 1 && <button type="button" className="gg-btn" onClick={() => setStep(step - 1)} disabled={busy}>← Назад</button>}
          <div style={{ flex: 1 }} />
          {step === 1 && (
            <>
              <button type="button" className="gg-btn gg-btn-ghost" onClick={() => void skip()} disabled={busy}>
                Пропустить wizard
              </button>
              <button
                type="button"
                className="gg-btn gg-btn-primary"
                onClick={() => setStep(2)}
                disabled={busy || !name.trim()}
              >Далее →</button>
            </>
          )}
          {step === 2 && (
            <button type="button" className="gg-btn gg-btn-primary" onClick={() => setStep(3)} disabled={busy}>
              Далее →
            </button>
          )}
          {step === 3 && (
            <button type="button" className="gg-btn gg-btn-primary" onClick={() => void complete()} disabled={busy}>
              {busy ? 'Сохраняю…' : 'Начать работу'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
