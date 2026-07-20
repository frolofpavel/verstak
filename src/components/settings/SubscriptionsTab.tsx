import { useEffect, useState } from 'react'
import type { SubscriptionAccountDto, SubscriptionDoctorReportDTO } from '../../types/api'

// Срез 2.1.3-A/B: вкладка «Подписки» — ЕДИНЫЙ центр управления подписочными аккаунтами
// (раньше была read-only обзором, а управление жило дублирующими панелями в карточках
// провайдеров). Здесь: добавить / войти / активировать / переименовать / удалить /
// «Проверить» (Subscription Doctor) — с честными состояниями ready/cooling/login-required/
// invalid и причиной остывания.
//
// В форму добавления попадают ТОЛЬКО провайдеры, чьи аккаунты реально потребляет рантайм
// (claude-cli — токен в env; codex-cli — изолированный CODEX_HOME). Показывать аккаунты
// для провайдеров без потребления значило бы маскировать декорацию под управление.
// Kimi Coding и пр. — отдельный срез, когда рантайм научится их резолвить.

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

const CHECK_ICON: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✕', info: 'ℹ' }

/** Inline-отчёт Subscription Doctor под строкой аккаунта. */
function DoctorReport({ report }: { report: SubscriptionDoctorReportDTO }) {
  return (
    <div className="gg-subacct-add" style={{ marginTop: 4 }}>
      <div className="gg-subacct-title" style={{ marginBottom: 4 }}>{report.summary}</div>
      {report.checks.map(c => (
        <div key={c.id} className="gg-models-card-desc" style={{ display: 'flex', gap: 6 }}>
          <span aria-hidden>{CHECK_ICON[c.status]}</span>
          <span>{c.label}</span>
        </div>
      ))}
      {report.nextStep && (
        <div className="gg-subacct-hint" style={{ marginTop: 4 }}>Что дальше: {report.nextStep}</div>
      )}
    </div>
  )
}

/** Строка аккаунта: состояние, cooldown, действия (активировать/войти/проверить/✎/✕). */
function AccountRow({ a, doctorBusy, onActivate, onLogin, onDoctor, onRename, onRemove }: {
  a: SubscriptionAccountDto
  doctorBusy: boolean
  onActivate: () => void
  onLogin: () => void
  onDoctor: () => void
  onRename: () => void
  onRemove: () => void
}) {
  const until = (ms: number | null) =>
    ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  return (
    <div className={`gg-subacct-item${a.active ? ' is-active' : ''}`}>
      <span className={`gg-subacct-dot${a.active ? ' is-active' : ''}${a.state === 'cooling' ? ' is-cooling' : ''}`} />
      <span className="gg-subacct-label">{a.label}</span>
      <span className={`gg-subscription-state is-${a.state}`}>{STATE_LABEL[a.state]}</span>
      {a.cooldown && (
        <span className="gg-subacct-cooling" title={`Область: ${a.cooldown.scope}`}>
          {REASON_LABEL[a.cooldown.reason] ?? a.cooldown.reason}
          {a.cooldown.model ? ` · ${a.cooldown.model}` : ''}
          {a.cooldown.until ? ` · до ${until(a.cooldown.until)}` : ''}
        </span>
      )}
      {a.active
        ? <span className="gg-subacct-badge">активен</span>
        : <button type="button" className="gg-btn gg-btn-ghost gg-subacct-use" onClick={onActivate}>Сделать активным</button>}
      {a.authMode === 'config-dir' && (
        <button type="button" className="gg-btn gg-btn-ghost gg-subacct-use" onClick={onLogin}>Войти</button>
      )}
      <button type="button" className="gg-btn gg-btn-ghost gg-subacct-use" disabled={doctorBusy} onClick={onDoctor}>
        {doctorBusy ? 'Проверяю…' : 'Проверить'}
      </button>
      <span className="gg-subacct-spacer" />
      <button type="button" className="gg-subacct-action" title="Переименовать" onClick={onRename}>✎</button>
      <button type="button" className="gg-subacct-action" title="Удалить" onClick={onRemove}>✕</button>
    </div>
  )
}

/** Провайдеры, доступные для добавления: форма секрета зависит от вида авторизации. */
const ADDABLE = [
  { providerId: 'claude-cli', title: 'Claude Code', mode: 'token' as const, secretLabel: 'OAuth-токен (claude setup-token)' },
  { providerId: 'codex-cli', title: 'Codex / ChatGPT (CLI)', mode: 'dir' as const },
]

/** Группировка по auth-family: у Codex один логин покрывает CLI и встроенный движок. */
function familyOf(providerId: string): { id: string; title: string; note?: string } {
  if (providerId === 'claude-cli') return { id: 'claude', title: 'Claude Code' }
  if (providerId === 'codex-cli' || providerId === 'openai-codex-oauth') {
    return { id: 'codex', title: 'Codex / ChatGPT', note: 'Один логин Codex покрывает CLI и встроенный движок.' }
  }
  return { id: `other:${providerId}`, title: providerId }
}

interface AccountFamily { id: string; title: string; note?: string; items: SubscriptionAccountDto[] }

/** Секция auth-family: заголовок + строки аккаунтов с inline Doctor-отчётами. */
function FamilySection({ g, doctorById, doctorBusy, onActivate, onLogin, onDoctor, onRename, onRemove }: {
  g: AccountFamily
  doctorById: Record<number, SubscriptionDoctorReportDTO>
  doctorBusy: number | null
  onActivate: (a: SubscriptionAccountDto) => void
  onLogin: (id: number) => void
  onDoctor: (id: number) => void
  onRename: (a: SubscriptionAccountDto) => void
  onRemove: (a: SubscriptionAccountDto) => void
}) {
  return (
    <div className="gg-subacct" style={{ marginBottom: 16 }}>
      <div className="gg-subacct-head">
        <span className="gg-subacct-title">{g.title}</span>
      </div>
      {g.note && <div className="gg-subacct-hint" style={{ marginBottom: 6 }}>{g.note}</div>}
      <div className="gg-subacct-list">
        {g.items.map(a => (
          <div key={a.id}>
            <AccountRow
              a={a}
              doctorBusy={doctorBusy === a.id}
              onActivate={() => onActivate(a)}
              onLogin={() => onLogin(a.id)}
              onDoctor={() => onDoctor(a.id)}
              onRename={() => onRename(a)}
              onRemove={() => onRemove(a)}
            />
            {doctorById[a.id] && <DoctorReport report={doctorById[a.id]} />}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Группировка аккаунтов по auth-family, порядок семей — по первому появлению. */
function groupByFamily(accounts: SubscriptionAccountDto[]): AccountFamily[] {
  const families: AccountFamily[] = []
  for (const a of accounts) {
    const f = familyOf(a.providerId)
    let g = families.find(x => x.id === f.id)
    if (!g) { g = { ...f, items: [] }; families.push(g) }
    g.items.push(a)
  }
  return families
}

/** Форма добавления аккаунта (token для Claude / dir для Codex). */
function AddAccountForm({ busy, providerSel, onProviderChange, label, onLabelChange, secret, onSecretChange, onSubmit, onCancel }: {
  busy: boolean
  providerSel: string
  onProviderChange: (v: string) => void
  label: string
  onLabelChange: (v: string) => void
  secret: string
  onSecretChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const addable = ADDABLE.find(a => a.providerId === providerSel) ?? ADDABLE[0]
  return (
    <div className="gg-subacct-add" style={{ marginTop: 8, maxWidth: 520 }}>
      <select className="gg-input" value={providerSel} onChange={e => onProviderChange(e.target.value)}>
        {ADDABLE.map(p => <option key={p.providerId} value={p.providerId}>{p.title}</option>)}
      </select>
      <input className="gg-input" placeholder="Название (напр. «Личный Max»)" value={label} onChange={e => onLabelChange(e.target.value)} />
      {addable.mode === 'token'
        ? <input className="gg-input" type="password" placeholder={addable.secretLabel} value={secret} onChange={e => onSecretChange(e.target.value)} />
        : <div className="gg-subacct-hint">После добавления нажми «Войти» — откроется терминал, залогинься в этот аккаунт (креды лягут в его изолированную папку).</div>}
      <div className="gg-subacct-add-actions">
        <button type="button" className="gg-btn gg-btn-primary" disabled={busy} onClick={onSubmit}>{busy ? 'Сохраняю…' : 'Добавить'}</button>
        <button type="button" className="gg-btn gg-btn-ghost" disabled={busy} onClick={onCancel}>Отмена</button>
      </div>
    </div>
  )
}

export function SubscriptionsTab() {
  const [accounts, setAccounts] = useState<SubscriptionAccountDto[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [providerSel, setProviderSel] = useState(ADDABLE[0].providerId)
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  // R1 БЛОКЕР 4: ошибки/статусы видны ВНЕ формы добавления (она может быть закрыта).
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [doctorById, setDoctorById] = useState<Record<number, SubscriptionDoctorReportDTO>>({})
  const [doctorBusy, setDoctorBusy] = useState<number | null>(null)

  async function reload() {
    try {
      setAccounts(await window.api.subscriptionAccounts.list())
      setLoadError(null)
    } catch {
      // Сбой загрузки — видимая ошибка, а НЕ молчаливый «пустой парк».
      setLoadError('Не удалось загрузить список аккаунтов. Открой раздел ещё раз или перезапусти настройки.')
    } finally { setLoading(false) }
  }
  useEffect(() => { void reload() }, [])

  const addable = ADDABLE.find(a => a.providerId === providerSel) ?? ADDABLE[0]

  async function submit() {
    if (!label.trim()) { setError('Укажи название аккаунта.'); return }
    if (addable.mode === 'token' && !secret.trim()) { setError('Заполни ' + addable.secretLabel!.toLowerCase()); return }
    setBusy(true); setError(null)
    try {
      const res = addable.mode === 'dir'
        ? await window.api.subscriptionAccounts.createDir({ providerId: providerSel, label: label.trim() })
        : await window.api.subscriptionAccounts.create({ providerId: providerSel, label: label.trim(), secret: secret.trim() })
      if (!res.ok) { setError(res.error); return }
      setLabel(''); setSecret(''); setAdding(false)
      await reload()
    } finally { setBusy(false) }
  }

  async function activate(a: SubscriptionAccountDto) {
    await window.api.subscriptionAccounts.setActive(a.providerId, a.id); await reload()
  }
  async function login(id: number) {
    setError(null); setNotice(null)
    const res = await window.api.subscriptionAccounts.login(id)
    // res.command НЕ показываем: там внутренний путь configDir. Только статический текст.
    if (res.ok) setNotice('Терминал открыт. Заверши вход в нём, затем вернись и нажми «Проверить».')
    else setError(res.error ?? 'Не удалось открыть вход.')
  }
  async function remove(a: SubscriptionAccountDto) {
    if (!window.confirm(`Удалить аккаунт «${a.label}»? Сохранённый секрет / папка стейта тоже сотрутся.`)) return
    await window.api.subscriptionAccounts.remove(a.id)
    setDoctorById(prev => { const next = { ...prev }; delete next[a.id]; return next })
    await reload()
  }
  async function rename(a: SubscriptionAccountDto) {
    const next = window.prompt('Новое название аккаунта:', a.label)
    if (next && next.trim() && next.trim() !== a.label) {
      await window.api.subscriptionAccounts.rename(a.id, next.trim()); await reload()
    }
  }
  async function runDoctor(id: number) {
    setDoctorBusy(id); setError(null); setNotice(null)
    try {
      const res = await window.api.subscriptionAccounts.doctor(id)
      if (res.ok) {
        setDoctorById(prev => ({ ...prev, [id]: res.report }))
        await reload() // badge состояния обновляется по свежему списку
      } else {
        setError(res.error)
      }
    } finally { setDoctorBusy(null) }
  }

  const families = groupByFamily(accounts)

  return (
    <div className="gg-settings-extra gg-subscriptions-tab">
      <h2 className="gg-settings-page-title">Подписки</h2>
      <p className="gg-models-intro">
        Все подписочные аккаунты в одном месте: состояние, причина остывания и диагностика —
        без раскрытия ключей. Прогон всегда идёт под активным аккаунтом семейства.
      </p>

      {loading && <p className="gg-models-card-desc">Загрузка…</p>}

      {/* Статусы/ошибки операций — ВНЕ формы добавления, видны всегда (R1). */}
      {loadError && <div className="gg-subacct-error" role="alert">{loadError}</div>}
      {error && <div className="gg-subacct-error" role="alert">{error}</div>}
      {notice && <div className="gg-subacct-hint" role="status">{notice}</div>}

      {!loading && !loadError && accounts.length === 0 && !adding && (
        <div className="gg-subacct-empty">
          Пока нет подписочных аккаунтов. Добавь первый — Verstak будет держать его активным,
          а при пуле аккаунтов переключаться между ними при лимитах.
        </div>
      )}

      {families.map(g => (
        <FamilySection
          key={g.id}
          g={g}
          doctorById={doctorById}
          doctorBusy={doctorBusy}
          onActivate={a => void activate(a)}
          onLogin={id => void login(id)}
          onDoctor={id => void runDoctor(id)}
          onRename={a => void rename(a)}
          onRemove={a => void remove(a)}
        />
      ))}

      {!adding && (
        <button type="button" className="gg-btn gg-btn-ghost" onClick={() => { setAdding(true); setError(null) }}>+ Аккаунт</button>
      )}

      {adding && (
        <AddAccountForm
          busy={busy}
          providerSel={providerSel}
          onProviderChange={v => { setProviderSel(v); setError(null) }}
          label={label}
          onLabelChange={setLabel}
          secret={secret}
          onSecretChange={setSecret}
          onSubmit={() => void submit()}
          onCancel={() => { setAdding(false); setError(null); setLabel(''); setSecret('') }}
        />
      )}
    </div>
  )
}
