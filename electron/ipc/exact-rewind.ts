import type { UndoStack, UndoEntry } from '../storage/undo'
import { assessRewind, type RewindCoverage } from '../storage/rewind-coverage'

/**
 * Exact Rewind — срез 2.0.11-F. ФИЧА ЗА ФЛАГОМ (по умолчанию выключена).
 *
 * Точный откат агентной сессии: сначала честное превью (preflight) — что откатится и
 * насколько полно; затем сам откат в транзакции с бэкапами (для unrevert). Здесь — PREFLIGHT:
 * только чтение, ни одной записи на диск/в БД.
 */

export type RewindAction = 'restore' | 'delete'

export interface PreflightFile {
  filePath: string
  /** restore — вернуть прежнее содержимое; delete — файл создавался, удалить. */
  action: RewindAction
  /** Файл переписан кем-то ПОСЛЕ нашей записи (текущий хеш != after_hash) — откат затрёт чужое. */
  stale: boolean
}

export interface PreflightReport {
  coverage: RewindCoverage
  files: PreflightFile[]
}

export interface PreflightDeps {
  /** Хеш ТЕКУЩЕГО содержимого файла (в проде sha256; null — файла нет). Инъекция — чтобы
   *  preflight оставался чистым и тестируемым, а fs-доступ жил в вызывающем. */
  hashFile: (filePath: string) => Promise<string | null>
  /** Прогон менял файлы МИМО undo-стека (run_command/CLI) — из знания о прогоне (E). */
  hasBypassWriters: boolean
}

/**
 * Превью отката записей с id > checkpointId. НЕ трогает стек и диск — только читает.
 *
 * Единица показа — файл: у файла берётся ПОСЛЕДНЯЯ запись (assessRewind внутри сам
 * сворачивает по max id). action/stale считаются по ней.
 */
export async function preflightRewind(
  stack: UndoStack,
  projectPath: string,
  checkpointId: number,
  deps: PreflightDeps,
): Promise<PreflightReport> {
  const toRevert = stack.list(projectPath).filter(e => e.id > checkpointId)

  const coverage = await assessCoverage(toRevert, deps)

  // Последняя запись каждого файла — она определяет, что делать при откате.
  const latestByFile = new Map<string, UndoEntry>()
  for (const e of toRevert) {
    const prev = latestByFile.get(e.filePath)
    if (!prev || e.id > prev.id) latestByFile.set(e.filePath, e)
  }

  const files: PreflightFile[] = []
  for (const [filePath, e] of latestByFile) {
    const current = await deps.hashFile(filePath)
    files.push({
      filePath,
      // beforeContent null → файл создавался этой правкой → при откате удаляется.
      action: e.beforeContent === null ? 'delete' : 'restore',
      stale: e.runId != null && current !== e.afterHash,
    })
  }

  return { coverage, files }
}

/** assessRewind поверх реальных записей + инъекция хешей. */
async function assessCoverage(entries: UndoEntry[], deps: PreflightDeps): Promise<RewindCoverage> {
  // Хеши считаем один раз, кешируем по файлу (assessRewind зовёт currentHash синхронно).
  const cache = new Map<string, string | null>()
  for (const e of entries) {
    if (!cache.has(e.filePath)) cache.set(e.filePath, await deps.hashFile(e.filePath))
  }
  return assessRewind(entries, {
    currentHash: p => cache.get(p) ?? null,
    hasBypassWriters: deps.hasBypassWriters,
  })
}
