import type { Database } from 'better-sqlite3'

export interface SkillUsageRecord {
  skillId: string
  useCount: number
  viewCount: number
  lastUsedAt: number | null
  state: 'active' | 'stale' | 'archived'
  pinned: boolean
  archivedAt: number | null
}

export interface SkillUsageStore {
  recordUse(skillId: string, at?: number): SkillUsageRecord
  archive(skillId: string, at?: number): SkillUsageRecord
  restore(skillId: string): SkillUsageRecord
  get(skillId: string): SkillUsageRecord | null
  list(): SkillUsageRecord[]
}

interface SkillUsageRow {
  skill_id: string
  use_count: number
  view_count: number
  last_used_at: number | null
  state: 'active' | 'stale' | 'archived'
  pinned: number
  archived_at: number | null
}

const SELECT = `
  SELECT skill_id, use_count, view_count, last_used_at, state, pinned, archived_at
  FROM skill_usage
`

function mapRow(row: SkillUsageRow): SkillUsageRecord {
  return {
    skillId: row.skill_id,
    useCount: row.use_count,
    viewCount: row.view_count,
    lastUsedAt: row.last_used_at,
    state: row.state,
    pinned: row.pinned === 1,
    archivedAt: row.archived_at
  }
}

export function createSkillUsageStore(db: Database): SkillUsageStore {
  return {
    recordUse(skillId, at = Date.now()) {
      const id = skillId.trim()
      if (!id) throw new Error('skillId is required')
      db.prepare(`
        INSERT INTO skill_usage (skill_id, use_count, view_count, last_used_at, state, pinned, archived_at)
        VALUES (?, 1, 0, ?, 'active', 0, NULL)
        ON CONFLICT(skill_id) DO UPDATE SET
          use_count = use_count + 1,
          last_used_at = excluded.last_used_at,
          state = CASE WHEN skill_usage.state = 'archived' THEN 'archived' ELSE 'active' END
      `).run(id, at)
      const row = db.prepare(`${SELECT} WHERE skill_id = ?`).get(id) as SkillUsageRow
      return mapRow(row)
    },
    archive(skillId, at = Date.now()) {
      const id = skillId.trim()
      if (!id) throw new Error('skillId is required')
      db.prepare(`
        INSERT INTO skill_usage (skill_id, use_count, view_count, last_used_at, state, pinned, archived_at)
        VALUES (?, 0, 0, NULL, 'archived', 0, ?)
        ON CONFLICT(skill_id) DO UPDATE SET
          state = 'archived',
          archived_at = excluded.archived_at
      `).run(id, at)
      const row = db.prepare(`${SELECT} WHERE skill_id = ?`).get(id) as SkillUsageRow
      return mapRow(row)
    },
    restore(skillId) {
      const id = skillId.trim()
      if (!id) throw new Error('skillId is required')
      db.prepare(`
        INSERT INTO skill_usage (skill_id, use_count, view_count, last_used_at, state, pinned, archived_at)
        VALUES (?, 0, 0, NULL, 'active', 0, NULL)
        ON CONFLICT(skill_id) DO UPDATE SET
          state = 'active',
          archived_at = NULL
      `).run(id)
      const row = db.prepare(`${SELECT} WHERE skill_id = ?`).get(id) as SkillUsageRow
      return mapRow(row)
    },
    get(skillId) {
      const id = skillId.trim()
      if (!id) return null
      const row = db.prepare(`${SELECT} WHERE skill_id = ?`).get(id) as SkillUsageRow | undefined
      return row ? mapRow(row) : null
    },
    list() {
      const rows = db.prepare(`${SELECT} ORDER BY use_count DESC, last_used_at DESC, skill_id ASC`).all() as SkillUsageRow[]
      return rows.map(mapRow)
    }
  }
}
