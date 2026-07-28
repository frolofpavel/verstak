// Общие типы/константы runner'ов (распил ai.ts, 1.9.8 #1, срез 4a).
//
// Вынесено из ipc/ai.ts, чтобы РАЗОРВАТЬ циклическую зависимость перед переездом
// самих runner-функций: и ipc/ai.ts (runApiConversation), и будущий runner-plain.ts
// (runPlainConversation) импортируют отсюда — общий источник без цикла значений.

import type { ProviderId } from './registry'
import type { ChatProvider } from './types'
import type { SwitchResult } from '../storage/subscription-accounts'
import type { CooldownReason } from '../../shared/contracts/subscription'

/** EF-R2 Б2: fallback-attempt — провайдер + аккаунт, закреплённый за попыткой.
 *  accountId: number — managed-аккаунт нового провайдера; null — managed-аккаунта
 *  нет (run.account_id очищается); undefined внутри runner'а — legacy getNextProvider
 *  без lineage (accountId прогона не трогаем). */
export interface FallbackAttempt {
  provider: ChatProvider
  accountId: number | null
}

export interface FallbackOpts {
  /** Создаёт провайдера для указанного fallback-кандидата (null если нет ключа).
   *  Legacy-вариант без account-lineage: run.account_id при handoff не меняется.
   *  EF-R2 Б2: production-путь использует getNextAttempt (attempt несёт аккаунт). */
  getNextProvider?: (id: ProviderId) => ChatProvider | null
  /** EF-R2 Б2: предпочтительный вариант — attempt несёт аккаунт, закреплённый за
   *  попыткой. accountId=null — у провайдера нет managed-аккаунта → run.account_id
   *  ЯВНО очищается (success/cooldown не должны уйти аккаунту упавшего провайдера). */
  getNextAttempt?: (id: ProviderId) => FallbackAttempt | null
  /** Модель fallback-кандидата — чтобы cost-guard/журнал прогона считались по
   *  РЕАЛЬНОЙ модели fallback'а, а не по модели упавшего провайдера (#7). */
  getProviderModel: (id: ProviderId) => string | null
  /** Провайдеры с настроенными ключами. */
  configuredProviders: Set<ProviderId>
  /** Уже попробованные провайдеры (мутируется по ходу). */
  triedProviders: Set<ProviderId>
  /** 1.9.4: переключить активный аккаунт провайдера на лимите (пул подписок).
   *  2.1.3-CD: reason пишется в cooldown (честный UI кулдауна); результат несёт
   *  безопасные labels аккаунтов для route-evidence. */
  switchAccountOnLimit?: (providerId: string, resetEta: number | null, reason?: CooldownReason) => SwitchResult
  /** 1.9.7 ревью-фикс: счётчик выполненных account-switch за прогон (мутируется).
   *  Bounded MAX_ACCOUNT_SWITCHES — иначе при resetEta=null пул из ≥2 аккаунтов
   *  зацикливается навсегда (A→B→A→…), т.к. triedProviders на свитче не растёт. */
  accountSwitchCount?: number
  /** 2.0.8-D2: чат закреплён (pinned) за конкретным аккаунтом → авто-смена маршрута ЗАПРЕЩЕНА
   *  (инвариант 1): ни ротация аккаунта на лимите, ни provider-fallback — оба увели бы с
   *  закреплённого аккаунта. Прогон честно падает с ошибкой, не переключается молча. */
  pinnedAccount?: boolean
}

/** Максимальное количество fallback-попыток (original + 2 alternates). */
export const MAX_FALLBACK_ATTEMPTS = 2
/** Потолок account-switch за прогон: страховка от вечного цикла при resetEta=null
 *  (лимит без парсируемого ETA → аккаунт не остывает → бесконечная ротация). */
export const MAX_ACCOUNT_SWITCHES = 4

// Лимиты ходов agent-loop — общие для dispatch (ipc/ai.ts) и runner-api.
export const DEFAULT_AGENT_TURNS = 8
export const MAX_BUDGET_TURNS = 40  // hard ceiling even with continues — prevents infinite-budget abuse

// ─── Реестр pending-подтверждений (общий: ipc-хендлеры ai.ts ↔ runner-api) ───
// Keyed by `${sendId}::${callId}` — параллельные ai:send не резолвят чужие
// подтверждения. Синглтоны: ai:resolve-write/command/plan (в ai.ts) и построение
// ToolContext (в runner-api) делят ОДНИ И ТЕ ЖЕ Map'ы через ES-модуль.
export interface PendingWrite { sendId: number; resolve: (accept: boolean) => void }
export const pendingWrites = new Map<string, PendingWrite>()

export interface PendingCommand { sendId: number; resolve: (accept: boolean) => void }
export const pendingCommands = new Map<string, PendingCommand>()

/** ВНИМАНИЕ: с §10 (ожидание согласования вынесено наружу прогона) план-гейт этой
 *  картой БОЛЬШЕ НЕ ПОЛЬЗУЕТСЯ — `create_plan` не блокируется и никого сюда не
 *  кладёт, а `ai:resolve-plan` резолвит пустоту. Канал оставлен нетронутым, чтобы
 *  не трогать пути abort/suspend ради уборки; решение по плану идёт через
 *  `plans:resolve-approval`. Снос канала — в остатке блока B. */
export interface PendingPlan { sendId: number; resolve: (d: { decision: 'approve' | 'revise' | 'reject'; feedback?: string }) => void }
export const pendingPlans = new Map<string, PendingPlan>()

// #4 suspend: sendId'ы, прерванные как ПРИОСТАНОВКА (не Stop) — finally помечает
// прогон 'suspended' для ↻ Продолжить. Общий для ai:suspend (ai.ts) и finally (runner).
export const suspendedSends = new Set<number>()

export function scopedKey(sendId: number, callId: string): string {
  return `${sendId}::${callId}`
}

// ─── Реестр активных прогонов по чату (2.0.11-B) ───
// activeAborts в ai.ts ключуется по sendId и на вопрос «идёт ли сейчас стрим В ЭТОМ
// ЧАТЕ» не отвечает. Ручная компакция обязана его задать: сжать контекст под работающим
// прогоном — значит увести историю из-под него на полуслове.
// Заполняется там же, где activeAborts (ai.ts), теми же set/delete.
const activeChatRuns = new Map<number, number>() // sendId → chatId

export function registerChatRun(sendId: number, chatId: number | null | undefined): void {
  if (typeof chatId === 'number' && Number.isFinite(chatId)) activeChatRuns.set(sendId, chatId)
}

export function unregisterChatRun(sendId: number): void {
  activeChatRuns.delete(sendId)
  planForRun.delete(sendId)
}

// ── Идемпотентность create_plan (VSK-TASK-FLOW-A1, блок B) ──────────────────
//
// Один прогон = одна задача = один план. Модель, вызвавшая create_plan дважды
// (перечитала контекст, «уточнила» формулировку, ушла на второй круг), раньше
// плодила дубликаты: в разделе «Планы» появлялись два плана на одну задачу, и
// было неясно, какой из них исполняется.
//
// Решение РАНТАЙМОМ, а не промптом: помним planId прогона и на повторный вызов
// возвращаем его же. Промпт можно проигнорировать, реестр — нет.
//
// Ревизии это не мешает: доработка идёт отдельным инструментом `replan_plan`,
// который поднимает planRevision у ТОГО ЖЕ плана и через этот реестр не ходит.
const planForRun = new Map<number, number>() // sendId → planId

/** Запомнить план, созданный этим прогоном. */
export function rememberPlanForRun(sendId: number, planId: number): void {
  if (Number.isFinite(sendId) && Number.isFinite(planId)) planForRun.set(sendId, planId)
}

/** План, уже созданный этим прогоном, если он был. */
export function getPlanForRun(sendId: number): number | null {
  return planForRun.get(sendId) ?? null
}

/** Только для тестов: реестр — модульный синглтон, между кейсами его надо чистить. */
export function __resetPlanForRunForTests(): void {
  planForRun.clear()
}

// ── Ожидание согласования снаружи прогона (VSK-TASK-FLOW-A1 §10) ────────────
//
// Прогон, показавший карточку плана, завершается штатно и НЕ ждёт человека (см.
// `plan-await.ts`). Но продолжение после approve идёт по чекпойнту этого
// прогона, а чистое завершение чекпойнт удаляет (`runner-finalize`). Реестр —
// единственный сигнал финализации: «у этого прогона висит план, чекпойнт нужен».
//
// Ключ — runId, а не sendId: чекпойнты живут по runId, и решение может прийти
// после перезапуска приложения, когда sendId уже ничего не значит. Реестр
// внутрипроцессный и нужен ровно на окно «хендлер вернул → finalize отработал»;
// durable-состояние ожидания держит БД (план в draft + agent_run_id + чекпойнт).
const plansAwaitingApproval = new Map<string, number>() // runId → planId

/** Прогон показал карточку и завершается — его чекпойнт удалять нельзя. */
export function markPlanAwaitingApproval(runId: string | null | undefined, planId: number): void {
  if (typeof runId === 'string' && runId && Number.isFinite(planId)) {
    plansAwaitingApproval.set(runId, planId)
  }
}

/** План, ожидающий согласования по этому прогону, если он есть. */
export function getPlanAwaitingApproval(runId: string | null | undefined): number | null {
  if (typeof runId !== 'string' || !runId) return null
  return plansAwaitingApproval.get(runId) ?? null
}

/** Решение принято (или план удалён) — держать чекпойнт больше не за чем. */
export function clearPlanAwaitingApproval(runId: string | null | undefined): void {
  if (typeof runId === 'string' && runId) plansAwaitingApproval.delete(runId)
}

/** Только для тестов: реестр — модульный синглтон, между кейсами его надо чистить. */
export function __resetAwaitingPlansForTests(): void {
  plansAwaitingApproval.clear()
}

/** Идёт ли прямо сейчас прогон в этом чате. Гейт ручной компакции. */
export function hasActiveRunForChat(chatId: number): boolean {
  for (const id of activeChatRuns.values()) if (id === chatId) return true
  return false
}
