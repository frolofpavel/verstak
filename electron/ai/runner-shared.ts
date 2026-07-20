// Общие типы/константы runner'ов (распил ai.ts, 1.9.8 #1, срез 4a).
//
// Вынесено из ipc/ai.ts, чтобы РАЗОРВАТЬ циклическую зависимость перед переездом
// самих runner-функций: и ipc/ai.ts (runApiConversation), и будущий runner-plain.ts
// (runPlainConversation) импортируют отсюда — общий источник без цикла значений.

import type { ProviderId } from './registry'
import type { ChatProvider } from './types'
import type { SwitchResult } from '../storage/subscription-accounts'
import type { CooldownReason } from '../../shared/contracts/subscription'

export interface FallbackOpts {
  /** Создаёт провайдера для указанного fallback-кандидата (null если нет ключа). */
  getNextProvider: (id: ProviderId) => ChatProvider | null
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
}

/** Идёт ли прямо сейчас прогон в этом чате. Гейт ручной компакции. */
export function hasActiveRunForChat(chatId: number): boolean {
  for (const id of activeChatRuns.values()) if (id === chatId) return true
  return false
}
