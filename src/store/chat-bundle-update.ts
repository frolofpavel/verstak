import { freshSnapshot, type ChatStateBundle, type SessionSnapshot } from './session-snapshot'

// PerChatState 4.1 (writers-first) → 4.2 (SSOT) → 4.4 (удаление дублей):
// ЕДИНАЯ точка мутации bundle одного чата.
//
// Историческая справка, чтобы не восстановили дубли обратно: до 4.4 состояние чата
// хранилось трижды — top-level поля стора (активный чат), chatSnapshots (фоновые) и
// chats (SSOT, введён в 4.2). Каждый writer выбирал цель руками и забывал про фон —
// класс багов «событие фонового чата упало в активный». Теперь хранилище одно: chats.
//
// applyBundleUpdate — чистая функция: применяет updater к bundle чата и возвращает
// патч для стора. updateChatBundle в projectStore — тонкая set()-обёртка.
// ProjectState сюда НЕ импортируем (цикл projectStore ↔ helper) — только структурный
// срез BundleHostState; ProjectState ему удовлетворяет.

/** Структурный срез ProjectState, нужный для маршрутизации патча bundle. */
export interface BundleHostState {
  activeChatId: number | null
  /** PerChatState 4.4: ЕДИНСТВЕННОЕ хранилище состояния чатов активного проекта. */
  chats: Record<number, SessionSnapshot>
}

/** Патч bundle. hasUnread осмысленен только для фонового чата: активный человек
 *  смотрит прямо сейчас, для него непрочитанного не бывает. */
export type BundlePatch = (Partial<ChatStateBundle> & { hasUnread?: boolean }) | null | undefined

/** Мутация bundle: получает текущий bundle чата, возвращает патч (null = no-op). */
export type BundleUpdater = (bundle: ChatStateBundle) => BundlePatch

/**
 * Применить updater к bundle чата chatId и вернуть set()-патч для стора.
 *
 * chatId == null — семантика старых экшенов «текущий активный»: цель берётся из
 * activeChatId. Активного нет — писать некуда, no-op.
 *
 * Записи чата ещё нет (первое событие фонового чата) → стартуем с freshSnapshot:
 * раньше это делалось руками в applyEventToChat/seedChatSnapshot.
 *
 * hasUnread активного чата всегда false — он на экране.
 */
export function applyBundleUpdate(
  state: BundleHostState,
  chatId: number | null,
  updater: BundleUpdater
): Partial<BundleHostState> {
  const target = chatId ?? state.activeChatId
  if (target == null) return {}
  const existing = state.chats[target] ?? { ...freshSnapshot(), chatId: target }
  const patch = updater(existing)
  if (!patch || Object.keys(patch).length === 0) return {}
  const next: SessionSnapshot = { ...existing, ...patch, chatId: target }
  if (target === state.activeChatId) next.hasUnread = false
  return { chats: { ...state.chats, [target]: next } }
}
