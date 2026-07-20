// Срез 2.1.3-CD: ЕДИНЫЙ резолвер подписочного аккаунта для прогона.
//
// Раньше логика жила инлайн в main.ts: pin/auto/unavailable + секрет по cred_ref.
// Этого хватало, пока выбирать аккаунт мог только pin чата. С появлением one-shot
// маршрута (PromptRouteOverride.accountId) явный выбор обязан останавливаться с
// понятной причиной, когда аккаунт не готов, — иначе запрос гарантированно упадёт
// в рантайме (лимит/вход) или, хуже, молча уйдёт на другой аккаунт.
//
// Семантика readiness ЕДИНАЯ с Subscription Doctor (R1): непустой access_token /
// секрет в SafeStorage, срок из JWT exp, refresh покрывает истёкший access.
// Значения токенов из blocked-варианта НЕ выходят (только label + причина + resetAt).
//
// Auto-режим НЕ изменён: активный аккаунт берётся как раньше — гонку «активный
// остыл прямо сейчас» разруливает существующий switch-on-limit в рантайме.

import type { Database } from 'better-sqlite3'
import {
  getSubscriptionAccount,
  getActiveAccount,
  touchSubscriptionAccount,
  type SubscriptionAccount,
} from '../storage/subscription-accounts'
import { pickChatAccountId } from './route-policy'
import { probeConfigDirAuth } from './subscription-doctor'

/** success — аккаунт резолвнут (pinned: закреплён/явно выбран → не ротировать авто);
 *  unavailable — аккаунт удалён / чужой провайдер → стоп-с-вопросом;
 *  blocked — аккаунт есть, но не готов (cooling / login-required) → стоп с причиной. */
export type ResolvedSubscription =
  | { accountId: number; secret: string | null; configDir: string | null; baseUrl: string | null; pinned: boolean; label: string }
  | { unavailable: true }
  | { blocked: true; reason: 'cooling' | 'login-required'; resetAt: number | null; label: string }

export interface ResolveSubscriptionAccountDeps {
  getSecret: (key: string) => string | null
  /** per-chat binding (2.0.8-B). null когда чат без закрепления. */
  getSubscriptionBinding: (chatId: number) => { mode: 'auto' | 'pinned'; accountId: number | null } | null
  /** Инжект часов для детерминированных тестов. */
  now?: () => number
}

/** Аккаунты Codex общие для codex-cli и нативного openai-codex-oauth (реестр 'codex-cli',
 *  см. resolveCodexHome в ipc/ai.ts) — сверка провайдера канонизируется, иначе явный выбор
 *  codex-аккаунта на oauth-провайдере выглядел бы «чужим». */
function canonicalAccountProvider(providerId: string): string {
  return providerId === 'openai-codex-oauth' ? 'codex-cli' : providerId
}

export function createResolveSubscriptionAccount(db: Database, deps: ResolveSubscriptionAccountDeps) {
  const nowOf = () => deps.now?.() ?? Date.now()

  /** Готовность ЯВНО выбранного аккаунта (one-shot / pin). Auto сюда не приходит. */
  function readyOrBlocked(acct: SubscriptionAccount, pinned: boolean): ResolvedSubscription {
    const now = nowOf()
    // cooling: until null = срок неизвестен (бессрочно до ручного сброса) → тоже стоп.
    // Истёкшее остывание (until <= now) — аккаунт снова годится (как кандидат ротации).
    if (acct.state === 'cooling' && (acct.coolingUntil == null || acct.coolingUntil > now)) {
      return { blocked: true, reason: 'cooling', resetAt: acct.coolingUntil ?? null, label: acct.label }
    }
    if (acct.configDir) {
      const probe = probeConfigDirAuth(acct.configDir)
      if (!probe.credentialPresent) {
        return { blocked: true, reason: 'login-required', resetAt: null, label: acct.label }
      }
      // access истёк и обновлять нечем → вход нужен заново (едино с Doctor).
      if (probe.accessExpiresAtMs != null && probe.accessExpiresAtMs <= now && !probe.hasRefreshToken) {
        return { blocked: true, reason: 'login-required', resetAt: null, label: acct.label }
      }
    } else if (deps.getSecret(acct.credRef) == null) {
      return { blocked: true, reason: 'login-required', resetAt: null, label: acct.label }
    }
    touchSubscriptionAccount(db, acct.id)
    return {
      accountId: acct.id,
      secret: deps.getSecret(acct.credRef),
      configDir: acct.configDir,
      baseUrl: acct.baseUrl,
      pinned,
      label: acct.label,
    }
  }

  return (
    providerId: string,
    chatId?: number,
    opts?: { accountId?: number | null },
  ): ResolvedSubscription | null => {
    // One-shot явный выбор (CD): аккаунт задан напрямую, минуя binding чата.
    // Удалённый / чужой провайдер → unavailable (стоп, НЕ тихий auto на активный).
    const explicitId = opts?.accountId
    if (explicitId != null) {
      const acct = getSubscriptionAccount(db, explicitId)
      if (!acct || acct.providerId !== canonicalAccountProvider(providerId)) return { unavailable: true }
      return readyOrBlocked(acct, true)
    }

    // pickChatAccountId — чистая спека (auto|pinned|unavailable + сверка провайдера).
    const binding = chatId == null ? null : deps.getSubscriptionBinding(chatId)
    const decision = pickChatAccountId(providerId, binding, id => getSubscriptionAccount(db, id)?.providerId ?? null)
    // pin на удалённый аккаунт → НЕ ротируем молча на глобально-активный (карточка B).
    if (decision.kind === 'unavailable') return { unavailable: true }
    if (decision.kind === 'pinned') {
      const acct = getSubscriptionAccount(db, decision.accountId)
      if (!acct) return { unavailable: true }
      // CD: закреплённый аккаунт проверяется на готовность так же, как явный one-shot —
      // иначе прогон гарантированно упадёт на лимите/входе (ранний стоп честнее).
      return readyOrBlocked(acct, true)
    }
    // auto: поведение прежнее — активный аккаунт без readiness-стопа.
    const acct = getActiveAccount(db, providerId)
    if (!acct) return null
    touchSubscriptionAccount(db, acct.id)
    return {
      accountId: acct.id,
      secret: deps.getSecret(acct.credRef),
      configDir: acct.configDir,
      baseUrl: acct.baseUrl,
      pinned: false,
      label: acct.label,
    }
  }
}
