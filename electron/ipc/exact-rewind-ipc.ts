import { ipcMain } from 'electron'
import { readFile, writeFile as fsWriteFile, unlink, stat } from 'fs/promises'
import { createHash } from 'crypto'
import type { UndoStack } from '../storage/undo'
import { safeRealJoin } from '../ai/path-policy'
import {
  isExactRewindEnabled,
  preflightRewind,
  executeRewind,
  unrevert,
  type RewindBackups,
  type RewindFsDeps,
} from './exact-rewind'

/**
 * IPC-проводка Exact Rewind — срез 2.0.11-F. ЗА ФЛАГОМ (по умолчанию выключено).
 *
 * КАЖДЫЙ путь (preflight/execute/unrevert) сначала проверяет флаг: выключено → { disabled }
 * и НИ ОДНОЙ операции. Фича собрана, но спит до ручного включения и Windows-smoke Павлом.
 *
 * Renderer шлёт chatId/checkpointId + backups — не произвольные пути. Реальный fs здесь:
 * чтение/запись только через safeRealJoin (anti symlink-escape, как весь undo-путь).
 */

export interface ExactRewindIpcDeps {
  undoStack: UndoStack
  getKey: (key: string) => string | null
  getProjectRoot: () => string | null
  /** Прогон менял файлы мимо undo-стека (run_command/CLI) — из знания о прогоне. */
  hasBypassWriters: (checkpointId: number) => boolean
}

export function registerExactRewindIpc(deps: ExactRewindIpcDeps): void {
  const enabled = () => isExactRewindEnabled(deps.getKey)

  /** Реальный fs поверх проекта: пути только через safeRealJoin. */
  const fsFor = (projectRoot: string): RewindFsDeps & { readCurrent: (p: string) => Promise<string | null> } => ({
    readCurrent: async (filePath) => {
      try {
        const abs = await safeRealJoin(projectRoot, filePath)
        return await readFile(abs, 'utf8')
      } catch { return null } // файла нет / недоступен → null
    },
    writeFile: async (filePath, content) => {
      const abs = await safeRealJoin(projectRoot, filePath)
      await fsWriteFile(abs, content, 'utf8')
    },
    deleteFile: async (filePath) => {
      const abs = await safeRealJoin(projectRoot, filePath)
      try { await stat(abs); await unlink(abs) } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
    },
  })

  const hashFileVia = (fs: RewindFsDeps) => async (filePath: string): Promise<string | null> => {
    const content = await fs.readCurrent(filePath)
    return content == null ? null : createHash('sha256').update(content).digest('hex')
  }

  ipcMain.handle('exact-rewind:preflight', async (_e, checkpointId: number) => {
    if (!enabled()) return { disabled: true }
    const root = deps.getProjectRoot()
    if (!root) return { disabled: false, coverage: { level: 'none', tracedFiles: 0, hasUntracedWriters: false, staleFiles: 0 }, files: [] }
    const fs = fsFor(root)
    return preflightRewind(deps.undoStack, root, checkpointId, {
      hashFile: hashFileVia(fs),
      hasBypassWriters: deps.hasBypassWriters(checkpointId),
    })
  })

  ipcMain.handle('exact-rewind:execute', async (_e, checkpointId: number) => {
    if (!enabled()) return { disabled: true }
    const root = deps.getProjectRoot()
    if (!root) return { ok: false, error: 'нет проекта' }
    const fs = fsFor(root)
    // Строим план из превью (action/beforeContent по последней записи файла), затем откат.
    const report = await preflightRewind(deps.undoStack, root, checkpointId, {
      hashFile: hashFileVia(fs),
      hasBypassWriters: deps.hasBypassWriters(checkpointId),
    })
    // beforeContent для восстановления — из ПЕРВОЙ записи файла (min id): это состояние на
    // момент чекпоинта. list() отдаёт DESC, поэтому берём запись с минимальным id, а не
    // первую встреченную.
    const firstByFile = new Map<string, { id: number; beforeContent: string | null }>()
    for (const e of deps.undoStack.list(root).filter(e => e.id > checkpointId)) {
      const prev = firstByFile.get(e.filePath)
      if (!prev || e.id < prev.id) firstByFile.set(e.filePath, { id: e.id, beforeContent: e.beforeContent })
    }
    const items = report.files.map(f => ({
      filePath: f.filePath,
      action: f.action,
      beforeContent: firstByFile.get(f.filePath)?.beforeContent ?? null,
    }))
    const result = await executeRewind(items, fs)
    return { ok: result.failed.length === 0, ...result, coverage: report.coverage }
  })

  ipcMain.handle('exact-rewind:unrevert', async (_e, backups: RewindBackups) => {
    if (!enabled()) return { disabled: true }
    const root = deps.getProjectRoot()
    if (!root) return { ok: false, error: 'нет проекта' }
    await unrevert(backups, fsFor(root))
    return { ok: true }
  })
}
