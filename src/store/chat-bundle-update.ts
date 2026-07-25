import { captureBundle, freshSnapshot, type ChatStateBundle, type SessionSnapshot } from './session-snapshot'

// PerChatState 4.1 (writers-first) → 4.2 (единое хранилище): ЕДИНАЯ точка
// мутации bundle одного чата. Активный чат живёт в top-level полях стора,
// фоновые — в chatSnapshots[chatId]; раньше каждый writer выбирал цель руками
// (и забывал про фон — класс багов «событие фонового чата упало в активный»).
//
// 4.2: добавлен chats — SSOT, bundle КАЖДОГО чата активного проекта, включая
// активный. top-level bundle-поля — поддерживаемая проекция chats[activeChatId];
// chatSnapshots — поддерживаемая вьюха «chats минус foreground активный».
// Обе проекции обновляются здесь же атомарно, в одном патче.
//
// applyBundleUpdate — чистая функция маршрутизации патча: по chatId решает
// КУДА он ложится; updateChatBundle в projectStore — тонкая set()-обёртка.
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
  /** PerChatState 4.2: SSOT — bundle каждого чата активного проекта, включая
   *  активный (foreground). Инвариант: chats = chatSnapshots ∪ {activeChatId},
   *  а для foreground top-level bundle-поля ≡ chats[activeChatId]. */
  chats: Record<number, SessionSnapshot>
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
 *   chatId) → top-level (chats не поддерживается — id неизвестен);
 * - chatId === activeChatId И нет снапшота → top-level + chats[chatId]
 *   (обычный активный чат: проекция + SSOT);
 * - chatId === activeChatId В helpMode И снапшот есть → снапшот + chats[chatId]
 *   (чат уведён в фон справкой; события роутятся сюда из Chat.tsx по условию
 *   helpMode);
 * - иначе (фоновый чат) → chatSnapshots[chatId] + chats[chatId]; снапшота ещё
 *   нет → стартуем с freshSnapshot (как раньше руками делали
 *   applyEventToChat/seedChatSnapshot).
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
    if (Object.keys(topLevel).length === 0) return {}
    // SSOT: chats[active] получает то же изменение. База — существующая запись
    // или текущий top-level (captureBundle), если записи ещё нет (например,
    // до первого lifecycle-перехода). foreground смотрится → hasUnread=false.
    if (chatId == null) return topLevel
    const base = state.chats[chatId] ?? captureBundle(state)
    return { ...topLevel, chats: { ...state.chats, [chatId]: { ...base, ...topLevel, hasUnread: false } } }
  }
  const existing = snap ?? freshSnapshot()
  const patch = updater(existing)
  if (!patch || Object.keys(patch).length === 0) return {}
  // Одна и та же next-копия в обе проекции: chatSnapshots (вьюха) и chats (SSOT)
  // для фонового чата тождественны по инварианту.
  const next = { ...existing, ...patch }
  return {
    chatSnapshots: { ...state.chatSnapshots, [chatId]: next },
    chats: { ...state.chats, [chatId]: next },
  }
}
