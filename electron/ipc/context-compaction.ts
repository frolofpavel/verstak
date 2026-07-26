import { ipcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { Chats } from '../storage/chats'
import type { ChatProvider } from '../ai/types'
import { compactChatContext, contextState } from '../ai/compaction-service'
import { summarizeOnce } from '../ai/summarize-once'
import { hasActiveRunForChat } from '../ai/runner-shared'
import { snapshotHistory } from '../storage/chat-context-snapshots'
import type { CompactableMessage } from '../ai/manual-compaction'
import { capturePreCompressMemories } from '../ai/memory-lifecycle'
import { listMemories, saveMemory } from '../storage/memories'
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
  /** Проект чата — граница памяти события pre-compress. null = писать некуда. */
  chatProjectPath: (chatId: number) => string | null
  /** Настройка memory lifecycle. По умолчанию событие включено. */
  isMemoryLifecycleEnabled?: () => boolean
}

/**
 * storage-сообщения → вход компакции. id строки становится границей снапшота.
 *
 * thinking прокидывается ОСОЗНАННО (ре-ревью B, #6/#7/#9): в длинной агентной сессии ход
 * рассуждений весит не меньше видимого текста, и без него счётчик занижал размер.
 *
 * ЧЕСТНАЯ ГРАНИЦА: вложения (скриншоты, PDF) в таблице `chats` НЕ хранятся вовсе — они
 * живут только в renderer и уходят прямо в ai:send. Поэтому счётчик контекста их не видит
 * и на чате со скриншотами занижает оценку. Это ограничение ИСТОЧНИКА, а не счётчика:
 * estimateTokens вложения считать умеет, подать их сюда неоткуда. Заявление коммита
 * d02b813 («чат из скриншотов не выглядит пустым») в этой части было неверным.
 */
function toCompactable(messages: ReturnType<Chats['listBySession']>): CompactableMessage[] {
  return messages.map(m => ({
    role: m.role,
    content: m.content,
    dbId: m.id,
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }))
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
      // memory lifecycle `pre-compress` (2.1.13): забрать решения и факты из части,
      // которая уходит под сжатие. Извлечение идёт тем же одноразовым путём, что и
      // summary — вне agent-loop и без инструментов.
      captureMemories: async input => {
        const projectPath = deps.chatProjectPath(chatId)
        const outcome = await capturePreCompressMemories({
          projectPath,
          messages: input.compacted.map(m => ({ role: m.role, content: m.content })),
          previousSummary: input.previousSummary,
          enabled: deps.isMemoryLifecycleEnabled?.() ?? true,
          extract: prompt => summarizeOnce(resolved.provider, [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ]),
          existingContents: () => projectPath ? listMemories(deps.db, projectPath).map(m => m.content) : [],
          // Атомарность пачки: либо записаны все отобранные факты, либо ни одного.
          // Полупачка — худший исход: часть решений сохранена, часть потеряна, и понять
          // чего не хватает уже нельзя.
          saveBatch: (project, items) => {
            deps.db.transaction(() => {
              for (const item of items) saveMemory(deps.db, project, item.type, item.content, item.tags)
            })()
          },
        })
        logRuntime('memory.lifecycle.pre_compress', {
          chatId,
          projectPath,
          ok: outcome.ok,
          saved: outcome.saved,
          skipped: outcome.skipped,
          redacted: outcome.redacted,
          reason: outcome.reason ?? null,
        }, outcome.ok ? 'info' : 'warn')
      },
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
