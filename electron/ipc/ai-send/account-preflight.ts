// Распил ai.ts (2.1.10-E, срез 2б): pre-flight подписочного аккаунта для ai:send.
//
// Вынесено из registerAiIpc БЕЗ изменения логики. Здесь два блока, которые раньше
// были разнесены по хендлеру на ~700 строк:
//  · preflightSubscriptionAccount — ЕДИНЫЙ resolve аккаунта попытки (EF-R2 Б1) и
//    ранние стопы маршрута (unavailable / blocked / allBlocked) с их текстами;
//  · builders route-evidence — запрошенный one-shot аккаунт и Auto-ротация, которые
//    прогон пишет в Timeline и шлёт рендереру пилюлей.
//
// Инварианты, которые обязан держать этот модуль:
//  · ОДИН resolve на попытку — повторный resolve после await'ов это A/B race;
//  · fail-closed: неготовый явно выбранный/закреплённый аккаунт останавливает прогон
//    ДО сети, а не подменяется молча другим;
//  · наружу уходят только label'ы — ни секретов, ни id, ни configDir.

import type { ProviderId } from '../../ai/registry'
import type { ResolvedSubscription } from '../../ai/resolve-subscription-account'

/** success-вариант резолвера: аккаунт выбран (остальные — стопы маршрута). */
export type SubscriptionSuccess = Extract<ResolvedSubscription, { accountId: number }>

export type ResolveSubscriptionAccountFn = (
  providerId: string,
  chatId?: number,
  opts?: { accountId?: number | null },
) => ResolvedSubscription | null

export type AccountPreflight =
  | {
    ok: true
    /** Аккаунт попытки. null — парка аккаунтов нет (legacy-секрет). */
    account: SubscriptionSuccess | null
    /** Аккаунт закреплён/явно выбран и жив → подавляет авто-свитч и fallback. */
    chatPinned: boolean
    /** Аккаунт, фиксируемый в agent_runs.account_id (EF-R1 Б3). */
    runAccountId: number | null
  }
  | { ok: false; message: string }

function timeAt(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * 2.0.8-D2 + 2.1.3-CD + EF S1: ранние стопы маршрута ДО создания run/провайдера.
 *  · unavailable: pin/one-shot на удалённый аккаунт → стоп-с-вопросом (НЕ тихая ротация).
 *  · blocked: явно выбранный (one-shot) или закреплённый аккаунт не готов (cooling /
 *    login-required) → стоп с понятной причиной вместо гарантированного фейла прогона.
 *  · allBlocked: Auto pre-flight исчерпал пул — честный стоп ДО сети вместо 429.
 */
export function preflightSubscriptionAccount(input: {
  providerId: ProviderId
  chatId: number | undefined
  oneShotAccountId: number | null
  resolve?: ResolveSubscriptionAccountFn
}): AccountPreflight {
  const resolution = input.resolve?.(
    input.providerId, input.chatId, input.oneShotAccountId != null ? { accountId: input.oneShotAccountId } : undefined)

  if (resolution && 'unavailable' in resolution) {
    return { ok: false, message: input.oneShotAccountId != null
      ? 'Выбранный на один запрос аккаунт был удалён. Выберите другой аккаунт или режим Auto.'
      : 'Аккаунт, закреплённый за этим чатом, был удалён. Выберите аккаунт заново или снимите закрепление.' }
  }
  if (resolution && 'blocked' in resolution) {
    const { reason, resetAt, label } = resolution
    const suffix = input.oneShotAccountId != null
      ? 'Выберите другой аккаунт или режим Auto.'
      : 'Выберите другой аккаунт или снимите закрепление.'
    return { ok: false, message: reason === 'cooling'
      ? `Аккаунт «${label}» остывает после лимита · ${resetAt != null ? `восстановится в ${timeAt(resetAt)}` : 'время восстановления неизвестно'}. ${suffix}`
      : `Аккаунт «${label}» требует входа. Выполните вход в Настройки → Подписки или выберите другой аккаунт.` }
  }
  if (resolution && 'allBlocked' in resolution) {
    const { reason, resetAt, count } = resolution
    return { ok: false, message: reason === 'cooling'
      ? `Все аккаунты провайдера (${count}) остывают после лимита · ${resetAt != null ? `ближайшее восстановление в ${timeAt(resetAt)}` : 'сроки восстановления неизвестны'}. Дождитесь сброса лимита или проверьте аккаунты в Настройки → Подписки.`
      : `Все аккаунты провайдера (${count}) требуют входа. Выполните вход в Настройки → Подписки.` }
  }

  // EF-R2 Б1: ЕДИНЫЙ resolved account context попытки. Credentials/codexHome берутся
  // ТОЛЬКО отсюда — повторный resolve после await'ов подготовки прочитал бы уже
  // сменившийся active/pin, и провайдер пошёл бы через B при run.accountId=A.
  const account = resolution ?? null
  return {
    ok: true,
    account,
    chatPinned: !!account?.pinned,
    runAccountId: account?.accountId ?? null,
  }
}

/** 2.1.3-CD: запрошенный one-shot аккаунт — первая запись route-evidence прогона.
 *  Timeline/Proof читают её без разбора логов; label — безопасное имя, не id. */
export function buildRequestedAccountEvent(label: string): { label: string; detail: string; status: 'info' } {
  return {
    label: 'requested-account',
    detail: `Запрошен аккаунт «${label}» на один запрос (строго, без ротации и запасного провайдера)`,
    status: 'info',
  }
}

export interface RotateAccountEvidence {
  runEvent: { label: string; detail: string; ref: string; status: 'ok' }
  routeChanged: {
    type: 'route-changed'
    action: 'rotate-account'
    reason: 'cooling' | 'login-required'
    attempt: number
    requested: { providerId: ProviderId; model: string }
    actual: { providerId: ProviderId; model: string }
    resetAt: number | null
    accounts: { fromLabel: string; toLabel: string }
  }
}

/** EF S1+S6: Auto pre-flight выбрал следующий готовый аккаунт ДО сетевого запроса.
 *  Фиксируем ротацию в route-evidence (Timeline/Proof читают без разбора логов) и шлём
 *  route-changed — пилюля «⇄ Аккаунт A → B» появляется сразу, а не после 429.
 *  Только label'ы: никаких id/credRef/configDir наружу. */
export function buildRotateAccountEvidence(input: {
  skipped: NonNullable<SubscriptionSuccess['skipped']>
  toLabel: string
  providerId: ProviderId
  model: string | null
}): RotateAccountEvidence {
  const { skipped } = input
  const reasonTxt = skipped.reason === 'cooling' ? 'остывает' : 'требует входа'
  const resetTxt = skipped.resetAt != null ? ` до ${timeAt(skipped.resetAt)}` : ', срок неизвестен'
  return {
    runEvent: {
      label: 'rotate-account',
      detail: `Auto: аккаунт «${skipped.fromLabel}» пропущен (${reasonTxt}${resetTxt}) → выбран «${input.toLabel}»`,
      ref: JSON.stringify({
        kind: 'rotate-account',
        preflight: true,
        reason: skipped.reason,
        fromAccountLabel: skipped.fromLabel,
        toAccountLabel: input.toLabel,
        resetAt: skipped.resetAt,
        requested: { providerId: input.providerId, model: input.model ?? null },
        actual: { providerId: input.providerId, model: input.model ?? null },
      }),
      status: 'ok',
    },
    routeChanged: {
      type: 'route-changed',
      action: 'rotate-account',
      reason: skipped.reason,
      attempt: 0,
      requested: { providerId: input.providerId, model: input.model ?? '' },
      actual: { providerId: input.providerId, model: input.model ?? '' },
      resetAt: skipped.resetAt,
      accounts: { fromLabel: skipped.fromLabel, toLabel: input.toLabel },
    },
  }
}
