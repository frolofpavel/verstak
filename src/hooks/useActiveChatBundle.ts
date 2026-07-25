import { useProject } from '../store/projectStore'
import type { ChatStateBundle } from '../store/session-snapshot'

/**
 * PerChatState 4.3: единая точка ЧТЕНИЯ bundle активного чата — из chats (SSOT),
 * а не из top-level проекции (top-level bundle-поля будут удалены в 4.4).
 *
 * Гранулярность по полю: селектор возвращает само поле, поэтому zustand
 * перерисовывает компонент только при смене ЭТОГО поля (как раньше при чтении
 * top-level поля напрямую). undefined — если активного чата нет.
 *
 * Нюанс helpMode: в справке chats[activeChatId] — ЖИВОЙ фоновый чат (события
 * идут в него), а не замороженная top-level копия, как раньше. Для читателей
 * «состояние проектного чата» это корректнее; Chat.tsx переключает help/проект
 * вручную, как и прежде.
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
