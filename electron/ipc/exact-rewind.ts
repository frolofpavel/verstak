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

// ─── Сам откат в транзакции с бэкапами + unrevert (2.0.11-F, за флагом) ───

export interface RewindPlanItem {
  filePath: string
  action: RewindAction
  /** Прежнее содержимое (для restore). null — файл создавался (action delete). */
  beforeContent: string | null
}

/** Бэкап: путь → содержимое ДО отката (null — файла не было). Для unrevert. */
export type RewindBackups = Record<string, string | null>

export interface RewindExecResult {
  restored: string[]
  failed: Array<{ filePath: string; reason: string }>
  /** Снимок состояния ДО отката — для unrevert. */
  backups: RewindBackups
}

export interface RewindFsDeps {
  /** Текущее содержимое файла (null — файла нет). */
  readCurrent: (filePath: string) => Promise<string | null>
  writeFile: (filePath: string, content: string) => Promise<void>
  deleteFile: (filePath: string) => Promise<void>
}

/**
 * Применить откат. Бэкап ТЕКУЩЕГО состояния снимается ДО первой записи — иначе частичный
 * сбой оставил бы файлы в состоянии, которое unrevert'у нечем вернуть. backups → unrevert.
 */
export async function executeRewind(items: RewindPlanItem[], fs: RewindFsDeps): Promise<RewindExecResult> {
  // 1. Сначала снимаем ВСЕ бэкапы (транзакционность: до любой мутации).
  const backups: RewindBackups = {}
  for (const it of items) backups[it.filePath] = await fs.readCurrent(it.filePath)

  // 2. Применяем откат. Сбой одного файла не роняет остальные — копим в failed.
  const restored: string[] = []
  const failed: Array<{ filePath: string; reason: string }> = []
  for (const it of items) {
    try {
      if (it.action === 'delete') await fs.deleteFile(it.filePath)
      else await fs.writeFile(it.filePath, it.beforeContent ?? '')
      restored.push(it.filePath)
    } catch (err) {
      failed.push({ filePath: it.filePath, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { restored, failed, backups }
}

/** Отменить откат: вернуть файлы к состоянию из бэкапов (null → файла не было → удалить). */
export async function unrevert(backups: RewindBackups, fs: RewindFsDeps): Promise<void> {
  for (const [filePath, content] of Object.entries(backups)) {
    if (content === null) await fs.deleteFile(filePath)
    else await fs.writeFile(filePath, content)
  }
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
