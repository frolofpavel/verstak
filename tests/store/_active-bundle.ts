// PerChatState 4.4: состояние чата хранится ТОЛЬКО в chats. Тесты, снимавшие
// показания с top-level полей стора, читают его через этот хелпер — то есть через
// ту же поверхность, что и продакшен-читатели (useActiveChatField).
import { freshSnapshot, type SessionSnapshot } from '../../src/store/session-snapshot'

/** Bundle активного чата. Активного нет — пустой bundle, чтобы тест падал на
 *  осмысленном значении поля, а не на разыменовании undefined. */
export function active(state: { activeChatId: number | null; chats: Record<number, SessionSnapshot> }): SessionSnapshot {
  return (state.activeChatId != null ? state.chats[state.activeChatId] : undefined) ?? freshSnapshot()
}

/** Посеять bundle-поля активному чату. Замена прежнего
 *  `useProject.setState({ messages: [...] })`: после 4.4 состояние чата лежит
 *  только в chats, и тестовая заготовка обязана класть его туда же, куда рантайм. */
export function seedActive(
  store: {
    getState: () => { activeChatId: number | null; chats: Record<number, SessionSnapshot> }
    // Метод-синтаксис намеренно: сигнатура setState в zustand шире нашей, и только
    // бивариантность методов позволяет передать сюда реальный стор без каста.
    setState(patch: { activeChatId: number; chats: Record<number, SessionSnapshot> }, replace?: boolean): void
  },
  patch: Partial<SessionSnapshot>,
  chatId?: number,
): void {
  const s = store.getState()
  const id = chatId ?? s.activeChatId ?? 1
  const base = s.chats[id] ?? { ...freshSnapshot(), chatId: id }
  store.setState({ activeChatId: id, chats: { ...s.chats, [id]: { ...base, ...patch, chatId: id } } }, false)
}
