import type { ChatMessage } from '../types/api'

/**
 * Чистые операции над списком сообщений чата. Раньше дублировались по стору
 * (updateLastAssistant / appendLastAssistantThinking / help-версии) и в
 * apply-snapshot-event. Единый источник истины → нечего рассинхронить.
 * Все функции иммутабельны: возвращают новый массив, исходный не трогают.
 */

/** Стрим-токен: дописать к последнему assistant, либо начать нового, если
 *  последнее сообщение — не assistant (или список пуст). */
export function appendOrStartAssistant(messages: ChatMessage[], text: string): ChatMessage[] {
  const msgs = [...messages]
  const last = msgs[msgs.length - 1]
  if (last?.role === 'assistant') {
    msgs[msgs.length - 1] = { ...last, content: last.content + text }
  } else {
    msgs.push({ role: 'assistant', content: text })
  }
  return msgs
}

/** Дописать к последнему assistant БЕЗ создания нового (no-op, если последний
 *  не assistant). Для дельт, которые осмысленны только при живом ответе. */
export function appendToLastAssistant(messages: ChatMessage[], text: string): ChatMessage[] {
  const msgs = [...messages]
  const last = msgs[msgs.length - 1]
  if (last?.role === 'assistant') {
    msgs[msgs.length - 1] = { ...last, content: last.content + text }
  }
  return msgs
}

/** Дописать chain-of-thought (thinking) к последнему assistant (no-op иначе). */
export function appendThinkingToLastAssistant(messages: ChatMessage[], text: string): ChatMessage[] {
  const msgs = [...messages]
  const last = msgs[msgs.length - 1]
  if (last?.role === 'assistant') {
    msgs[msgs.length - 1] = { ...last, thinking: (last.thinking ?? '') + text }
  }
  return msgs
}
