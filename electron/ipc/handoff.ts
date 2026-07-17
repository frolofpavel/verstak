import { app, ipcMain, dialog, type BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
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

/** Результат безопасного экспорта. Отмена — отдельная ветка, НЕ ошибка (карточка C). */
export type TranscriptExportResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string }

export interface HandoffIpcDeps {
  /** Корни известных проектов — для нормализации путей в экспорте (приватность). */
  getKnownRoots?: () => string[]
  /** Домашняя папка — её вхождения в экспорте → `~`. По умолчанию os.homedir(). */
  getHomeDir?: () => string
  /** Родительское окно для нативного save-диалога (модальность). null допустим. */
  getWindow?: () => BrowserWindow | null
}

/**
 * Тонкий IPC поверх чистого generateHandoff: по sessionId читает сообщения и
 * отдаёт markdown-handoff. Сами сообщения в storage плоские (role + content),
 * поэтому файлы извлекаются через regex-фоллбэк внутри generateHandoff.
 */
export function registerHandoffIpc(chats: Chats, sessions: ChatSessions, agentRuns?: AgentRuns, deps: HandoffIpcDeps = {}): void {
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

  /** Транскрипт сессии в Markdown с нормализацией приватности (секреты + пути). */
  function buildSafeTranscript(sessionId: number): { markdown: string; slug: string } {
    const session = sessions.get(sessionId)
    const stored = chats.listBySession(sessionId)
    const markdown = buildTranscriptMarkdown(
      stored.map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
      {
        title: session?.title,
        provider: session?.providerId ?? undefined,
        exportedAt: Date.now(),
        // 2.0.11-C: нормализуем пути — экспорт уходит наружу, имя пользователя утекать не должно.
        pathContext: {
          homeDir: deps.getHomeDir?.() ?? homedir(),
          projectRoots: deps.getKnownRoots?.() ?? [],
        },
      }
    )
    return { markdown, slug: sanitizeHandoffFilePart(session?.title) }
  }

  // Legacy: авто-запись в Downloads (без диалога). Оставлен для существующих вызовов; путь
  // приватности теперь тоже чистит (buildSafeTranscript).
  ipcMain.handle('transcript:export-to-downloads', (_e, sessionId: number): HandoffSaveResult => {
    try {
      const { markdown, slug } = buildSafeTranscript(sessionId)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filePath = join(app.getPath('downloads'), `verstak-транскрипт-${sessionId}-${slug}-${stamp}.md`)
      writeFileSync(filePath, markdown, 'utf8')
      return { ok: true, path: filePath, markdown }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Безопасный экспорт транскрипта — срез 2.0.11-C.
   *
   * Renderer шлёт ТОЛЬКО chatId: путь записи выбирает пользователь в нативном save-диалоге
   * (main). Так renderer не может записать в произвольное место. Отмена диалога — отдельная
   * ветка `cancelled`, а не ошибка: человек передумал, это не сбой.
   */
  ipcMain.handle('transcript:export', async (_e, sessionId: number): Promise<TranscriptExportResult> => {
    try {
      const { markdown, slug } = buildSafeTranscript(sessionId)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const win = deps.getWindow?.() ?? null
      const options = {
        title: 'Сохранить транскрипт',
        defaultPath: join(app.getPath('downloads'), `verstak-транскрипт-${sessionId}-${slug}-${stamp}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Все файлы', extensions: ['*'] }],
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
      writeFileSync(result.filePath, markdown, 'utf8')
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
