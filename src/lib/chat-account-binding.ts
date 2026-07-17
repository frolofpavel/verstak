import type { SubscriptionAccountDTO, ChatSubscriptionBindingDTO } from '../types/api'

/**
 * Закрепление аккаунта за чатом — логика отображения (срез 2.0.10, хвост D2).
 *
 * Бэкенд закреплён ещё в 2.0.8-D2: `resolveChatAccount` даёт три состояния — auto / pinned /
 * **unavailable** (закреплён на УДАЛЁННЫЙ аккаунт → прогон честно останавливается вопросом,
 * а не уезжает молча на другой аккаунт). UI обязан говорить ровно то же: показать pinned там,
 * где pinned, и НЕ врать «закреплено», когда аккаунта уже нет.
 *
 * В notes 2.0.8 было обещано: «закрепление пока настраивается не из интерфейса, кнопка
 * появится в следующем релизе». Этот модуль — её мозг; ModelPicker — руки.
 */

export type ChatAccountView =
  /** Аккаунт выбирается автоматически (обычный режим). */
  | { kind: 'auto' }
  /** Чат закреплён за живым аккаунтом. */
  | { kind: 'pinned'; accountId: number; label: string }
  /** Чат закреплён за аккаунтом, которого больше НЕТ. Прогоны в этом чате не пойдут. */
  | { kind: 'unavailable'; accountId: number }

/**
 * Что показать для чата. Зеркалит main-side resolveChatAccount (route-policy.ts) — если эти
 * двое разойдутся, UI начнёт врать про то, что реально сделает движок.
 *
 * Биндинг ЧУЖОГО провайдера игнорируем: он про другой провайдер, к текущему выбору отношения
 * не имеет (иначе бейдж «закреплено» висел бы на провайдере, где закрепления нет).
 */
export function chatAccountView(
  binding: ChatSubscriptionBindingDTO | null,
  accounts: SubscriptionAccountDTO[],
  currentProviderId: string,
): ChatAccountView {
  if (!binding || binding.mode !== 'pinned' || binding.accountId == null) return { kind: 'auto' }
  if (binding.providerId !== currentProviderId) return { kind: 'auto' }
  const acc = accounts.find(a => a.id === binding.accountId)
  if (!acc) return { kind: 'unavailable', accountId: binding.accountId }
  return { kind: 'pinned', accountId: acc.id, label: acc.label }
}

/**
 * Есть ли смысл показывать закрепление. Только там, где аккаунты вообще существуют:
 * у обычного API-провайдера с одним ключом закреплять нечего — кнопка была бы шумом.
 */
export function canPinAccounts(accounts: SubscriptionAccountDTO[]): boolean {
  return accounts.length > 0
}

/**
 * Показывать ли секцию «Аккаунт подписки» — honesty & unbrick срез (ре-ревью B #4).
 *
 * Раньше решал только `canPinAccounts`, и получался чат-кирпич БЕЗ ВЫХОДА: человек
 * закрепил аккаунт, потом удалил все аккаунты провайдера — секция исчезла вместе с
 * последним аккаунтом, унося и предупреждение, и единственный способ открепиться
 * («Автоматически»). Движок при этом честно останавливает прогон, то есть чат молчит
 * навсегда, а починить его из интерфейса нечем.
 *
 * Поэтому: закрепление ВИСИТ → секция видна, даже когда закреплять уже не на что.
 * Выход из тупика важнее чистоты меню.
 */
export function shouldShowAccountBinding(
  accounts: SubscriptionAccountDTO[],
  view: ChatAccountView,
): boolean {
  return canPinAccounts(accounts) || view.kind !== 'auto'
}

/** Человеческая подпись состояния аккаунта — без жаргона (Павел маркетолог). */
export function accountStateLabel(a: SubscriptionAccountDTO): string {
  if (!a.hasCredential) return 'ключ не найден'
  if (a.state === 'ready') return 'готов'
  if (a.state === 'cooling') return 'остывает'
  if (a.state === 'login-required') return 'нужен вход'
  return 'ошибка'
}

/** Можно ли закрепить чат за этим аккаунтом прямо сейчас. */
export function isPinnable(a: SubscriptionAccountDTO): boolean {
  // Остывающий закрепить МОЖНО: остывание временно, а закрепление — про «работай только тут».
  // А вот без ключа/со сломанным входом закрепление гарантирует стоп прогонов — не даём.
  return a.hasCredential && a.state !== 'invalid' && a.state !== 'login-required'
}

/** Биндинг для записи: закрепить чат за аккаунтом. */
export function pinBinding(chatId: number, providerId: string, accountId: number): ChatSubscriptionBindingDTO {
  return { chatId, providerId, mode: 'pinned', accountId } as ChatSubscriptionBindingDTO
}

/** Биндинг для записи: вернуть автоматический выбор. */
export function autoBinding(chatId: number, providerId: string): ChatSubscriptionBindingDTO {
  return { chatId, providerId, mode: 'auto', accountId: null } as ChatSubscriptionBindingDTO
}
