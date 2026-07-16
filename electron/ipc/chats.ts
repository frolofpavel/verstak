import { ipcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { Chats } from '../storage/chats'
import type { ChatSessions, ChatKind } from '../storage/chat-sessions'
import { forgetMemorizedChat } from './ai'
import { summarizeAndSaveSession } from '../ai/session-summary'
import { logRuntime, logRuntimeError } from '../runtime-log'
import { isChatSubscriptionBinding, type ChatSubscriptionBindingDTO } from '../../shared/contracts/subscription'
import { isKnownProviderId } from '../../shared/contracts/provider'

export function registerChatsIpc(chats: Chats, sessions: ChatSessions, db: Database): void {
  // Sessions
  ipcMain.handle('chat-sessions:list', (_e, projectPath: string) => sessions.list(projectPath))
  /** Review sub-chats для родительского — для рендера pills в Timeline. */
  ipcMain.handle('chat-sessions:list-reviews', (_e, parentChatId: number) => sessions.listReviews(parentChatId))
  ipcMain.handle('chat-sessions:get-or-create-help', () => sessions.getOrCreateHelp())
  ipcMain.handle('chat-sessions:create', (_e, projectPath: string, opts?: {
    title?: string
    providerId?: string | null
    model?: string | null
    kind?: ChatKind
    parentChatId?: number | null
  }) => {
    const session = sessions.create(projectPath, opts)
    logRuntime('chat_session.create', {
      sessionId: session.id,
      projectPath,
      kind: opts?.kind ?? 'chat',
      parentChatId: opts?.parentChatId ?? null,
      providerId: opts?.providerId ?? null,
      model: opts?.model ?? null
    })
    return session
  })
  ipcMain.handle('chat-sessions:fork', (_e, sourceId: number, opts?: { uptoMessageId?: number; title?: string }) =>
    sessions.fork(sourceId, opts)
  )
  ipcMain.handle('chat-sessions:rename', (_e, id: number, title: string) => sessions.rename(id, title))
  ipcMain.handle('chat-sessions:set-model', (_e, id: number, providerId: string | null, model: string | null) =>
    sessions.setProviderModel(id, providerId, model)
  )
  ipcMain.handle('chat-sessions:remove', (_e, id: number) => {
    // Читаем сессию и сообщения перед удалением, чтобы сохранить резюме в памяти
    const session = sessions.get(id)
    if (session) {
      const messages = chats.listBySession(id)
      try {
        summarizeAndSaveSession(db, id, session.projectPath, messages)
      } catch (err) {
        logRuntimeError('chat_session.summary_before_remove.fail', err, { sessionId: id, projectPath: session.projectPath })
        console.error('[chats] summarizeAndSaveSession failed, proceeding with deletion:', err instanceof Error ? err.message : err)
      }
    }
    sessions.remove(id)
    logRuntime('chat_session.remove', { sessionId: id, hadSession: !!session })
    // Clear memory-injection cache so if a new session reuses this id as key,
    // it still receives a fresh memory injection.
    forgetMemorizedChat(String(id))
  })

  // Messages
  ipcMain.handle('chats:list', (_e, sessionId: number) => chats.listBySession(sessionId))
  ipcMain.handle('chats:list-window', (_e, sessionId: number, opts?: { beforeId?: number | null; limit?: number }) => chats.listWindowBySession(sessionId, opts))
  ipcMain.handle('chats:append', (_e, sessionId: number, projectPath: string, role: 'user' | 'assistant', content: string, meta?: { appliedSkills?: Array<{ id: string; name?: string; icon?: string; description?: string }> }) => {
    const message = chats.appendToSession(sessionId, projectPath, role, content, meta)
    logRuntime('chat_message.append', {
      sessionId,
      messageId: message.id,
      projectPath,
      role,
      contentLength: content.length,
      appliedSkillsCount: message.appliedSkills.length
    })
    return message
  })
  ipcMain.handle('chats:update-message', (_e, messageId: number, content: string) => {
    const updated = chats.updateMessage(messageId, content)
    logRuntime('chat_message.update', {
      messageId,
      updated,
      contentLength: content.length
    })
    return updated
  })
  ipcMain.handle('chats:update-thinking', (_e, messageId: number, thinking: string) => {
    const updated = chats.updateThinking(messageId, thinking)
    logRuntime('chat_message.update_thinking', {
      messageId,
      updated,
      thinkingLength: thinking.length
    })
    return updated
  })
  // F (ось 3): «Откатить задачу» — граница (макс. id) на момент чекпоинта + truncate к ней.
  // 2.0.8-B: привязка чата к подписочному аккаунту (get/set). Вход валидируем — renderer
  // не доверяем. pin — свойство КОНКРЕТНОГО чата, не глобальный флаг аккаунта.
  ipcMain.handle('chats:get-subscription-binding', (_e, chatId: number): ChatSubscriptionBindingDTO | null => {
    const b = sessions.getSubscriptionBinding(chatId)
    if (!b) return null
    const providerId = sessions.get(chatId)?.providerId
    if (!isKnownProviderId(providerId)) return null
    return { chatId, providerId, mode: b.mode, accountId: b.accountId }
  })
  ipcMain.handle('chats:set-subscription-binding', (_e, binding: unknown): { ok: boolean; error?: string } => {
    if (!isChatSubscriptionBinding(binding)) return { ok: false, error: 'invalid binding' }
    sessions.setSubscriptionBinding(binding.chatId, binding.mode, binding.accountId)
    return { ok: true }
  })

  ipcMain.handle('chats:max-message-id', (_e, sessionId: number) => chats.maxMessageId(sessionId))
  ipcMain.handle('chats:truncate-after', (_e, sessionId: number, afterMessageId: number) => chats.truncateAfter(sessionId, afterMessageId))
}
