import { app, ipcMain } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { Chats } from '../storage/chats'
import type { ChatSessions } from '../storage/chat-sessions'
import { generateHandoff } from '../ai/handoff'
import { buildHandoffFileName } from '../ai/handoff-file'
import type { ChatMessage } from '../ai/types'

export type HandoffSaveResult =
  | { ok: true; path: string; markdown: string }
  | { ok: false; error: string }

/**
 * Тонкий IPC поверх чистого generateHandoff: по sessionId читает сообщения и
 * отдаёт markdown-handoff. Сами сообщения в storage плоские (role + content),
 * поэтому файлы извлекаются через regex-фоллбэк внутри generateHandoff.
 */
export function registerHandoffIpc(chats: Chats, sessions: ChatSessions): void {
  function buildMarkdown(sessionId: number, parentId?: string | null): { markdown: string; title?: string | null } {
    const session = sessions.get(sessionId)
    const stored = chats.listBySession(sessionId)
    const messages: ChatMessage[] = stored.map(m => ({ role: m.role, content: m.content }))
    return {
      markdown: generateHandoff(messages, {
        title: session?.title,
        provider: session?.providerId ?? undefined,
        parentId: parentId ?? null
      }),
      title: session?.title
    }
  }

  ipcMain.handle('handoff:generate', (_e, sessionId: number, parentId?: string | null) => {
    return buildMarkdown(sessionId, parentId).markdown
  })

  ipcMain.handle('handoff:save-to-downloads', (_e, sessionId: number, parentId?: string | null): HandoffSaveResult => {
    try {
      const handoff = buildMarkdown(sessionId, parentId)
      const filename = buildHandoffFileName({ sessionId, title: handoff.title })
      const filePath = join(app.getPath('downloads'), filename)
      writeFileSync(filePath, handoff.markdown, 'utf8')
      return { ok: true, path: filePath, markdown: handoff.markdown }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}
