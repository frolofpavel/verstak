import { ipcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { Chats } from '../storage/chats'
import type { ChatSessions, ChatKind } from '../storage/chat-sessions'
import { forgetMemorizedChat } from './ai'
import { summarizeAndSaveSession } from '../ai/session-summary'

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
  }) => sessions.create(projectPath, opts))
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
        console.error('[chats] summarizeAndSaveSession failed, proceeding with deletion:', err instanceof Error ? err.message : err)
      }
    }
    sessions.remove(id)
    // Clear memory-injection cache so if a new session reuses this id as key,
    // it still receives a fresh memory injection.
    forgetMemorizedChat(String(id))
  })

  // Messages
  ipcMain.handle('chats:list', (_e, sessionId: number) => chats.listBySession(sessionId))
  ipcMain.handle('chats:append', (_e, sessionId: number, projectPath: string, role: 'user' | 'assistant', content: string) => {
    chats.appendToSession(sessionId, projectPath, role, content)
  })
  // F (ось 3): «Откатить задачу» — граница (макс. id) на момент чекпоинта + truncate к ней.
  ipcMain.handle('chats:max-message-id', (_e, sessionId: number) => chats.maxMessageId(sessionId))
  ipcMain.handle('chats:truncate-after', (_e, sessionId: number, afterMessageId: number) => chats.truncateAfter(sessionId, afterMessageId))
}
