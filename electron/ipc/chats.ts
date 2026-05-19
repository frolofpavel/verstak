import { ipcMain } from 'electron'
import type { Chats } from '../storage/chats'
import type { ChatSessions } from '../storage/chat-sessions'

export function registerChatsIpc(chats: Chats, sessions: ChatSessions): void {
  // Sessions
  ipcMain.handle('chat-sessions:list', (_e, projectPath: string) => sessions.list(projectPath))
  ipcMain.handle('chat-sessions:create', (_e, projectPath: string, opts?: { title?: string; providerId?: string | null; model?: string | null }) =>
    sessions.create(projectPath, opts)
  )
  ipcMain.handle('chat-sessions:rename', (_e, id: number, title: string) => sessions.rename(id, title))
  ipcMain.handle('chat-sessions:set-model', (_e, id: number, providerId: string | null, model: string | null) =>
    sessions.setProviderModel(id, providerId, model)
  )
  ipcMain.handle('chat-sessions:remove', (_e, id: number) => sessions.remove(id))

  // Messages
  ipcMain.handle('chats:list', (_e, sessionId: number) => chats.listBySession(sessionId))
  ipcMain.handle('chats:append', (_e, sessionId: number, projectPath: string, role: 'user' | 'assistant', content: string) => {
    chats.appendToSession(sessionId, projectPath, role, content)
  })
}
