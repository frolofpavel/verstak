/**
 * Автоматическое резюме сессии при закрытии чата.
 * Не вызывает LLM — строит краткое описание из структуры сообщений.
 */

import type { Database } from 'better-sqlite3'
import { saveMemory } from '../storage/memories'
import { scanText } from './secret-scanner'

interface RawMessage {
  role: string
  content: string
}

/**
 * Формирует резюме завершённой chat-сессии и сохраняет его как 'fact' воспоминание.
 * Вызывается перед удалением сессии (или при переключении на другую).
 *
 * @param db         — база данных
 * @param sessionId  — ID сессии
 * @param projectPath — путь к проекту (для привязки памяти)
 * @param messages   — сообщения сессии
 */
export function summarizeAndSaveSession(
  db: Database,
  sessionId: number,
  projectPath: string,
  messages: RawMessage[]
): void {
  // Слишком короткая сессия — нечего резюмировать
  if (messages.length < 4) return

  const userMsgs = messages
    .filter(m => m.role === 'user')
    .map(m => m.content.slice(0, 200))

  const toolCallCount = messages.filter(m => m.role === 'tool').length

  // Извлекаем имена файлов из вызовов write_file / apply_patch в assistant-сообщениях
  const files = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.content) {
      // Ищем пути в JSON-подобных фрагментах тул-вызовов
      const matches = m.content.matchAll(/(?:write_file|apply_patch)[^"']*["']([^"']+\.\w+)["']/g)
      for (const match of matches) {
        if (match[1]) files.add(match[1])
      }
    }
  }

  const parts: string[] = [
    `Сессия #${sessionId}: ${userMsgs.length} запросов, ${toolCallCount} tool calls`,
  ]
  if (files.size > 0) {
    parts.push(`Файлы: ${[...files].slice(0, 5).join(', ')}`)
  }
  if (userMsgs.length > 0) {
    const topics = userMsgs.slice(0, 3).join(' | ').slice(0, 200)
    parts.push(`Темы: ${topics}`)
  }

  // scanText: parts включают сырые user-сообщения (Темы) — юзер мог вставить токен/ключ.
  // Иначе он осел бы в памяти и всплыл в recall → system prompt внешнего провайдера.
  const summary = scanText(parts.join('. ')).redacted
  saveMemory(db, projectPath, 'fact', summary, ['session', `session-${sessionId}`])
}
