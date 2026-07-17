import type { ChatMessage } from '../types/api'

/**
 * Правка/перезапуск сообщения через Fork — срез 2.0.11-D (чистое ядро).
 *
 * Где резать форк, чтобы отредактировать сообщение. Правка НЕ мутирует оригинал: форкаем
 * историю ДО редактируемого сообщения (не включая его), отредактированный текст уходит в
 * ветку черновиком. Оригинал остаётся byte-for-byte, неудачная правка не рушит исходный чат.
 *
 * Редактируем только СВОЙ ввод (user-сообщение): ответ ассистента генерируется, править
 * его и перезапускать с него бессмысленно — перезапуск идёт от реплики человека.
 */

export type ForkPoint =
  | { ok: true; uptoMessageId: number | null; originalText: string }
  | { ok: false; reason: 'not-found' | 'not-user-message' }

export function forkPointForMessage(messages: ChatMessage[], messageId: number): ForkPoint {
  // Форкать можно только по реальному id строки БД. Нечисловой messageId (или dbId у
  // оптимистичного, ещё не записанного сообщения) не годится — иначе findIndex по
  // undefined случайно поймал бы первое оптимистичное сообщение.
  if (typeof messageId !== 'number' || !Number.isFinite(messageId)) return { ok: false, reason: 'not-found' }
  const idx = messages.findIndex(m => m.dbId === messageId)
  if (idx < 0) return { ok: false, reason: 'not-found' }

  const target = messages[idx]
  if (target.role !== 'user') return { ok: false, reason: 'not-user-message' }

  // Граница — предыдущее сообщение ПО ПОРЯДКУ (id в chats глобальны, между сообщениями
  // чата лежат id других чатов → id−1 неверно). Первое сообщение → форк пустой (null).
  const prev = messages[idx - 1]
  const uptoMessageId = prev?.dbId ?? null

  return { ok: true, uptoMessageId, originalText: target.content }
}
