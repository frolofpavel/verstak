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
/**
 * Как показать закрепление аккаунта — ДОЛЖНО зеркалить движок (route-policy.pickChatAccountId),
 * иначе UI и прогон разъезжаются (ре-ревью honesty, HIGH-регрессия 8bdc11e).
 *
 * Ловушка, которую это чинит: `binding.providerId` main СИНТЕЗИРУЕТ из текущего провайдера
 * чата (chats.ts) — в БД провайдера пина нет. Поэтому сверка `binding.providerId !==
 * currentProviderId` в проде всегда ложна (оба операнда из одного источника) и была мертва.
 * Из-за этого пин на аккаунт ДРУГОГО, живого провайдера показывался как «аккаунт удалён»,
 * а кнопка «Открепить» снесла бы рабочий пин — при том, что движок спокойно даёт auto.
 *
 * Движок судит по ГЛОБАЛЬНОМУ существованию аккаунта: жив под текущим провайдером → pinned;
 * жив под другим → пин нерелевантен → auto; не существует нигде → unavailable. Здесь так же —
 * поэтому нужен `allAccounts` (все провайдеры), а не только текущий.
 *
 * @param accounts    аккаунты ТЕКУЩЕГО провайдера (для ярлыка закреплённого).
 * @param allAccounts аккаунты ВСЕХ провайдеров (для сверки «жив ли где-нибудь»).
 */
export function chatAccountView(
  binding: ChatSubscriptionBindingDTO | null,
  accounts: SubscriptionAccountDTO[],
  currentProviderId: string,
  allAccounts: SubscriptionAccountDTO[] = accounts,
): ChatAccountView {
  if (!binding || binding.mode !== 'pinned' || binding.accountId == null) return { kind: 'auto' }
  const acc = accounts.find(a => a.id === binding.accountId)
  if (acc) return { kind: 'pinned', accountId: acc.id, label: acc.label }
  // Нет среди аккаунтов текущего провайдера. Жив под другим → пин нерелевантен (движок даёт
  // auto, не трогаем). Не существует нигде → реально удалён → unavailable (стоп-с-вопросом).
  if (allAccounts.some(a => a.id === binding.accountId)) return { kind: 'auto' }
  return { kind: 'unavailable', accountId: binding.accountId }
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
