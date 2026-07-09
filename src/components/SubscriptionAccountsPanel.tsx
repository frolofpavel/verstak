import { useEffect, useState } from 'react'
import type { SubscriptionAccountDto } from '../types/api'

/**
 * Управление аккаунтами подписочного/CLI-провайдера (1.9.3 мультиаккаунт).
 * Пул аккаунтов (напр. несколько Claude Max / Codex), один активный — прогон идёт под ним.
 *
 * Два режима:
 *  - `token` (Claude): секрет вводится один раз → SafeStorage. Наружу не возвращается.
 *  - `dir`   (Codex): аккаунт = изолированная папка стейта (CODEX_HOME); логин отдельно
 *            в терминале кнопкой «Войти».
 */
export function SubscriptionAccountsPanel({ providerId, secretLabel, mode = 'token' }: {
  providerId: string
  secretLabel?: string
  mode?: 'token' | 'dir'
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

  async function submit() {
    if (!label.trim()) { setError('Укажи название аккаунта.'); return }
    if (mode === 'token' && !secret.trim()) { setError('Заполни ' + secretName.toLowerCase()); return }
    setBusy(true); setError(null)
    try {
      const res = mode === 'dir'
        ? await window.api.subscriptionAccounts.createDir({ providerId, label: label.trim() })
        : await window.api.subscriptionAccounts.create({ providerId, label: label.trim(), secret: secret.trim() })
      if (!res.ok) { setError(res.error); return }
      setLabel(''); setSecret(''); setAdding(false)
      await reload()
    } finally { setBusy(false) }
  }

  async function activate(id: number) { await window.api.subscriptionAccounts.setActive(providerId, id); await reload() }
  async function login(id: number) { await window.api.subscriptionAccounts.login(id) }
  async function remove(id: number) {
    if (!window.confirm('Удалить аккаунт? Сохранённый секрет / папка стейта тоже сотрутся.')) return
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
              {mode === 'dir' && (
                <button type="button" className="gg-btn gg-btn-ghost gg-subacct-use" onClick={() => void login(a.id)}>Войти</button>
              )}
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
          {mode === 'token'
            ? <input className="gg-input" type="password" placeholder={secretName} value={secret} onChange={e => setSecret(e.target.value)} />
            : <div className="gg-subacct-hint">После добавления нажми «Войти» — откроется терминал, залогинься в этот аккаунт (креды лягут в его изолированную папку).</div>}
          {error && <div className="gg-subacct-error">{error}</div>}
          <div className="gg-subacct-add-actions">
            <button type="button" className="gg-btn gg-btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Сохраняю…' : 'Добавить'}</button>
            <button type="button" className="gg-btn gg-btn-ghost" disabled={busy} onClick={() => { setAdding(false); setError(null); setLabel(''); setSecret('') }}>Отмена</button>
          </div>
        </div>
      )}
    </div>
  )
}
