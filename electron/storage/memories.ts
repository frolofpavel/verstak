import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'

export type MemoryType = 'fact' | 'decision' | 'bug' | 'preference' | 'pattern'

export interface Memory {
  id: string
  project_path: string
  type: MemoryType
  content: string
  tags: string[]
  created_at: number
  accessed_at: number
}

// Row shape as stored in SQLite — tags is a JSON string
interface MemoryRow {
  id: string
  project_path: string
  type: MemoryType
  content: string
  tags: string
  created_at: number
  accessed_at: number
}

function rowToMemory(row: MemoryRow): Memory {
  let tags: string[]
  try {
    tags = JSON.parse(row.tags) as string[]
  } catch {
    tags = []
  }
  return { ...row, tags }
}

export function saveMemory(
  db: Database,
  projectPath: string,
  type: MemoryType,
  content: string,
  tags: string[]
): Memory {
  const now = Date.now()
  const id = randomUUID()
  db.prepare(
    'INSERT INTO memories (id, project_path, type, content, tags, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, projectPath, type, content, JSON.stringify(tags), now, now)
  return { id, project_path: projectPath, type, content, tags, created_at: now, accessed_at: now }
}

export function searchMemories(
  db: Database,
  projectPath: string,
  query: string,
  limit = 5
): Memory[] {
  let rows: MemoryRow[]
  if (!query.trim()) {
    // Нет поискового запроса — возвращаем недавно использованные воспоминания проекта
    rows = db.prepare(
      'SELECT * FROM memories WHERE project_path = ? ORDER BY accessed_at DESC LIMIT ?'
    ).all(projectPath, limit) as MemoryRow[]
  } else {
    // FTS5 поиск по контенту и тегам, фильтрация по проекту
    try {
      rows = db.prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.project_path = ?
         LIMIT ?`
      ).all(query, projectPath, limit) as MemoryRow[]
    } catch {
      // FTS5 парсер не принял query — возвращаем пустой результат
      rows = []
    }
  }

  if (rows.length > 0) {
    // Обновляем время последнего обращения для найденных записей
    const now = Date.now()
    const ids = rows.map(r => r.id)
    const placeholders = ids.map(() => '?').join(', ')
    db.prepare(
      `UPDATE memories SET accessed_at = ? WHERE id IN (${placeholders})`
    ).run(now, ...ids)
    return rows.map(r => rowToMemory({ ...r, accessed_at: now }))
  }

  return rows.map(rowToMemory)
}

export function listMemories(db: Database, projectPath: string): Memory[] {
  const rows = db.prepare(
    'SELECT * FROM memories WHERE project_path = ? ORDER BY accessed_at DESC'
  ).all(projectPath) as MemoryRow[]
  return rows.map(rowToMemory)
}

export function deleteMemory(db: Database, id: string): boolean {
  const info = db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  return info.changes > 0
}
