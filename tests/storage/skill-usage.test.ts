import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createSkillUsageStore } from '../../electron/storage/skill-usage'

describe('skill_usage governance storage (migration 40)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-skill-usage-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('migration 40 creates skill_usage table', () => {
    const db = openDb(join(dir, 'test.db'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name)
    expect(tables).toContain('skill_usage')
    const cols = (db.prepare('PRAGMA table_info(skill_usage)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining(['skill_id', 'use_count', 'view_count', 'last_used_at', 'state', 'pinned', 'archived_at']))
    db.close()
  })

  it('recordUse upserts and increments use_count', () => {
    const db = openDb(join(dir, 'test.db'))
    const usage = createSkillUsageStore(db)

    expect(usage.recordUse('code-review', 1000)).toMatchObject({
      skillId: 'code-review',
      useCount: 1,
      lastUsedAt: 1000,
      state: 'active',
      pinned: false
    })
    expect(usage.recordUse('code-review', 2000)).toMatchObject({
      skillId: 'code-review',
      useCount: 2,
      lastUsedAt: 2000
    })
    expect(usage.list().map(r => [r.skillId, r.useCount])).toEqual([['code-review', 2]])
    db.close()
  })

  it('archive and restore preserve counters while toggling state', () => {
    const db = openDb(join(dir, 'test.db'))
    const usage = createSkillUsageStore(db)

    usage.recordUse('code-review', 1000)
    expect(usage.archive('code-review', 2000)).toMatchObject({
      skillId: 'code-review',
      useCount: 1,
      state: 'archived',
      archivedAt: 2000
    })
    expect(usage.restore('code-review')).toMatchObject({
      skillId: 'code-review',
      useCount: 1,
      state: 'active',
      archivedAt: null
    })
    db.close()
  })
})
