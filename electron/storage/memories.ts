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
  decay_score: number
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
  decay_score: number
}

function rowToMemory(row: MemoryRow): Memory {
  let tags: string[]
  try {
    tags = JSON.parse(row.tags) as string[]
  } catch {
    tags = []
  }
  return { ...row, tags, decay_score: row.decay_score ?? 1.0 }
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

  // Try insert, ignore if duplicate
  const result = db.prepare(
    `INSERT OR IGNORE INTO memories (id, project_path, type, content, tags, created_at, accessed_at, decay_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1.0)`
  ).run(id, projectPath, type, content, JSON.stringify(tags), now, now)

  if (result.changes === 0) {
    // Дубль — last-write-wins: обновить type, tags, accessed_at, сбросить decay. Ось 4 #3:
    // ВОСКРЕШАЕМ запись — снимаем invalidated_at/superseded_by, иначе повторное явное
    // сохранение того же факта молча оставалось бы невидимым в recall (ревью HIGH).
    db.prepare(`UPDATE memories SET type = ?, tags = ?, accessed_at = ?, decay_score = 1.0, invalidated_at = NULL, superseded_by = NULL WHERE project_path = ? AND content = ?`)
      .run(type, JSON.stringify(tags), now, projectPath, content)
    const updated = db.prepare(`SELECT * FROM memories WHERE project_path = ? AND content = ?`)
      .get(projectPath, content) as MemoryRow
    return rowToMemory(updated)
  }

  return { id, project_path: projectPath, type, content, tags, created_at: now, accessed_at: now, decay_score: 1.0 }
}

/**
 * NL-запрос → безопасный FTS5 MATCH: токены (буквы/цифры, ≥3 симв) в кавычках через
 * OR. Кавычки гасят спецсимволы FTS5 (иначе сырое сообщение ломает парсер → []), OR —
 * любой токен релевантен. Пустой/короткий → '' (вызывающий уйдёт на recency).
 */
export function buildFtsMatch(raw: string): string {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).slice(0, 12)
  return tokens.length ? tokens.map(t => `"${t}"`).join(' OR ') : ''
}

export function searchMemories(
  db: Database,
  projectPath: string,
  query: string,
  limit = 5
): Memory[] {
  // Ось 4 #3: invalidated (суперсеженные) воспоминания НЕ участвуют в recall.
  const recency = () => db.prepare(
    'SELECT * FROM memories WHERE project_path = ? AND invalidated_at IS NULL ORDER BY accessed_at DESC LIMIT ?'
  ).all(projectPath, limit) as MemoryRow[]

  let rows: MemoryRow[] = []
  const fts = buildFtsMatch(query)
  if (!fts) {
    // Пустой/несодержательный запрос — недавно использованные (как было).
    rows = recency()
  } else {
    // FTS5 по контенту+тегам, ORDER BY rank = по релевантности (BM25), не по rowid.
    // НЕ фолбэчим на recency здесь — иначе memory_search-тулза давала бы шум на no-match.
    // Recency-фолбэк делает только инжект в начале чата (ai.ts), где это уместно.
    try {
      rows = db.prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.project_path = ? AND m.invalidated_at IS NULL
         ORDER BY rank LIMIT ?`
      ).all(fts, projectPath, limit) as MemoryRow[]
    } catch {
      rows = []
    }
  }

  if (rows.length > 0) {
    // Обновляем время последнего обращения для найденных записей
    const now = Date.now()
    const ids = rows.map(r => r.id)
    const placeholders = ids.map(() => '?').join(', ')
    db.prepare(
      `UPDATE memories SET accessed_at = ?, decay_score = 1.0 WHERE id IN (${placeholders})`
    ).run(now, ...ids)
    return rows.map(r => rowToMemory({ ...r, accessed_at: now, decay_score: 1.0 }))
  }

  return rows.map(rowToMemory)
}

export function listMemories(db: Database, projectPath: string): Memory[] {
  const rows = db.prepare(
    'SELECT * FROM memories WHERE project_path = ? AND invalidated_at IS NULL ORDER BY accessed_at DESC'
  ).all(projectPath) as MemoryRow[]
  return rows.map(rowToMemory)
}

/**
 * Ось 4 #3: soft-invalidate — пометить воспоминание устаревшим (суперсеженным), НЕ
 * удаляя физически. Из recall выпадает, но история «было X → стало Y» сохраняется
 * (audit-trail: агент может объяснить, почему решение изменилось). supersededBy — id
 * нового воспоминания, заменившего это. Decay физически приберёт со временем сам.
 */
export function invalidateMemory(db: Database, id: string, supersededBy?: string | null): boolean {
  const info = db.prepare(
    'UPDATE memories SET invalidated_at = ?, superseded_by = ? WHERE id = ? AND invalidated_at IS NULL'
  ).run(Date.now(), supersededBy ?? null, id)
  return info.changes > 0
}

export function deleteMemory(db: Database, id: string): boolean {
  const info = db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  return info.changes > 0
}

/**
 * Применяет формулу затухания Эббингауза к воспоминаниям.
 * Вызывается один раз при старте приложения.
 *
 * Формула: каждый день без обращения decay_score *= 0.95
 * Удаляем записи старше 30 дней с decay_score < 0.1.
 */
export function applyMemoryDecay(db: Database): { decayed: number; deleted: number } {
  const now = Date.now()
  const DAY_MS = 86_400_000

  // Уменьшаем score для записей, к которым не обращались более суток
  const decayed = db.prepare(`
    UPDATE memories
    SET decay_score = decay_score * 0.95
    WHERE accessed_at < ? AND decay_score > 0.05
  `).run(now - DAY_MS).changes

  // Удаляем совсем протухшие (>30 дней без обращения И score < 0.1). Ревью IMPROVEMENT:
  // архитектурные/устойчивые типы (decision/bug/preference) НЕ удаляем физически — их
  // score занижается (выпадают из recall), но запись сохраняется (иначе редкое, но важное
  // решение молча теряется без audit-trail, как проходной шум). Эпизодические fact/pattern
  // подлежат физуборке.
  const deleted = db.prepare(`
    DELETE FROM memories
    WHERE accessed_at < ? AND decay_score < 0.1
      AND type NOT IN ('decision', 'bug', 'preference')
  `).run(now - 30 * DAY_MS).changes

  return { decayed, deleted }
}
