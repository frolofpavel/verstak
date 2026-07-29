import { ipcMain } from 'electron'
import { readFile, writeFile as fsWriteFile, unlink, stat } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
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
 * Renderer шлёт chatId/checkpointId + токен бэкапа — не пути и не содержимое. Реальный fs
 * здесь: чтение/запись только через safeRealJoin (anti symlink-escape, как весь undo-путь).
 *
 * СОДЕРЖИМОЕ ФАЙЛОВ ГРАНИЦУ MAIN НЕ ПЕРЕСЕКАЕТ (SEC-SECRET-04, той же природы, что
 * SEC-SECRET-03 у undo:list). Стек отката хранит СЫРОЕ содержимое — с 29.07 путь записи
 * читает файл мимо secret-scanner, иначе откат уничтожал секрет. Раньше execute отдавал
 * `backups` (снимок всех откатываемых файлов) в renderer, а unrevert принимал этот Record
 * ОБРАТНО — то есть renderer мог записать произвольное содержимое в произвольный файл
 * проекта в обход подтверждений. Renderer содержимое никому не показывает (превью — это
 * счётчики и пути), поэтому выбран ОТКАЗ, а не маска: бэкапы живут здесь, в main, под
 * одноразовым токеном; renderer ссылается токеном.
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

  // Бэкапы последнего execute. ОДИН слот, не реестр: UI-сценарий модально-последовательный
  // (execute → сразу unrevert или никогда), новый execute законно обесценивает прежний
  // токен. Токен одноразовый: успешный unrevert чистит слот; сбойный оставляет — retry
  // тем же токеном возможен. Содержимое ЖИВОЕ и обязано таким остаться: это единственный
  // источник «вернуть как было» (контрольный пин SEC-SECRET-04 сторожит ровно это).
  let stored: { token: string; backups: RewindBackups } | null = null

  /** Реальный fs поверх проекта: пути только через safeRealJoin. */
  const fsFor = (projectRoot: string): RewindFsDeps & { readCurrent: (p: string) => Promise<string | null> } => ({
    readCurrent: async (filePath) => {
      const abs = await safeRealJoin(projectRoot, filePath)
      try {
        return await readFile(abs, 'utf8')
      } catch (err) {
        // ENOENT = файла НЕТ → null (бэкап null корректен: unrevert его удалит, чего мы и
        // хотим). ЛЮБАЯ другая ошибка (EBUSY/EACCES — файл залочен) — НЕ глотаем: файл ЕСТЬ,
        // но не прочитан. Иначе backup=null и unrevert удалил бы реальный файл (ре-ревью F).
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw err
      }
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
    // Бэкапы остаются в main; наружу — только одноразовый токен (SEC-SECRET-04).
    const token = randomUUID()
    stored = { token, backups: result.backups }
    return {
      ok: result.failed.length === 0,
      restored: result.restored,
      failed: result.failed,
      backupToken: token,
      coverage: report.coverage,
    }
  })

  ipcMain.handle('exact-rewind:unrevert', async (_e, backupToken: string) => {
    if (!enabled()) return { disabled: true }
    const root = deps.getProjectRoot()
    if (!root) return { ok: false, error: 'нет проекта' }
    if (!stored || stored.token !== backupToken) {
      return { ok: false, error: 'бэкап отката не найден: токен устарел или уже использован' }
    }
    // unrevert best-effort: что смог — вернул; сбойные файлы приходят текстом ошибки,
    // а не непойманным исключением в renderer (Windows-smoke: readonly-файл).
    try {
      await unrevert(stored.backups, fsFor(root))
      stored = null // токен одноразовый: вернули — ссылка погашена
      return { ok: true }
    } catch (err) {
      // Слот НЕ чистим: частичный сбой (залоченный файл) лечится повторной попыткой
      // тем же токеном, а бэкап — единственное, чем возвращать.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
