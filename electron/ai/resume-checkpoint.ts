import type { ChatMessage } from './types'

/**
 * Crash-resume Фаза 2: безопасно распарсить снапшот истории loop'а
 * (agent_run_checkpoints.messages_json) для возобновления прерванной сессии.
 *
 * Любая проблема — битый JSON, не массив, пусто, элемент без валидной role —
 * возвращает null: возобновление мягко падает на свежий старт (re-send последнего
 * запроса), а НЕ роняет ai:send. Снапшот мог записаться частично при краше, поэтому
 * валидируем строго перед тем, как скормить историю провайдеру.
 */
export function parseResumeCheckpoint(messagesJson: string | null | undefined): ChatMessage[] | null {
  if (!messagesJson || typeof messagesJson !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(messagesJson)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const allValid = parsed.every(
    m => m != null && typeof m === 'object' && typeof (m as { role?: unknown }).role === 'string'
  )
  if (!allValid) return null
  return parsed as ChatMessage[]
}

/**
 * Гард совместимости возобновления (1.9.8 #4). Формат истории (tool_use-блоки,
 * структура сообщений) привязан к ПРОВАЙДЕРУ: CLI↔API и Claude↔Gemini↔OpenAI
 * несовместимы — реплей истории одного в формат другого даёт битые tool_use /
 * ошибку API. Реплеим сохранённый контекст ТОЛЬКО когда провайдер текущего
 * запроса совпадает с провайдером чекпойнта; иначе — свежий старт (запрос
 * перезапускается с нуля, что безопасно). Модель внутри одного провайдера не
 * гейтим — формат сообщений тот же.
 */
export function canReplayCheckpoint(
  checkpointRun: { providerId: string | null } | null | undefined,
  currentProviderId: string
): boolean {
  if (!checkpointRun) return false
  return checkpointRun.providerId === currentProviderId
}
