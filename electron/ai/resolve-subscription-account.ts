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
// Срез 2.1.3-EF: Auto получает pre-flight — активный аккаунт проверяется ДО сетевого
// запроса; cooling/login-required пропускается, прогон сразу идёт через следующий
// готовый аккаунт того же провайдера (success.skipped называет пропущенный — для
// Timeline-цепочки). Готовых нет → allBlocked (честный стоп в ai:send), а не
// гарантированно неудачный запрос в лимит.

import type { Database } from 'better-sqlite3'
import {
  getSubscriptionAccount,
  getActiveAccount,
  listSubscriptionAccounts,
  setActiveAccount,
  clearCooling,
  touchSubscriptionAccount,
  type SubscriptionAccount,
} from '../storage/subscription-accounts'
import { pickChatAccountId } from './route-policy'
import { probeConfigDirAuth } from './subscription-doctor'
import { canonicalAccountProvider } from '../../shared/contracts/subscription'

/** success — аккаунт резолвнут (pinned: закреплён/явно выбран → не ротировать авто);
 *  skipped — Auto pre-flight пропустил неготовый активный (только label/причина/resetAt);
 *  unavailable — аккаунт удалён / чужой провайдер → стоп-с-вопросом;
 *  blocked — ЯВНО выбранный/pinned аккаунт не готов (cooling / login-required);
 *  allBlocked — Auto: готовых аккаунтов провайдера нет вообще → стоп с агрегатом. */
export type ResolvedSubscription =
  | {
    accountId: number; secret: string | null; configDir: string | null; baseUrl: string | null
    pinned: boolean; label: string
    /** EF: Auto пропустил неготовый активный аккаунт ДО запроса (pre-flight ротация). */
    skipped?: { fromLabel: string; reason: 'cooling' | 'login-required'; resetAt: number | null }
  }
  | { unavailable: true }
  | { blocked: true; reason: 'cooling' | 'login-required'; resetAt: number | null; label: string }
  | { allBlocked: true; reason: 'cooling' | 'login-required'; resetAt: number | null; count: number }

export interface ResolveSubscriptionAccountDeps {
  getSecret: (key: string) => string | null
  /** per-chat binding (2.0.8-B). null когда чат без закрепления. */
  getSubscriptionBinding: (chatId: number) => { mode: 'auto' | 'pinned'; accountId: number | null } | null
  /** Инжект часов для детерминированных тестов. */
  now?: () => number
}

/** Аккаунты Codex общие для codex-cli и нативного openai-codex-oauth (реестр 'codex-cli',
 *  см. resolveCodexHome в ipc/ai.ts) — сверка провайдера канонизируется, иначе явный выбор
 *  codex-аккаунта на oauth-провайдере выглядел бы «чужим». Реэкспорт из contracts:
 *  единый источник правила (storage тоже канонизирует — storage → ai импорт запрещён). */
export { canonicalAccountProvider }

export function createResolveSubscriptionAccount(db: Database, deps: ResolveSubscriptionAccountDeps) {
  const nowOf = () => deps.now?.() ?? Date.now()

  /** Причина неготовности аккаунта прямо сейчас (null = готов). cooling: until null =
   *  срок неизвестен → тоже НЕ готов (EF: неизвестный срок не делает аккаунт ready);
   *  истёкшее остывание (until <= now) — аккаунт снова годится. */
  function blockReason(acct: SubscriptionAccount, now: number): { reason: 'cooling' | 'login-required'; resetAt: number | null } | null {
    if (acct.state === 'cooling' && (acct.coolingUntil == null || acct.coolingUntil > now)) {
      return { reason: 'cooling', resetAt: acct.coolingUntil ?? null }
    }
    if (acct.configDir) {
      const probe = probeConfigDirAuth(acct.configDir)
      if (!probe.credentialPresent) return { reason: 'login-required', resetAt: null }
      // access истёк и обновлять нечем → вход нужен заново (едино с Doctor).
      if (probe.accessExpiresAtMs != null && probe.accessExpiresAtMs <= now && !probe.hasRefreshToken) {
        return { reason: 'login-required', resetAt: null }
      }
    } else if (deps.getSecret(acct.credRef) == null) {
      return { reason: 'login-required', resetAt: null }
    }
    return null
  }

  function successOf(acct: SubscriptionAccount, pinned: boolean, skipped?: { fromLabel: string; reason: 'cooling' | 'login-required'; resetAt: number | null }): ResolvedSubscription {
    touchSubscriptionAccount(db, acct.id) // lastUsedAt = ПОПЫТКА использования (EF)
    return {
      accountId: acct.id,
      secret: deps.getSecret(acct.credRef),
      configDir: acct.configDir,
      baseUrl: acct.baseUrl,
      pinned,
      label: acct.label,
      ...(skipped ? { skipped } : {}),
    }
  }

  /** Готовность ЯВНО выбранного аккаунта (one-shot / pin). Auto сюда не приходит. */
  function readyOrBlocked(acct: SubscriptionAccount, pinned: boolean): ResolvedSubscription {
    const block = blockReason(acct, nowOf())
    if (block) return { blocked: true, ...block, label: acct.label }
    return successOf(acct, pinned)
  }

  /** EF: Auto pre-flight — активный не готов → следующий готовый аккаунт провайдера.
   *  Порядок кандидатов как у switchActiveOnLimit (редко использованные вперёд). */
  function resolveAuto(providerId: string): ResolvedSubscription | null {
    const now = nowOf()
    const active = getActiveAccount(db, providerId)
    if (!active) return null // legacy: аккаунтов нет — env/secret путь прежний
    const activeBlock = blockReason(active, now)
    if (!activeBlock) return successOf(active, false)

    // Активный не готов: ищем готового кандидата ДО сетевого запроса.
    const others = listSubscriptionAccounts(db, providerId)
      .filter(a => a.id !== active.id)
      .sort((a, b) => (a.lastUsedAt == null ? -1 : 0) - (b.lastUsedAt == null ? -1 : 0)
        || (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0)
        || b.createdAt - a.createdAt)
    for (const cand of others) {
      if (blockReason(cand, now)) continue
      // Промоутим: следующие прогоны стартуют сразу на готовом (без повторного skip).
      clearCooling(db, cand.id) // нормализуем протухший cooling, если был
      setActiveAccount(db, providerId, cand.id)
      return successOf(cand, false, { fromLabel: active.label, ...activeBlock })
    }

    // Готовых нет вообще: агрегат. cooling доминирует (восстановится само — есть что
    // ждать); resetAt — БЛИЖАЙШЕЕ известное время восстановления; неизвестное ≠ ноль.
    const all = [active, ...others]
    const coolingResets = all
      .filter(a => a.state === 'cooling' && a.coolingUntil != null && a.coolingUntil > now)
      .map(a => a.coolingUntil as number)
    const anyCooling = all.some(a => a.state === 'cooling' && (a.coolingUntil == null || a.coolingUntil > now))
    return {
      allBlocked: true,
      reason: anyCooling ? 'cooling' : 'login-required',
      resetAt: coolingResets.length ? Math.min(...coolingResets) : null,
      count: all.length,
    }
  }

  return (
    providerId: string,
    chatId?: number,
    opts?: { accountId?: number | null },
  ): ResolvedSubscription | null => {
    // EF-R1 Б1: КАНОНИЧЕСКОЕ семейство аккаунтов для ВСЕХ веток, не только one-shot.
    // Раньше auto/pin шли по raw providerId → для openai-codex-oauth пул codex-cli был
    // невидим: blocked/allBlocked схлопывались в null, pin тихо становился auto, а запрос
    // уходил на default ~/.codex мимо выбранного аккаунта.
    const canonical = canonicalAccountProvider(providerId)
    // One-shot явный выбор (CD): аккаунт задан напрямую, минуя binding чата.
    // Удалённый / чужой провайдер → unavailable (стоп, НЕ тихий auto на активный).
    const explicitId = opts?.accountId
    if (explicitId != null) {
      const acct = getSubscriptionAccount(db, explicitId)
      if (!acct || acct.providerId !== canonical) return { unavailable: true }
      return readyOrBlocked(acct, true)
    }

    // pickChatAccountId — чистая спека (auto|pinned|unavailable + сверка провайдера).
    const binding = chatId == null ? null : deps.getSubscriptionBinding(chatId)
    const decision = pickChatAccountId(canonical, binding, id => getSubscriptionAccount(db, id)?.providerId ?? null)
    // pin на удалённый аккаунт → НЕ ротируем молча на глобально-активный (карточка B).
    if (decision.kind === 'unavailable') return { unavailable: true }
    if (decision.kind === 'pinned') {
      const acct = getSubscriptionAccount(db, decision.accountId)
      if (!acct) return { unavailable: true }
      // CD: закреплённый аккаунт проверяется на готовность так же, как явный one-shot —
      // иначе прогон гарантированно упадёт на лимите/входе (ранний стоп честнее).
      return readyOrBlocked(acct, true)
    }
    // EF: Auto — pre-flight skip недоступного активного (см. resolveAuto).
    return resolveAuto(canonical)
  }
}
