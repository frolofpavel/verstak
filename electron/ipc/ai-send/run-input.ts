// Распил ai.ts (2.1.10-G): снапшот реального входа прогона (Debug Packet).
//
// Вынесено из registerAiIpc БЕЗ изменения логики. Точек вызова две, и они не
// симметричны по времени:
//  · API-путь — сразу после сборки system-промпта, systemPrompt = composedSystem
//    со снятым cache-маркером;
//  · CLI-путь — колбэком onPromptBuilt самого провайдера, systemPrompt = фактически
//    отправленный payload (2.2 speed: второй дорогой сборки контекста больше нет).
//
// Общее у них — выбор последнего user-сообщения и то, что снапшот НЕ критичен:
// исключение здесь не имеет права уронить прогон.

import type { ChatMessage } from '../../ai/types'
import type { ProviderId } from '../../ai/registry'
import { COMPUTER_CONTEXT_OMITTED } from '../../ai/tool-telemetry'

export type SaveRunInput = (input: {
  runId: string
  projectPath: string | null
  chatId: number | null
  timestamp: number
  providerId: string | null
  model: string | null
  systemPrompt: string
  userMessage: string
}) => void

export function saveRunInputSnapshot(input: {
  save: SaveRunInput | undefined
  runId: string
  projectPath: string | null
  chatId: number | null
  providerId: ProviderId
  model: string | null
  /** Уже готовая system-строка: API — composedSystem без cache-маркера, CLI — payload. */
  systemPrompt: string
  messages: ChatMessage[]
  /** Computer-команда и собранный CLI payload являются execution data, а не Debug Packet. */
  omitComputerContext?: boolean
}): void {
  if (!input.save) return
  const lastUser = [...input.messages].reverse().find(m => m.role === 'user')
  try {
    input.save({
      runId: input.runId,
      projectPath: input.projectPath,
      chatId: input.chatId,
      timestamp: Date.now(),
      providerId: input.providerId,
      model: input.model,
      systemPrompt: input.omitComputerContext ? COMPUTER_CONTEXT_OMITTED : input.systemPrompt,
      userMessage: input.omitComputerContext ? COMPUTER_CONTEXT_OMITTED : (lastUser?.content ?? '')
    })
  } catch { /* snapshot not critical — run continues unaffected */ }
}
