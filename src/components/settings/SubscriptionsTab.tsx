import { useEffect, useState } from 'react'
import type { SubscriptionAccountDto } from '../../types/api'

// Срез 2.0.8-B: вкладка «Подписки» — обзор аккаунтов подписочных/CLI-провайдеров с
// честным состоянием (ready/cooling/login-required/invalid) и областью остывания.
//
// STANDALONE (решение координатора): компонент готов, но НЕ вшивается в Settings.tsx до
// merge живой ветки Ильи (чтобы не создавать конфликт в его зоне). Подключение табов —
// срез после merge Ильи. DTO — renderer-safe (без токена/credRef/configDir/baseUrl).

const STATE_LABEL: Record<SubscriptionAccountDto['state'], string> = {
  ready: 'готов',
  cooling: 'остывает',
  'login-required': 'нужен вход',
  invalid: 'ошибка',
}

const REASON_LABEL: Record<string, string> = {
  quota: 'квота',
  'rate-limit': 'лимит частоты',
  auth: 'авторизация',
  'provider-unavailable': 'провайдер недоступен',
  unknown: 'причина неизвестна',
}

export function SubscriptionsTab() {
  const [accounts, setAccounts] = useState<SubscriptionAccountDto[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void window.api.subscriptionAccounts
      .list()
      .then(list => { if (!cancelled) { setAccounts(list); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const until = (ms: number | null) =>
    ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <div className="gg-settings-extra gg-subscriptions-tab">
      <h2 className="gg-settings-page-title">Подписки</h2>
      <p className="gg-models-intro">
        Аккаунты провайдеров, работающих по подписке или через внешнюю программу. Видно состояние
        каждого аккаунта и почему он временно недоступен — без раскрытия ключей.
      </p>

      {loading && <p className="gg-models-card-desc">Загрузка…</p>}
      {!loading && accounts.length === 0 && (
        <p className="gg-models-card-desc">Пока нет подписочных аккаунтов.</p>
      )}

      <div className="gg-subscriptions-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {accounts.map(a => (
          <div key={a.id} className={`gg-subscription-account is-${a.state}`} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="gg-subscription-label" style={{ fontWeight: 600 }}>{a.label}</span>
            <span className="gg-subscription-provider gg-models-card-desc">{a.providerId}</span>
            <span className={`gg-subscription-state is-${a.state}`}>{STATE_LABEL[a.state]}</span>
            {a.active && <span className="gg-subscription-active" title="Активный аккаунт">● активен</span>}
            {a.cooldown && (
              <span className="gg-subscription-cooldown gg-models-card-desc" title={`Область: ${a.cooldown.scope}`}>
                {REASON_LABEL[a.cooldown.reason] ?? a.cooldown.reason}
                {a.cooldown.model ? ` · ${a.cooldown.model}` : ''}
                {a.cooldown.until ? ` · до ${until(a.cooldown.until)}` : ''}
              </span>
            )}
            {!a.hasCredential && <span className="gg-subscription-warn" style={{ color: 'var(--warn, #b8860b)' }}>⚠ ключ не найден</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
