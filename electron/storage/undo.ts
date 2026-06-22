import type { Database } from 'better-sqlite3'

export interface UndoEntry {
  id: number
  filePath: string
  beforeContent: string | null
  afterContent: string | null
  createdAt: number
}

export interface UndoStack {
  push: (projectPath: string, filePath: string, before: string | null, after: string) => UndoEntry
  list: (projectPath: string) => UndoEntry[]
  pop: (id: number) => UndoEntry | null
  clear: (projectPath: string) => number
  count: (projectPath: string) => number
  /** Защитить от prune все записи с id > floorId (активный чекпоинт). См. push. */
  protectFrom: (projectPath: string, floorId: number) => void
  /** Снять защиту чекпоинта (после отката/очистки). */
  clearProtection: (projectPath: string) => void
}

const MAX_PER_PROJECT = 50
const NO_FLOOR = Number.MAX_SAFE_INTEGER

interface Row {
  id: number
  filePath: string
  beforeContent: string | null
  afterContent: string | null
  createdAt: number
}

export function createUndoStack(db: Database): UndoStack {
  // Защищённый floor на проект: записи с id > floor НЕ пруньются (review fix #4).
  // Без него сессия с >50 write'ами после чекпоинта теряла ранние undo-записи →
  // revertToCheckpoint молча откатывал лишь последние 50 (частичный откат без сигнала),
  // подрывая гарантию «откат любой агентной сессии одной кнопкой» (CLAUDE.md §1).
  const floors = new Map<string, number>()
  return {
    push(projectPath, filePath, before, after) {
      const now = Date.now()
      const info = db.prepare(
        'INSERT INTO file_undo (project_path, file_path, before_content, after_content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(projectPath, filePath, before, after, now)
      // Prune за пределами MAX_PER_PROJECT, НО никогда не трогаем записи новее
      // активного чекпоинта (id > floor): иначе откат к чекпоинту был бы неполным.
      const floor = floors.get(projectPath) ?? NO_FLOOR
      db.prepare(`
        DELETE FROM file_undo
        WHERE project_path = ?
          AND id NOT IN (SELECT id FROM file_undo WHERE project_path = ? ORDER BY id DESC LIMIT ?)
          AND id <= ?
      `).run(projectPath, projectPath, MAX_PER_PROJECT, floor)
      return { id: Number(info.lastInsertRowid), filePath, beforeContent: before, afterContent: after, createdAt: now }
    },
    protectFrom(projectPath, floorId) { floors.set(projectPath, floorId) },
    clearProtection(projectPath) { floors.delete(projectPath) },
    list(projectPath) {
      const rows = db.prepare(`
        SELECT id, file_path as filePath, before_content as beforeContent, after_content as afterContent, created_at as createdAt
        FROM file_undo WHERE project_path = ?
        ORDER BY id DESC
      `).all(projectPath) as Row[]
      return rows
    },
    pop(id) {
      const row = db.prepare(
        'SELECT id, file_path as filePath, before_content as beforeContent, after_content as afterContent, created_at as createdAt FROM file_undo WHERE id = ?'
      ).get(id) as Row | undefined
      if (!row) return null
      db.prepare('DELETE FROM file_undo WHERE id = ?').run(id)
      return row
    },
    clear(projectPath) {
      const info = db.prepare('DELETE FROM file_undo WHERE project_path = ?').run(projectPath)
      return info.changes
    },
    count(projectPath) {
      const row = db.prepare('SELECT COUNT(*) as c FROM file_undo WHERE project_path = ?').get(projectPath) as { c: number }
      return row.c
    }
  }
}
