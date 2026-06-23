import type { Database } from 'better-sqlite3'
import { createFloorTracker } from './undo-floors'

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
  /** Снять защиту чекпоинта (после отката/очистки). floorId — конкретный чекпоинт;
   *  без него — снять ВСЕ floor'ы проекта (undo:clear). */
  clearProtection: (projectPath: string, floorId?: number) => void
}

const MAX_PER_PROJECT = 50

interface Row {
  id: number
  filePath: string
  beforeContent: string | null
  afterContent: string | null
  createdAt: number
}

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
    push(projectPath, filePath, before, after) {
      const now = Date.now()
      const info = db.prepare(
        'INSERT INTO file_undo (project_path, file_path, before_content, after_content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(projectPath, filePath, before, after, now)
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
      return { id: Number(info.lastInsertRowid), filePath, beforeContent: before, afterContent: after, createdAt: now }
    },
    protectFrom(projectPath, floorId) {
      floors.add(projectPath, floorId)
      db.prepare('INSERT INTO undo_floors (project_path, floor_id) VALUES (?, ?)').run(projectPath, floorId)
    },
    clearProtection(projectPath, floorId) {
      floors.remove(projectPath, floorId)
      if (floorId === undefined) {
        db.prepare('DELETE FROM undo_floors WHERE project_path = ?').run(projectPath)
      } else {
        // rowid+LIMIT 1: убрать ровно ОДИН row (дубликат floor от двух чатов на
        // одном id — например оба чекпоинтят на пустом стеке id=0 — не схлопнуть).
        db.prepare('DELETE FROM undo_floors WHERE rowid = (SELECT rowid FROM undo_floors WHERE project_path = ? AND floor_id = ? LIMIT 1)').run(projectPath, floorId)
      }
    },
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
      // Чистим и floor'ы проекта — иначе остались бы сироты на удалённые записи.
      floors.remove(projectPath)
      db.prepare('DELETE FROM undo_floors WHERE project_path = ?').run(projectPath)
      return info.changes
    },
    count(projectPath) {
      const row = db.prepare('SELECT COUNT(*) as c FROM file_undo WHERE project_path = ?').get(projectPath) as { c: number }
      return row.c
    }
  }
}
