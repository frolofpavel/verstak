// Общие типы/константы runner'ов (распил ai.ts, 1.9.8 #1, срез 4a).
//
// Вынесено из ipc/ai.ts, чтобы РАЗОРВАТЬ циклическую зависимость перед переездом
// самих runner-функций: и ipc/ai.ts (runApiConversation), и будущий runner-plain.ts
// (runPlainConversation) импортируют отсюда — общий источник без цикла значений.

import type { ProviderId } from './registry'
import type { ChatProvider } from './types'

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
  /** 1.9.4: переключить активный аккаунт провайдера на лимите (пул подписок). */
  switchAccountOnLimit?: (providerId: string, resetEta: number | null) => { switched: boolean }
  /** 1.9.7 ревью-фикс: счётчик выполненных account-switch за прогон (мутируется).
   *  Bounded MAX_ACCOUNT_SWITCHES — иначе при resetEta=null пул из ≥2 аккаунтов
   *  зацикливается навсегда (A→B→A→…), т.к. triedProviders на свитче не растёт. */
  accountSwitchCount?: number
}

/** Максимальное количество fallback-попыток (original + 2 alternates). */
export const MAX_FALLBACK_ATTEMPTS = 2
/** Потолок account-switch за прогон: страховка от вечного цикла при resetEta=null
 *  (лимит без парсируемого ETA → аккаунт не остывает → бесконечная ротация). */
export const MAX_ACCOUNT_SWITCHES = 4
