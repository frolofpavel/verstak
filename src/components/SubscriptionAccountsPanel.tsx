import { useEffect, useState } from 'react'
import type { SubscriptionAccountDto } from '../types/api'

/**
 * Управление аккаунтами подписочного/CLI-провайдера (1.9.3 мультиаккаунт).
 * Пул аккаунтов (напр. несколько Claude Max), один активный — прогон идёт под ним.
 * Секрет вводится один раз и уходит в SafeStorage; наружу не возвращается.
 */
export function SubscriptionAccountsPanel({ providerId, secretLabel }: {
  providerId: string
  /** Как называть секрет для этого провайдера: «Токен» (Claude) / «API-ключ» (Kimi/Z.ai). */
  secretLabel?: string
}) {
  const [accounts, setAccounts] = useState<SubscriptionAccountDto[]>([])
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const secretName = secretLabel ?? 'Токен / ключ'

  async function reload() {
    try { setAccounts(await window.api.subscriptionAccounts.list(providerId)) }
    catch { /* оставим прежний список */ }
  }
  useEffect(() => { void reload() }, [providerId])

  async function add() {
    if (!label.trim() || !secret.trim()) { setError('Заполни название и ' + secretName.toLowerCase()); return }
    setBusy(true); setError(null)
    try {
      const res = await window.api.subscriptionAccounts.create({ providerId, label: label.trim(), secret: secret.trim() })
      if (!res.ok) { setError(res.error); return }
      setLabel(''); setSecret(''); setAdding(false)
      await reload()
    } finally { setBusy(false) }
  }

  async function activate(id: number) { await window.api.subscriptionAccounts.setActive(providerId, id); await reload() }
  async function remove(id: number) {
    if (!window.confirm('Удалить аккаунт? Сохранённый секрет тоже сотрётся.')) return
    await window.api.subscriptionAccounts.remove(id); await reload()
  }
  async function rename(id: number, current: string) {
    const next = window.prompt('Новое название аккаунта:', current)
    if (next && next.trim() && next.trim() !== current) { await window.api.subscriptionAccounts.rename(id, next.trim()); await reload() }
  }

  return (
    <div className="gg-subacct">
      <div className="gg-subacct-head">
        <span className="gg-subacct-title">Аккаунты подписки</span>
        {!adding && (
          <button type="button" className="gg-btn gg-btn-ghost" onClick={() => { setAdding(true); setError(null) }}>+ Аккаунт</button>
        )}
      </div>

      {accounts.length === 0 && !adding && (
        <div className="gg-subacct-empty">
          Пул аккаунтов пуст. Добавь несколько — Verstak будет держать активный и переключаться между ними (обход 5-часового лимита ротацией).
        </div>
      )}

      {accounts.length > 0 && (
        <div className="gg-subacct-list">
          {accounts.map(a => (
            <div key={a.id} className={`gg-subacct-item${a.active ? ' is-active' : ''}`}>
              <span className={`gg-subacct-dot${a.active ? ' is-active' : ''}`} />
              <span className="gg-subacct-label">{a.label}</span>
              {a.active
                ? <span className="gg-subacct-badge">активен</span>
                : <button type="button" className="gg-btn gg-btn-ghost gg-subacct-use" onClick={() => void activate(a.id)}>Сделать активным</button>}
              <span className="gg-subacct-spacer" />
              <button type="button" className="gg-subacct-action" title="Переименовать" onClick={() => void rename(a.id, a.label)}>✎</button>
              <button type="button" className="gg-subacct-action" title="Удалить" onClick={() => void remove(a.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className="gg-subacct-add">
          <input className="gg-input" placeholder="Название (напр. «Личный Max»)" value={label} onChange={e => setLabel(e.target.value)} />
          <input className="gg-input" type="password" placeholder={secretName} value={secret} onChange={e => setSecret(e.target.value)} />
          {error && <div className="gg-subacct-error">{error}</div>}
          <div className="gg-subacct-add-actions">
            <button type="button" className="gg-btn gg-btn-primary" disabled={busy} onClick={() => void add()}>{busy ? 'Сохраняю…' : 'Добавить'}</button>
            <button type="button" className="gg-btn gg-btn-ghost" disabled={busy} onClick={() => { setAdding(false); setError(null); setLabel(''); setSecret('') }}>Отмена</button>
          </div>
        </div>
      )}
    </div>
  )
}
