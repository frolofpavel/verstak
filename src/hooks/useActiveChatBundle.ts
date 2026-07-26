import { useProject } from '../store/projectStore'
import type { ChatStateBundle } from '../store/session-snapshot'

/**
 * Единая точка ЧТЕНИЯ bundle активного чата из chats — единственного хранилища
 * состояния чатов (PerChatState 4.4).
 *
 * Гранулярность по полю: селектор возвращает само поле, поэтому zustand
 * перерисовывает компонент только при смене ЭТОГО поля. undefined — активного
 * чата нет.
 *
 * Нюанс helpMode: в справке chats[activeChatId] — ЖИВОЙ проектный чат (события
 * идут в него). Chat.tsx переключает help/проект вручную.
 */
export function useActiveChatField<K extends keyof ChatStateBundle>(key: K): ChatStateBundle[K] | undefined {
  return useProject(s => (s.activeChatId != null ? s.chats[s.activeChatId]?.[key] : undefined))
}

/** Весь bundle активного чата (ре-рендер на ЛЮБОЕ изменение bundle — брать
 *  осознанно; для одного-двух полей предпочтительнее useActiveChatField). */
export function useActiveChatBundle(): ChatStateBundle | undefined {
  return useProject(s => (s.activeChatId != null ? s.chats[s.activeChatId] : undefined))
}

/** Non-reactive снимок для event-handlers — замена useProject.getState().<поле>
 *  для bundle-полей активного чата. */
export function getActiveChatBundle(): ChatStateBundle | undefined {
  const s = useProject.getState()
  return s.activeChatId != null ? s.chats[s.activeChatId] : undefined
}
