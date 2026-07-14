import type { Database } from 'better-sqlite3'
import { basename } from 'path'
import { pickProjectColor } from '../../src/lib/project-avatar'
import { sortProjectsByName } from '../../src/lib/project-sort'
import type { RemoteSource } from '../projects/remote-source'

/** local — обычная папка; git — клонированный репо; ssh — файлы на сервере (live). */
export type ProjectKind = 'local' | 'git' | 'ssh'
export type ProjectStatus = 'active' | 'paused' | 'done'

export interface ProjectLabel {
  id: number
  name: string
  color: string
  createdAt: number
}

export interface ProjectMeta {
  path: string
  name: string
  color: string
  iconPath: string | null
  createdAt: number
  lastAssistantAt: number | null
  lastOpenedAt: number
  hidden: boolean
  /** Тип источника проекта (по умолчанию 'local'). */
  kind: ProjectKind
  /** Параметры удалённого источника (git/ssh). null для локального. */
  remote: RemoteSource | null
  notes: string
  labels: ProjectLabel[]
  accentColor: string | null
  notificationsMuted: boolean
  status: ProjectStatus
}

export interface ProjectMetaPatch {
  name?: string
  iconPath?: string | null
  hidden?: boolean
  notes?: string
  accentColor?: string | null
  notificationsMuted?: boolean
  status?: ProjectStatus
}

export interface Projects {
  list: () => ProjectMeta[]
  upsert: (path: string) => ProjectMeta
  /** Создать удалённый проект (git/ssh) с уже разобранным источником. */
  createRemote: (path: string, kind: 'git' | 'ssh', remote: RemoteSource) => ProjectMeta
  touch: (path: string) => void
  rename: (path: string, name: string) => void
  updateMeta: (path: string, patch: ProjectMetaPatch) => ProjectMeta | null
  remove: (path: string) => void
  listLabels: () => ProjectLabel[]
  createLabel: (name: string, color?: string | null) => ProjectLabel
  setProjectLabels: (path: string, labelIds: number[]) => ProjectMeta | null
}

const SELECT_COLS = 'path, name, color, icon_path as iconPath, created_at as createdAt, last_opened_at as lastOpenedAt, hidden, kind, remote_json as remoteJson, notes, accent_color as accentColor, notifications_muted as notificationsMuted, status'

function parseRemote(json: string | null | undefined): RemoteSource | null {
  if (!json) return null
  try { return JSON.parse(json) as RemoteSource } catch { return null }
}

function isProjectStatus(value: unknown): value is ProjectStatus {
  return value === 'active' || value === 'paused' || value === 'done'
}

function mapLabel(row: { id: number; name: string; color: string; createdAt?: number; created_at?: number }): ProjectLabel {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.createdAt ?? row.created_at ?? Date.now()
  }
}

function labelsForProject(db: Database, path: string): ProjectLabel[] {
  const rows = db.prepare(`
    SELECT l.id, l.name, l.color, l.created_at as createdAt
    FROM project_labels l
    JOIN project_label_members m ON m.label_id = l.id
    WHERE m.project_path = ?
    ORDER BY lower(l.name)
  `).all(path) as Array<{ id: number; name: string; color: string; createdAt: number }>
  return rows.map(mapLabel)
}

function lastAssistantAtForProject(db: Database, path: string): number | null {
  try {
    const row = db.prepare(
      "SELECT MAX(created_at) as lastAssistantAt FROM chats WHERE project_path = ? AND role = 'assistant' AND trim(COALESCE(content, '')) <> ''"
    ).get(path) as { lastAssistantAt?: number | null } | undefined
    return row?.lastAssistantAt ?? null
  } catch {
    return null
  }
}

function mapRowBase(
  row: ProjectMeta & { icon_path?: string | null; createdAt?: number; created_at?: number; hidden?: number | boolean; kind?: string; remoteJson?: string | null; remote_json?: string | null; notes?: string | null; accentColor?: string | null; accent_color?: string | null; notificationsMuted?: number | boolean; notifications_muted?: number | boolean; status?: string | null },
  lastAssistantAt: number | null,
  labels: ProjectLabel[]
): ProjectMeta {
  const status = isProjectStatus(row.status) ? row.status : 'active'
  return {
    path: row.path,
    name: row.name,
    color: row.color,
    iconPath: row.iconPath ?? row.icon_path ?? null,
    createdAt: row.createdAt ?? row.created_at ?? row.lastOpenedAt ?? Date.now(),
    lastAssistantAt,
    lastOpenedAt: row.lastOpenedAt,
    hidden: Boolean(row.hidden),
    kind: (row.kind as ProjectKind) ?? 'local',
    remote: parseRemote(row.remoteJson ?? row.remote_json),
    notes: row.notes ?? '',
    labels,
    accentColor: row.accentColor ?? row.accent_color ?? null,
    notificationsMuted: Boolean(row.notificationsMuted ?? row.notifications_muted ?? false),
    status
  }
}

function mapRow(db: Database, row: ProjectMeta & { icon_path?: string | null; createdAt?: number; created_at?: number; hidden?: number | boolean; kind?: string; remoteJson?: string | null; remote_json?: string | null; notes?: string | null; accentColor?: string | null; accent_color?: string | null; notificationsMuted?: number | boolean; notifications_muted?: number | boolean; status?: string | null }): ProjectMeta {
  return mapRowBase(row, lastAssistantAtForProject(db, row.path), labelsForProject(db, row.path))
}

export function createProjects(db: Database): Projects {
  return {
    list() {
      const rows = db.prepare(`SELECT ${SELECT_COLS} FROM projects`).all() as ProjectMeta[]
      if (rows.length === 0) return []

      const assistantRows = db.prepare(`
        SELECT project_path as path, MAX(created_at) as lastAssistantAt
        FROM chats
        WHERE role = 'assistant' AND trim(COALESCE(content, '')) <> ''
        GROUP BY project_path
      `).all() as Array<{ path: string; lastAssistantAt: number | null }>
      const lastAssistantByPath = new Map<string, number | null>(
        assistantRows.map(row => [row.path, row.lastAssistantAt ?? null])
      )

      const labelRows = db.prepare(`
        SELECT m.project_path as path, l.id, l.name, l.color, l.created_at as createdAt
        FROM project_label_members m
        JOIN project_labels l ON m.label_id = l.id
        ORDER BY m.project_path, lower(l.name)
      `).all() as Array<{ path: string; id: number; name: string; color: string; createdAt: number }>
      const labelsByPath = new Map<string, ProjectLabel[]>()
      for (const row of labelRows) {
        const labels = labelsByPath.get(row.path) ?? []
        labels.push(mapLabel(row))
        labelsByPath.set(row.path, labels)
      }

      return sortProjectsByName(rows.map(row => mapRowBase(
        row,
        lastAssistantByPath.get(row.path) ?? null,
        labelsByPath.get(row.path) ?? []
      )))
    },
    upsert(path) {
      const now = Date.now()
      const existing = db.prepare(`SELECT ${SELECT_COLS} FROM projects WHERE path = ?`).get(path) as ProjectMeta | undefined
      if (existing) {
        return mapRow(db, existing)
      }
      const name = basename(path) || path
      const color = pickProjectColor(path)
      // hidden задаём явно (а не полагаемся на DEFAULT 0 миграции) — ревью:
      // явное значение надёжнее при изменении дефолтов в будущем.
      db.prepare('INSERT INTO projects (path, name, color, icon_path, created_at, last_opened_at, hidden) VALUES (?, ?, ?, NULL, ?, ?, 0)').run(path, name, color, now, now)
      return { path, name, color, iconPath: null, createdAt: now, lastAssistantAt: null, lastOpenedAt: now, hidden: false, kind: 'local', remote: null, notes: '', labels: [], accentColor: null, notificationsMuted: false, status: 'active' }
    },
    createRemote(path, kind, remote) {
      const now = Date.now()
      const existing = db.prepare(`SELECT ${SELECT_COLS} FROM projects WHERE path = ?`).get(path) as ProjectMeta | undefined
      if (existing) return mapRow(db, existing)
      const name = remote.name || basename(path) || path
      const color = pickProjectColor(path)
      db.prepare('INSERT INTO projects (path, name, color, icon_path, created_at, last_opened_at, hidden, kind, remote_json) VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?)')
        .run(path, name, color, now, now, kind, JSON.stringify(remote))
      return { path, name, color, iconPath: null, createdAt: now, lastAssistantAt: null, lastOpenedAt: now, hidden: false, kind, remote, notes: '', labels: [], accentColor: null, notificationsMuted: false, status: 'active' }
    },
    touch(path) {
      db.prepare('UPDATE projects SET last_opened_at = ? WHERE path = ?').run(Date.now(), path)
    },
    rename(path, name) {
      db.prepare('UPDATE projects SET name = ? WHERE path = ?').run(name.trim(), path)
    },
    updateMeta(path, patch) {
      const row = db.prepare(`SELECT ${SELECT_COLS} FROM projects WHERE path = ?`).get(path) as ProjectMeta | undefined
      if (!row) return null
      const name = patch.name !== undefined ? patch.name.trim() : row.name
      const iconPath = patch.iconPath !== undefined ? patch.iconPath : (row.iconPath ?? null)
      const hidden = patch.hidden !== undefined ? (patch.hidden ? 1 : 0) : (row.hidden ? 1 : 0)
      const notes = patch.notes !== undefined ? patch.notes : (row.notes ?? '')
      const accentColor = patch.accentColor !== undefined ? patch.accentColor : (row.accentColor ?? null)
      const notificationsMuted = patch.notificationsMuted !== undefined ? (patch.notificationsMuted ? 1 : 0) : (row.notificationsMuted ? 1 : 0)
      const status = patch.status !== undefined ? patch.status : (isProjectStatus(row.status) ? row.status : 'active')
      db.prepare('UPDATE projects SET name = ?, icon_path = ?, hidden = ?, notes = ?, accent_color = ?, notifications_muted = ?, status = ? WHERE path = ?')
        .run(name, iconPath, hidden, notes, accentColor, notificationsMuted, status, path)
      return mapRow(db, { ...row, name, iconPath, hidden: Boolean(hidden), notes, accentColor, notificationsMuted: Boolean(notificationsMuted), status })
    },
    remove(path) {
      db.prepare('DELETE FROM projects WHERE path = ?').run(path)
    },
    listLabels() {
      const rows = db.prepare('SELECT id, name, color, created_at as createdAt FROM project_labels ORDER BY lower(name)').all() as Array<{ id: number; name: string; color: string; createdAt: number }>
      return rows.map(mapLabel)
    },
    createLabel(name, color) {
      const trimmed = name.trim()
      if (!trimmed) throw new Error('Название ярлыка пустое')
      const existing = db.prepare('SELECT id, name, color, created_at as createdAt FROM project_labels WHERE lower(name) = lower(?)').get(trimmed) as ProjectLabel | undefined
      if (existing) return mapLabel(existing)
      const labelColor = color || '#8fcfe0'
      const now = Date.now()
      const result = db.prepare('INSERT INTO project_labels (name, color, created_at) VALUES (?, ?, ?)').run(trimmed, labelColor, now)
      return { id: Number(result.lastInsertRowid), name: trimmed, color: labelColor, createdAt: now }
    },
    setProjectLabels(path, labelIds) {
      const row = db.prepare(`SELECT ${SELECT_COLS} FROM projects WHERE path = ?`).get(path) as ProjectMeta | undefined
      if (!row) return null
      const uniqueIds = Array.from(new Set(labelIds.filter(id => Number.isInteger(id) && id > 0)))
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM project_label_members WHERE project_path = ?').run(path)
        const insert = db.prepare('INSERT OR IGNORE INTO project_label_members (project_path, label_id) VALUES (?, ?)')
        for (const id of uniqueIds) insert.run(path, id)
      })
      tx()
      return mapRow(db, row)
    }
  }
}
