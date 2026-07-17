import { ipcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { Chats } from '../storage/chats'
import type { ChatProvider } from '../ai/types'
import { compactChatContext, contextState } from '../ai/compaction-service'
import { summarizeOnce } from '../ai/summarize-once'
import { hasActiveRunForChat } from '../ai/runner-shared'
import { snapshotHistory } from '../storage/chat-context-snapshots'
import type { CompactableMessage } from '../ai/manual-compaction'
import { logRuntime } from '../runtime-log'

/**
 * IPC ручной компакции контекста — срез 2.0.11-B.
 *
 * Тонкий слой: вся логика (гейт, граница, страж гонки) живёт в compaction-service и
 * покрыта тестами. Здесь только маппинг storage → сервис и разбор результата.
 */

export interface ContextCompactionDeps {
  db: Database
  chats: Chats
  /** Провайдер для summary. null — нет ключей/настроек (честная ошибка, не молчание). */
  createSummaryProvider: () => { provider: ChatProvider; providerId: string; model: string | null } | null
}

/** storage-сообщения → вход компакции. id строки становится границей снапшота. */
function toCompactable(messages: ReturnType<Chats['listBySession']>): CompactableMessage[] {
  return messages.map(m => ({ role: m.role, content: m.content, dbId: m.id }))
}

export function registerContextCompactionIpc(deps: ContextCompactionDeps): void {
  /** Состояние контекста чата — для ContextMeter. */
  ipcMain.handle('context:state', (_e, chatId: number) => {
    const messages = toCompactable(deps.chats.listBySession(chatId))
    return { ...contextState(deps.db, chatId, messages), busy: hasActiveRunForChat(chatId) }
  })

  /** История сжатий чата — аудит и путь отката (карточка B п.9). */
  ipcMain.handle('context:snapshots', (_e, chatId: number) => snapshotHistory(deps.db, chatId))

  /** Сжать контекст чата. Долгая операция: внутри — вызов модели. */
  ipcMain.handle('context:compact', async (_e, chatId: number) => {
    const resolved = deps.createSummaryProvider()
    if (!resolved) {
      return { ok: false, reason: 'summary-failed', detail: 'провайдер для сжатия не настроен' }
    }

    const result = await compactChatContext(deps.db, chatId, {
      loadMessages: id => toCompactable(deps.chats.listBySession(id)),
      summarize: prompt => summarizeOnce(resolved.provider, [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ]),
      hasActiveRun: hasActiveRunForChat,
      now: () => Date.now(),
      providerId: resolved.providerId,
      model: resolved.model,
    })

    if (result.ok) {
      logRuntime('context.compact.ok', {
        chatId,
        compacted: result.compactedCount,
        kept: result.keptCount,
        before: result.snapshot.estimatedTokensBefore,
        after: result.snapshot.estimatedTokensAfter,
      })
    } else {
      // Осечка компакции — не ошибка приложения: контекст цел, пользователь увидит причину.
      logRuntime('context.compact.skip', { chatId, reason: result.reason }, 'warn')
    }
    return result
  })
}
