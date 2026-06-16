import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createProjects } from '../../electron/storage/projects'
import { createProjectGroups } from '../../electron/storage/project-groups'

describe('project-groups', () => {
  let dir: string
  let db: Database | undefined

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-grp-')) })
  afterEach(() => {
    db?.close()
    db = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a group with sorted members', () => {
    db = openDb(join(dir, 'g1.db'))
    const projects = createProjects(db)
    const groups = createProjectGroups(db)
    projects.upsert('C:\\Zeta')
    projects.upsert('C:\\Alpha')
    projects.updateMeta('C:\\Zeta', { name: 'Zeta' })
    projects.updateMeta('C:\\Alpha', { name: 'Alpha' })

    const group = groups.create('Clients', ['C:\\Zeta', 'C:\\Alpha'])
    expect(group.name).toBe('Clients')
    expect(group.projectPaths).toEqual(['C:\\Alpha', 'C:\\Zeta'])
    expect(groups.list()).toHaveLength(1)
  })

  it('moves a project exclusively between groups', () => {
    db = openDb(join(dir, 'g2.db'))
    const projects = createProjects(db)
    const groups = createProjectGroups(db)
    projects.upsert('C:\\One')

    const a = groups.create('A', ['C:\\One'])
    const b = groups.create('B', ['C:\\One'])

    expect(groups.list().find(g => g.id === a.id)?.projectPaths).toEqual([])
    expect(groups.list().find(g => g.id === b.id)?.projectPaths).toEqual(['C:\\One'])
  })

  it('updates collapsed state and detaches on project remove', () => {
    db = openDb(join(dir, 'g3.db'))
    const projects = createProjects(db)
    const groups = createProjectGroups(db)
    projects.upsert('C:\\Keep')
    projects.upsert('C:\\Drop')

    const group = groups.create('Mix', ['C:\\Keep', 'C:\\Drop'])
    const updated = groups.update(group.id, { collapsed: true })
    expect(updated?.collapsed).toBe(true)

    groups.detachProject('C:\\Drop')
    expect(groups.list()[0].projectPaths).toEqual(['C:\\Keep'])
    projects.remove('C:\\Keep')
    groups.detachProject('C:\\Keep')
    expect(groups.list()[0].projectPaths).toEqual([])
  })

  it('rejects empty group name', () => {
    db = openDb(join(dir, 'g4.db'))
    const groups = createProjectGroups(db)
    expect(() => groups.create('   ', [])).toThrow(/название/i)
  })
})