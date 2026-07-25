import { freshSnapshot, type ChatStateBundle, type SessionSnapshot } from './session-snapshot'

// PerChatState 4.1 (writers-first): ЕДИНАЯ точка мутации bundle одного чата.
// Активный чат живёт в top-level полях стора, фоновые — в chatSnapshots[chatId];
// раньше каждый writer выбирал цель руками (и забывал про фон — класс багов
// «событие фонового чата упало в активный»). applyBundleUpdate — чистая функция
// маршрутизации патча: по chatId решает КУДА он ложится; updateChatBundle в
// projectStore — тонкая set()-обёртка над ней.
// ProjectState сюда НЕ импортируем (цикл projectStore ↔ helper) — только
// структурный срез BundleHostState; ProjectState ему удовлетворяет.

/** Структурный срез ProjectState, нужный для маршрутизации патча bundle. */
export interface BundleHostState extends ChatStateBundle {
  activeChatId: number | null
  /** В helpMode активный проектный чат ФОНОВЫЙ: openHelpChat снимает его в
   *  chatSnapshots[activeChatId], не меняя activeChatId. Живое состояние — в
   *  снапшоте (leaveHelpMode восстанавливает из него), поэтому патчи такого
   *  чата обязаны идти в снапшот, а не в top-level. */
  helpMode: boolean
  chatSnapshots: Record<number, SessionSnapshot>
}

/** Патч bundle. hasUnread допустим только для фонового снапшота — для активного
 *  чата (top-level) он бессмыслен и отбрасывается маршрутизатором. */
export type BundlePatch = (Partial<ChatStateBundle> & { hasUnread?: boolean }) | null | undefined

/** Мутация bundle: получает текущий bundle чата, возвращает патч (null = no-op). */
export type BundleUpdater = (bundle: ChatStateBundle) => BundlePatch

/**
 * Применить updater к bundle чата chatId и вернуть set()-патч для стора.
 *
 * Маршрутизация:
 * - chatId == null («текущий активный», семантика старых экшенов без явного
 *   chatId) → top-level;
 * - chatId === activeChatId И нет снапшота → top-level (обычный активный чат);
 * - chatId === activeChatId В helpMode И снапшот есть → снапшот (чат уведён в
 *   фон справкой; события роутятся сюда из Chat.tsx по условию helpMode);
 * - иначе (фоновый чат) → chatSnapshots[chatId]; снапшота ещё нет → стартуем
 *   с freshSnapshot (как раньше руками делали applyEventToChat/seedChatSnapshot).
 */
export function applyBundleUpdate(
  state: BundleHostState,
  chatId: number | null,
  updater: BundleUpdater
): Partial<BundleHostState> {
  const snap = chatId != null ? state.chatSnapshots[chatId] : undefined
  const backgrounded = chatId != null
    && (chatId !== state.activeChatId || (state.helpMode && snap != null))
  if (!backgrounded) {
    const patch = updater(state)
    if (!patch) return {}
    // hasUnread — поле только снапшотов; в top-level активного чата не протаскиваем.
    const { hasUnread: _drop, ...topLevel } = patch
    void _drop
    return Object.keys(topLevel).length > 0 ? topLevel : {}
  }
  const existing = snap ?? freshSnapshot()
  const patch = updater(existing)
  if (!patch || Object.keys(patch).length === 0) return {}
  return { chatSnapshots: { ...state.chatSnapshots, [chatId]: { ...existing, ...patch } } }
}
