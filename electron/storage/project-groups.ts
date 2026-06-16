import type { Database } from 'better-sqlite3'
import { compareProjectNames } from '../../src/lib/project-sort'

export interface ProjectGroup {
  id: number
  name: string
  sortOrder: number
  collapsed: boolean
  projectPaths: string[]
  createdAt: number
}

export interface ProjectGroupPatch {
  name?: string
  projectPaths?: string[]
  collapsed?: boolean
  sortOrder?: number
}

type GroupRow = {
  id: number
  name: string
  sort_order: number
  collapsed: number
  created_at: number
}

function mapGroup(row: GroupRow, paths: string[]): ProjectGroup {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    collapsed: row.collapsed === 1,
    projectPaths: paths,
    createdAt: row.created_at,
  }
}

function loadPaths(db: Database, groupId: number): string[] {
  const rows = db.prepare(`
    SELECT project_path as path
    FROM project_group_members
    WHERE group_id = ?
    ORDER BY sort_order ASC, project_path ASC
  `).all(groupId) as Array<{ path: string }>
  return rows.map(r => r.path)
}

function sortPathsByProjectNames(db: Database, paths: string[]): string[] {
  const names = new Map<string, string>()
  for (const path of paths) {
    const row = db.prepare('SELECT name FROM projects WHERE path = ?').get(path) as { name: string } | undefined
    names.set(path, row?.name ?? path)
  }
  return [...paths].sort((a, b) => compareProjectNames(names.get(a) ?? a, names.get(b) ?? b) || a.localeCompare(b))
}

function replaceMembers(db: Database, groupId: number, paths: string[]): void {
  const unique = [...new Set(paths)]
  const detachOthers = db.prepare(
    'DELETE FROM project_group_members WHERE project_path = ? AND group_id != ?'
  )
  for (const path of unique) detachOthers.run(path, groupId)
  db.prepare('DELETE FROM project_group_members WHERE group_id = ?').run(groupId)
  const insert = db.prepare(
    'INSERT INTO project_group_members (group_id, project_path, sort_order) VALUES (?, ?, ?)'
  )
  const sorted = sortPathsByProjectNames(db, unique)
  sorted.forEach((path, idx) => insert.run(groupId, path, idx))
}

export interface ProjectGroups {
  list: () => ProjectGroup[]
  create: (name: string, projectPaths: string[]) => ProjectGroup
  update: (id: number, patch: ProjectGroupPatch) => ProjectGroup | null
  remove: (id: number) => void
  detachProject: (projectPath: string) => void
}

export function createProjectGroups(db: Database): ProjectGroups {
  return {
    list() {
      const rows = db.prepare(`
        SELECT id, name, sort_order, collapsed, created_at
        FROM project_groups
        ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC
      `).all() as GroupRow[]
      return rows.map(row => mapGroup(row, loadPaths(db, row.id)))
    },

    create(name, projectPaths) {
      const trimmed = name.trim()
      if (!trimmed) throw new Error('Укажите название группы')
      const now = Date.now()
      const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM project_groups').get() as { m: number }
      const info = db.prepare(
        'INSERT INTO project_groups (name, sort_order, collapsed, created_at) VALUES (?, ?, 0, ?)'
      ).run(trimmed, maxOrder.m + 1, now)
      const id = Number(info.lastInsertRowid)
      replaceMembers(db, id, projectPaths)
      const row = db.prepare('SELECT id, name, sort_order, collapsed, created_at FROM project_groups WHERE id = ?').get(id) as GroupRow
      return mapGroup(row, loadPaths(db, id))
    },

    update(id, patch) {
      const row = db.prepare('SELECT id, name, sort_order, collapsed, created_at FROM project_groups WHERE id = ?').get(id) as GroupRow | undefined
      if (!row) return null
      const name = patch.name !== undefined ? patch.name.trim() : row.name
      if (!name) throw new Error('Укажите название группы')
      const sortOrder = patch.sortOrder ?? row.sort_order
      const collapsed = patch.collapsed !== undefined ? (patch.collapsed ? 1 : 0) : row.collapsed
      db.prepare('UPDATE project_groups SET name = ?, sort_order = ?, collapsed = ? WHERE id = ?').run(name, sortOrder, collapsed, id)
      if (patch.projectPaths !== undefined) replaceMembers(db, id, patch.projectPaths)
      const next = db.prepare('SELECT id, name, sort_order, collapsed, created_at FROM project_groups WHERE id = ?').get(id) as GroupRow
      return mapGroup(next, loadPaths(db, id))
    },

    remove(id) {
      db.prepare('DELETE FROM project_groups WHERE id = ?').run(id)
    },

    detachProject(projectPath) {
      db.prepare('DELETE FROM project_group_members WHERE project_path = ?').run(projectPath)
    },
  }
}