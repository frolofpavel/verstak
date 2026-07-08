import { app, ipcMain } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { Chats } from '../storage/chats'
import type { ChatSessions } from '../storage/chat-sessions'
import { generateHandoff } from '../ai/handoff'
import { buildHandoffFileName, sanitizeHandoffFilePart } from '../ai/handoff-file'
import { buildTranscriptMarkdown } from '../ai/transcript'
import type { ChatMessage } from '../ai/types'
import type { AgentRuns } from '../storage/agent-runs'

export type HandoffSaveResult =
  | { ok: true; path: string; markdown: string }
  | { ok: false; error: string }

/**
 * Тонкий IPC поверх чистого generateHandoff: по sessionId читает сообщения и
 * отдаёт markdown-handoff. Сами сообщения в storage плоские (role + content),
 * поэтому файлы извлекаются через regex-фоллбэк внутри generateHandoff.
 */
export function registerHandoffIpc(chats: Chats, sessions: ChatSessions, agentRuns?: AgentRuns): void {
  function buildMarkdown(sessionId: number, parentId?: string | null): { markdown: string; title?: string | null } {
    const session = sessions.get(sessionId)
    const stored = chats.listBySession(sessionId)
    const messages: ChatMessage[] = stored.map(m => ({ role: m.role, content: m.content }))
    const stats = agentRuns?.sessionStats(sessionId)
    const recentRuns = session && agentRuns
      ? agentRuns.list(session.projectPath, { limit: 20 }).filter(r => r.chatId === sessionId).slice(0, 3)
      : []
    const recentEvents = agentRuns && recentRuns.length > 0
      ? recentRuns.flatMap(r => agentRuns.getEvents(r.runId).slice(-4)).slice(-8)
      : []
    return {
      markdown: generateHandoff(messages, {
        title: session?.title,
        provider: session?.providerId ?? undefined,
        parentId: parentId ?? null,
        runSummary: stats ? {
          runs: stats.runs,
          toolCount: stats.toolCount,
          filesCount: stats.filesCount,
          agentsCount: stats.agentsCount,
          durationMs: stats.durationMs,
          recentRuns: recentRuns.map(r => ({
            title: r.title,
            status: r.status,
            provider: r.providerId,
            model: r.model,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
            error: r.error,
            toolCount: r.toolCount,
            filesCount: r.filesCount,
            agentsCount: r.agentsCount,
          })),
          recentEvents: recentEvents.map(e => ({
            label: e.label,
            detail: e.detail,
            status: e.status,
            createdAt: e.createdAt,
          })),
        } : null,
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

  // Полный дословный транскрипт сессии в Markdown (в отличие от сжатого handoff) —
  // для code-review / багрепорта / архива. scanText внутри buildTranscriptMarkdown.
  ipcMain.handle('transcript:export-to-downloads', (_e, sessionId: number): HandoffSaveResult => {
    try {
      const session = sessions.get(sessionId)
      const stored = chats.listBySession(sessionId)
      const markdown = buildTranscriptMarkdown(
        stored.map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
        { title: session?.title, provider: session?.providerId ?? undefined, exportedAt: Date.now() }
      )
      const slug = sanitizeHandoffFilePart(session?.title)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filePath = join(app.getPath('downloads'), `verstak-транскрипт-${sessionId}-${slug}-${stamp}.md`)
      writeFileSync(filePath, markdown, 'utf8')
      return { ok: true, path: filePath, markdown }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
