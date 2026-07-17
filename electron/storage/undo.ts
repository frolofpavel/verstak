import type { Database } from 'better-sqlite3'
import { createHash } from 'crypto'
import { createFloorTracker } from './undo-floors'

/** КТО сделал правку — провенанс отката (2.0.11-E). Всё опционально: запись без контекста
 *  (legacy, run_command мимо loop, CLI-бинарь) остаётся валидной «непротрассированной». */
export interface UndoProvenance {
  runId?: string | null
  chatId?: number | null
  messageId?: number | null
}

export interface UndoEntry {
  id: number
  filePath: string
  beforeContent: string | null
  afterContent: string | null
  createdAt: number
  // Провенанс (2.0.11-E). null → запись непротрассирована (rewindCoverage не даст complete).
  runId: string | null
  chatId: number | null
  messageId: number | null
  /** Хеши содержимого. beforeHash null — файл создавался (before отсутствовал). */
  beforeHash: string | null
  afterHash: string | null
}

export interface UndoStack {
  push: (projectPath: string, filePath: string, before: string | null, after: string, provenance?: UndoProvenance) => UndoEntry
  list: (projectPath: string) => UndoEntry[]
  pop: (id: number) => UndoEntry | null
  clear: (projectPath: string) => number
  count: (projectPath: string) => number
  /** Защитить от prune все записи с id > floorId (активный чекпоинт). См. push. */
  protectFrom: (projectPath: string, floorId: number) => void
  /** Снять защиту чекпоинта (после отката/очистки). floorId — конкретный чекпоинт;
   *  без него — снять ВСЕ floor'ы проекта (undo:clear). */
  clearProtection: (projectPath: string, floorId?: number) => void
}

const MAX_PER_PROJECT = 50

const hashOf = (s: string | null): string | null => (s == null ? null : createHash('sha256').update(s).digest('hex'))

interface Row {
  id: number
  filePath: string
  beforeContent: string | null
  afterContent: string | null
  createdAt: number
  runId: string | null
  chatId: number | null
  messageId: number | null
  beforeHash: string | null
  afterHash: string | null
}

/** Общий SELECT-список с провенансом — один источник для list/pop. */
const SELECT_COLS = `id, file_path as filePath, before_content as beforeContent, after_content as afterContent,
  created_at as createdAt, run_id as runId, chat_id as chatId, message_id as messageId,
  before_hash as beforeHash, after_hash as afterHash`

export function createUndoStack(db: Database): UndoStack {
  // Защищённые floor'ы чекпоинтов: записи с id > floor НЕ пруньются (review fix #4).
  // Без этого сессия с >50 write'ами после чекпоинта теряла ранние undo-записи →
  // revertToCheckpoint молча откатывал лишь последние 50 (частичный откат без сигнала),
  // подрывая гарантию «откат любой агентной сессии одной кнопкой» (CLAUDE.md §1).
  // Мульти-чат: несколько чекпоинтов в одном проекте → защищаем по МИНИМУМУ из
  // активных floor'ов, чтобы регион ни одного чата не оголился (F3, ревью 23.06).
  // Durability (finding 1, ревью 23.06): floor'ы персистятся в undo_floors и
  // гидратируются при старте — иначе после краха защита терялась и prune съедал
  // пост-чекпоинт записи (неполный откат восстановленной сессии).
  const floors = createFloorTracker()
  for (const row of db.prepare('SELECT project_path as projectPath, floor_id as floorId FROM undo_floors').all() as Array<{ projectPath: string; floorId: number }>) {
    floors.add(row.projectPath, row.floorId)
  }
  return {
    push(projectPath, filePath, before, after, provenance) {
      const now = Date.now()
      const runId = provenance?.runId ?? null
      const chatId = provenance?.chatId ?? null
      const messageId = provenance?.messageId ?? null
      const beforeHash = hashOf(before)
      const afterHash = hashOf(after)
      const info = db.prepare(
        `INSERT INTO file_undo (project_path, file_path, before_content, after_content, created_at,
           run_id, chat_id, message_id, before_hash, after_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(projectPath, filePath, before, after, now, runId, chatId, messageId, beforeHash, afterHash)
      // Prune за пределами MAX_PER_PROJECT, НО никогда не трогаем записи новее
      // активного чекпоинта (id > floor): иначе откат к чекпоинту был бы неполным.
      // floor = минимум активных чекпоинтов проекта (или NO_FLOOR если нет).
      const floor = floors.effective(projectPath)
      db.prepare(`
        DELETE FROM file_undo
        WHERE project_path = ?
          AND id NOT IN (SELECT id FROM file_undo WHERE project_path = ? ORDER BY id DESC LIMIT ?)
          AND id <= ?
      `).run(projectPath, projectPath, MAX_PER_PROJECT, floor)
      return { id: Number(info.lastInsertRowid), filePath, beforeContent: before, afterContent: after, createdAt: now, runId, chatId, messageId, beforeHash, afterHash }
    },
    protectFrom(projectPath, floorId) {
      // DB-first (ревью 23.06 #3): сперва персист, потом in-memory. При сбое INSERT
      // исключение пробрасывается ДО floors.add → нет расхождения память↔БД (раньше
      // floors.add шёл первым: при сбое INSERT память «знала» floor, которого нет в БД).
      db.prepare('INSERT INTO undo_floors (project_path, floor_id) VALUES (?, ?)').run(projectPath, floorId)
      floors.add(projectPath, floorId)
    },
    clearProtection(projectPath, floorId) {
      // DB-first: удаляем из БД, потом из памяти. При сбое DELETE память не «забудет»
      // floor раньше БД (иначе после рестарта floor воскрес бы из недоудалённой БД).
      if (floorId === undefined) {
        db.prepare('DELETE FROM undo_floors WHERE project_path = ?').run(projectPath)
      } else {
        // rowid+LIMIT 1: убрать ровно ОДИН row (дубликат floor от двух чатов на
        // одном id — например оба чекпоинтят на пустом стеке id=0 — не схлопнуть).
        db.prepare('DELETE FROM undo_floors WHERE rowid = (SELECT rowid FROM undo_floors WHERE project_path = ? AND floor_id = ? LIMIT 1)').run(projectPath, floorId)
      }
      floors.remove(projectPath, floorId)
    },
    list(projectPath) {
      const rows = db.prepare(`
        SELECT ${SELECT_COLS}
        FROM file_undo WHERE project_path = ?
        ORDER BY id DESC
      `).all(projectPath) as Row[]
      return rows
    },
    pop(id) {
      const row = db.prepare(
        `SELECT ${SELECT_COLS} FROM file_undo WHERE id = ?`
      ).get(id) as Row | undefined
      if (!row) return null
      db.prepare('DELETE FROM file_undo WHERE id = ?').run(id)
      return row
    },
    clear(projectPath) {
      const info = db.prepare('DELETE FROM file_undo WHERE project_path = ?').run(projectPath)
      // Чистим и floor'ы проекта — иначе остались бы сироты на удалённые записи.
      // DB-first, потом память (ревью 23.06 #3).
      db.prepare('DELETE FROM undo_floors WHERE project_path = ?').run(projectPath)
      floors.remove(projectPath)
      return info.changes
    },
    count(projectPath) {
      const row = db.prepare('SELECT COUNT(*) as c FROM file_undo WHERE project_path = ?').get(projectPath) as { c: number }
      return row.c
    }
  }
}
