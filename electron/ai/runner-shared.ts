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
//
// V2-2 (agent-runtime-v2.md §4): дефолт обычного прогона был 8 и опровергнут
// СОБСТВЕННЫМ замером продукта — тем самым, что ниже обосновывает SPAWN_TASK_TURNS:
// задача «прочитать материалы + сделать артефакт» упёрлась на 8 ходах (11 вызовов,
// артефакт не дошёл). Вывод тогда применили ТОЛЬКО к спавн-сессиям, а обычный чат,
// где человек работает каждый день, остался на опровергнутом числе. Замер Arena
// 09–10.08 подтвердил границу с другой стороны: оба слабых класса (правка связанных
// файлов, регрессия от собственной правки) укладываются в 8–10 ходов, то есть на
// дефолте 8 половина таких задач упиралась в стену на середине.
export const DEFAULT_AGENT_TURNS = 16
// Пол ЯВНОГО бюджета — отдельная константа, и это не косметика. Пока пол и дефолт
// были одним числом, поднятие дефолта молча переписывало бы бюджет, назначенный
// человеком: композер просит 10 — получает 16. Явное решение человека не трогаем,
// поднимаем только то, что он не назначал.
export const MIN_AGENT_TURNS = 8
export const MAX_BUDGET_TURNS = 40  // hard ceiling even with continues — prevents infinite-budget abuse
// Бюджет ходов ВЫНЕСЕННОЙ (спавн) сессии (задача C(а), 08.08). Больше обычного:
// самостоятельная задача идёт без человека рядом и остановиться ей дороже.
export const SPAWN_TASK_TURNS = 24

/**
 * Итоговый бюджет ходов прогона. Явный budget (из композера) побеждает; при его
 * отсутствии дочерняя (спавн) сессия получает SPAWN_TASK_TURNS, обычная — DEFAULT.
 * Пол MIN и потолок MAX. Пуре ради тестируемости.
 */
export function resolveTurnsBudget(budget: number | undefined, isChildSession: boolean): number {
  const fallback = isChildSession ? SPAWN_TASK_TURNS : DEFAULT_AGENT_TURNS
  return Math.min(MAX_BUDGET_TURNS, Math.max(MIN_AGENT_TURNS, budget ?? fallback))
}

// ── V2-2: автопродолжение бюджета, пока есть прогресс ───────────────────────
//
// Поднятого дефолта мало: длинная работа упиралась бы в стену просто позже.
// Постановка: продолжение АВТОМАТИЧЕСКОЕ, пока есть прогресс; ручное «+10 ходов» —
// только когда прогресса нет. Признак прогресса берём у V2-4 (ai/progress.ts) —
// один сигнал на обе правки, иначе они разъехались бы и продление однажды
// продлило бы застой.
/** На сколько ходов продлеваем за раз. */
export const AUTO_CONTINUE_STEP = 8
/** Сколько раз подряд можно продлить без человека (bounded поверх потолка MAX). */
export const MAX_AUTO_CONTINUES = 3

export type AutoContinueReason = 'progress' | 'not-allowed' | 'no-progress' | 'bounded' | 'ceiling'

export interface AutoContinueInput {
  /** Текущий бюджет прогона. */
  budget: number
  /**
   * Разрешено ли ЭТОМУ прогону растить бюджет самому. Разрешение — ЯВНОЕ, и это
   * не осторожность ради осторожности: `runApiConversation` зовут не только из
   * чата, но и из пайплайнов, делегирования и спавн-сессий, где бюджет — часть
   * условия задачи. Эластичный бюджет по умолчанию менял бы поведение всем им
   * разом. Даёт разрешение тот, кто знает, что бюджет никто не назначал:
   * дефолтный ход человека в чате и облачная задача без явного лимита.
   */
  allowed: boolean
  /** Ходов подряд без нового факта на момент проверки (V2-4). */
  staleTurns: number
  /** Сколько раз этот прогон уже продлевали автоматически. */
  extensions: number
}

/**
 * Продлевать ли бюджет вместо остановки. Порядок проверок — от «чужого решения»
 * к «нашему»: без явного разрешения вызывающего не растим бюджет ни при каком
 * прогрессе.
 *
 * Условие прогресса намеренно СТРОГОЕ — ровно «последний ход дал новый факт»
 * (staleTurns === 0), а не «прогон в целом ещё не встал». Продление тратит деньги
 * человека; если работа уже замедлилась, решение остаётся за ним — кнопка
 * «+10 ходов» никуда не делась. Ошибаться дешевле в эту сторону.
 */
export function decideAutoContinue(input: AutoContinueInput): { extend: boolean; nextBudget: number; reason: AutoContinueReason } {
  const stay = (reason: AutoContinueReason) => ({ extend: false, nextBudget: input.budget, reason })
  if (!input.allowed) return stay('not-allowed')
  if (input.staleTurns > 0) return stay('no-progress')
  if (input.extensions >= MAX_AUTO_CONTINUES) return stay('bounded')
  if (input.budget >= MAX_BUDGET_TURNS) return stay('ceiling')
  return { extend: true, nextBudget: Math.min(MAX_BUDGET_TURNS, input.budget + AUTO_CONTINUE_STEP), reason: 'progress' }
}

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
