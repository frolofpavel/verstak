/**
 * User profiles — для multi-user поддержки команды агентства.
 *
 * Один профиль = одна "роль". Каждый пользователь имеет свой набор настроек.
 * Каждый имеет свой default provider, model, набор разрешённых скиллов.
 *
 * V1: одна машина = один активный профиль. Переключение через
 *     UI Settings. Per-user БД sync — V3.2.
 *
 * Источник: V3 Plan раздел 10.2.
 */

import type { Database } from 'better-sqlite3'

export interface UserProfile {
  id: number
  name: string
  role: string | null
  defaultProvider: string | null
  defaultModel: string | null
  /** JSON: array of skill ids, или null = все доступны */
  skillsEnabled: string[] | null
  createdAt: number
  isActive: boolean
}

export interface UserProfiles {
  list(): UserProfile[]
  get(id: number): UserProfile | null
  getActive(): UserProfile | null
  create(input: {
    name: string
    role?: string
    defaultProvider?: string
    defaultModel?: string
    skillsEnabled?: string[]
  }): UserProfile
  setActive(id: number): void
  update(id: number, patch: Partial<Omit<UserProfile, 'id' | 'createdAt'>>): void
  remove(id: number): void
}

interface Row {
  id: number
  name: string
  role: string | null
  default_provider: string | null
  default_model: string | null
  skills_enabled: string | null
  created_at: number
  is_active: number
}

function rowToProfile(r: Row): UserProfile {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    defaultProvider: r.default_provider,
    defaultModel: r.default_model,
    skillsEnabled: r.skills_enabled ? JSON.parse(r.skills_enabled) as string[] : null,
    createdAt: r.created_at,
    isActive: r.is_active === 1
  }
}

const SELECT = `SELECT id, name, role, default_provider, default_model, skills_enabled, created_at, is_active FROM user_profiles`

export function createUserProfiles(db: Database): UserProfiles {
  return {
    list() {
      return (db.prepare(`${SELECT} ORDER BY is_active DESC, name ASC`).all() as Row[]).map(rowToProfile)
    },
    get(id) {
      const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined
      return row ? rowToProfile(row) : null
    },
    getActive() {
      const row = db.prepare(`${SELECT} WHERE is_active = 1`).get() as Row | undefined
      return row ? rowToProfile(row) : null
    },
    create(input) {
      const now = Date.now()
      const info = db.prepare(
        `INSERT INTO user_profiles (name, role, default_provider, default_model, skills_enabled, created_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      ).run(
        input.name,
        input.role ?? null,
        input.defaultProvider ?? null,
        input.defaultModel ?? null,
        input.skillsEnabled ? JSON.stringify(input.skillsEnabled) : null,
        now
      )
      return {
        id: Number(info.lastInsertRowid),
        name: input.name,
        role: input.role ?? null,
        defaultProvider: input.defaultProvider ?? null,
        defaultModel: input.defaultModel ?? null,
        skillsEnabled: input.skillsEnabled ?? null,
        createdAt: now,
        isActive: false
      }
    },
    setActive(id) {
      const tx = db.transaction(() => {
        db.prepare('UPDATE user_profiles SET is_active = 0 WHERE is_active = 1').run()
        db.prepare('UPDATE user_profiles SET is_active = 1 WHERE id = ?').run(id)
      })
      tx()
    },
    update(id, patch) {
      const fields: string[] = []
      const values: unknown[] = []
      if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name) }
      if (patch.role !== undefined) { fields.push('role = ?'); values.push(patch.role) }
      if (patch.defaultProvider !== undefined) { fields.push('default_provider = ?'); values.push(patch.defaultProvider) }
      if (patch.defaultModel !== undefined) { fields.push('default_model = ?'); values.push(patch.defaultModel) }
      if (patch.skillsEnabled !== undefined) {
        fields.push('skills_enabled = ?')
        values.push(patch.skillsEnabled ? JSON.stringify(patch.skillsEnabled) : null)
      }
      if (fields.length === 0) return
      values.push(id)
      db.prepare(`UPDATE user_profiles SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    },
    remove(id) {
      db.prepare('DELETE FROM user_profiles WHERE id = ?').run(id)
    }
  }
}
