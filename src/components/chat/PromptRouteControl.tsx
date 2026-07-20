import { useEffect, useState } from 'react'
import { useProviderCatalog } from '../../hooks/useProviderCatalog'
import { useProject } from '../../store/projectStore'
import { accountStateLabel } from '../../lib/chat-account-binding'
import type { PromptRouteOverride, SubscriptionAccountDTO } from '../../types/api'

// Срез 2.0.7-F: маршрут модели на ОДИН запрос. Не меняет дефолт чата (one-shot —
// snap'ается после отправки и при переключении чата, см. projectStore). fallbackPolicy
// по умолчанию strict: пользователь выбрал модель осознанно, молча уезжать на другого
// провайдера нельзя ('allow' возвращает прежний smart-fallback + видимое route-событие).
//
// 2.1.3-CD: второй шаг — КОНКРЕТНЫЙ аккаунт подписки (только там, где аккаунты есть;
// у обычного API-провайдера шага нет). Аккаунтный one-shot всегда строгий: main
// выключает и ротацию, и provider-fallback (routeFallbackAllowed), поэтому тумблер
// политики на таком чипе не показываем вовсе — он бы врал про реальное поведение.
//
// Логика (catalog/one-shot/strict) покрыта тестами; визуальная приёмка контрола — за
// Павлом на собранной 2.1.3 (Electron не рендерю).

/** Состояние пикера: провайдер+модель выбраны, ждём решения по аккаунту. */
interface PendingRoute {
  providerId: string
  model: string
  accounts: SubscriptionAccountDTO[]
}

export function PromptRouteControl() {
  const { providers } = useProviderCatalog()
  const override = useProject(s => s.promptRouteOverride)
  const setOverride = useProject(s => s.setPromptRouteOverride)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<PendingRoute | null>(null)
  // label аккаунта для чипа: override хранит только id (безопасно), имя дочитываем.
  const [accountLabel, setAccountLabel] = useState<string | null>(null)

  const accountId = override?.accountId ?? null
  useEffect(() => {
    setAccountLabel(null)
    if (accountId == null || !override) return
    let cancelled = false
    void window.api.subscriptionAccounts.list(override.providerId).then(list => {
      if (cancelled) return
      setAccountLabel(list.find(a => a.id === accountId)?.label ?? null)
    }).catch(() => { /* чип покажет id-нейтральную подпись */ })
    return () => { cancelled = true }
  }, [accountId, override])

  // Активный override — компактный чип с моделью и режимом fallback + сброс.
  if (override) {
    return (
      <span className="gg-prompt-route is-active" title="Маршрут только для следующего запроса">
        🎯 {override.model}
        {accountId != null ? (
          // Аккаунтный one-shot: всегда строго (main принудительно выключает любой
          // fallback). Тумблер политики здесь врал бы — показываем статичную пометку.
          <span className="gg-prompt-route-account" title="Аккаунт для следующего запроса · строго, без переключений">
            · {accountLabel ?? 'выбранный аккаунт'} · строго
          </span>
        ) : (
          <button
            type="button"
            className="gg-prompt-route-policy"
            title={override.fallbackPolicy === 'strict'
              ? 'Строго: при сбое не переезжать на другого провайдера'
              : 'Разрешить запасного провайдера при сбое'}
            onClick={() => setOverride({ ...override, fallbackPolicy: override.fallbackPolicy === 'strict' ? 'allow' : 'strict' })}
          >
            {override.fallbackPolicy === 'strict' ? 'строго' : 'с запасным'}
          </button>
        )}
        <button type="button" className="gg-prompt-route-clear" title="Сбросить (вернуть модель чата)" onClick={() => setOverride(null)}>✕</button>
      </span>
    )
  }

  if (!open) {
    return (
      <button type="button" className="gg-prompt-route-trigger" title="Выбрать модель только для следующего запроса" onClick={() => setOpen(true)}>
        🎯 модель на 1 запрос
      </button>
    )
  }

  function apply(providerId: string, model: string, account?: SubscriptionAccountDTO | null) {
    if (!model) return
    const base: PromptRouteOverride = { providerId: providerId as PromptRouteOverride['providerId'], model, fallbackPolicy: 'strict' }
    // account === undefined → «Автоматически» (обычный pin/auto путь, без accountId).
    setOverride(account ? { ...base, accountId: account.id } : base)
    setPending(null)
    setOpen(false)
  }

  // Шаг 1: провайдер+модель. Если у провайдера есть подписочные аккаунты — шаг 2.
  function pickModel(providerId: string, model: string) {
    if (!providerId || !model) return
    void window.api.subscriptionAccounts.list(providerId)
      .then(accounts => {
        if (accounts.length === 0) {
          apply(providerId, model)
        } else {
          setPending({ providerId, model, accounts })
        }
      })
      .catch(() => apply(providerId, model)) // список не отдался — прежний путь без аккаунта
  }

  // Шаг 2: аккаунт. «Автоматически» = обычный выбор (pin чата / активный аккаунт).
  // login-required/invalid не даём выбрать: такой one-shot гарантированно встанет
  // (isPinnable-логика ModelPicker — та же причина).
  if (pending) {
    return (
      <span className="gg-prompt-route-picker">
        <select
          className="gg-input gg-prompt-route-select gg-prompt-route-account-select"
          defaultValue=""
          onChange={e => {
            const v = e.target.value
            if (v === 'auto') apply(pending.providerId, pending.model)
            else {
              const acc = pending.accounts.find(a => a.id === Number(v))
              if (acc) apply(pending.providerId, pending.model, acc)
            }
          }}
        >
          <option value="" disabled>аккаунт на 1 запрос…</option>
          <option value="auto">Автоматически</option>
          {pending.accounts.map(a => {
            const selectable = a.hasCredential && a.state !== 'invalid' && a.state !== 'login-required'
            return (
              <option key={a.id} value={String(a.id)} disabled={!selectable}>
                {a.label} — {accountStateLabel(a)}
              </option>
            )
          })}
        </select>
        <button type="button" className="gg-prompt-route-clear" title="Отмена" onClick={() => { setPending(null); setOpen(false) }}>✕</button>
      </span>
    )
  }

  // Пикер: провайдер → модель. Explicit route по умолчанию strict.
  return (
    <span className="gg-prompt-route-picker">
      <select
        className="gg-input gg-prompt-route-select"
        defaultValue=""
        onChange={e => {
          const [pid, model] = e.target.value.split('::')
          if (pid && model) pickModel(pid, model)
        }}
      >
        <option value="" disabled>модель на 1 запрос…</option>
        {providers.map(p => (
          <optgroup key={p.id} label={p.name}>
            {p.models.map(m => (
              <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>{m}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <button type="button" className="gg-prompt-route-clear" title="Отмена" onClick={() => setOpen(false)}>✕</button>
    </span>
  )
}
