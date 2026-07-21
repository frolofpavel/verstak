/**
 * 2.1.3-EF S5 → EF-R1 Б3/Б4: фиксация РЕАЛЬНО успешного ответа аккаунта подписки.
 *
 * last_used_at ставится ДО запроса (touch = попытка). last_success_at — только здесь,
 * после первого терминального finish(runId, 'done'). Ошибка/аборт/повторный finish
 * сюда не приходят → успех не выдумывается.
 *
 * Какой аккаунт отметить (Б3): строго run.account_id — аккаунт, подтверждённый
 * pre-flight для ЭТОГО прогона (и обновлённый при ротации). Смена global active /
 * pin во время работы получателя success НЕ меняет. Legacy-прогоны без account_id
 * (до миграции v54 / без парка аккаунтов) — прежний путь: pinned чата, иначе
 * активный canonical-провайдера. Провайдер берём actual (provider_id прогона),
 * с fallback на requested.
 */

import type { Database } from 'better-sqlite3'
import { getActiveAccount, getSubscriptionAccount, markAccountSuccess } from '../storage/subscription-accounts'
import { canonicalAccountProvider } from '../../shared/contracts/subscription'

export interface RunForSuccess {
  chatId: number | null
  providerId: string | null
  requestedProviderId: string | null
  /** EF-R1 Б3: аккаунт, подтверждённый для этого прогона (NULL = legacy). */
  accountId?: number | null
}

export interface SubscriptionSuccessDeps {
  getRun: (runId: string) => RunForSuccess | null
  getSubscriptionBinding: (chatId: number) => { mode: string; accountId: number | null } | null
}

export function markSuccessForRun(
  db: Database,
  deps: SubscriptionSuccessDeps,
  runId: string,
  when = Date.now(),
): void {
  const run = deps.getRun(runId)
  if (!run) return
  // Б3: приоритет — фактический аккаунт прогона (зафиксирован при старте/ротации).
  if (run.accountId != null) {
    markAccountSuccess(db, run.accountId, when)
    return
  }
  // Legacy-путь для прогонов без account_id.
  const providerId = run.providerId ?? run.requestedProviderId
  if (!providerId) return
  const canonical = canonicalAccountProvider(providerId)
  const binding = run.chatId != null ? deps.getSubscriptionBinding(run.chatId) : null
  const acct = binding?.mode === 'pinned' && binding.accountId != null
    ? getSubscriptionAccount(db, binding.accountId)
    : getActiveAccount(db, canonical)
  if (!acct) return
  markAccountSuccess(db, acct.id, when)
}

/**
 * EF-R1 Б4: обёртка agentRuns.finish, вешающая markSuccessForRun ТОЛЬКО на первый
 * терминальный переход со status='done'. Базовый finish сообщает, состоялся ли
 * переход именно этим вызовом; поздний 'done' после 'stopped' → transitioned=false
 * → success НЕ пишется (раньше wrapper писал успех на storage-no-op).
 * Исключение отметки успеха не должно ронять завершение прогона (best-effort).
 */
export function wrapFinishWithSuccess<T extends { finish: (...args: any[]) => boolean }>(
  agentRunsBase: T,
  onSuccess: (runId: string) => void,
): T['finish'] {
  // any в constraint — осознанно: обёртка дженерик над точной сигнатурой базового
  // finish (union статусов + опции), параметры пробрасываются без изменений,
  // наружный тип сохраняется через T['finish'].
  const wrapped = (runId: string, status: string, opts?: unknown): boolean => {
    const transitioned = agentRunsBase.finish(runId, status, opts)
    if (transitioned && status === 'done') {
      try {
        onSuccess(runId)
      } catch { /* best-effort */ }
    }
    return transitioned
  }
  return wrapped as T['finish']
}
