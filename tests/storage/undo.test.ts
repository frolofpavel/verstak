import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createUndoStack } from '../../electron/storage/undo'

// review fix #4: prune (MAX_PER_PROJECT=50) тихо удалял пост-чекпоинт записи →
// revertToCheckpoint молча откатывал лишь последние 50 (частичный откат без сигнала).
// Фикс: protectFrom(checkpointId) защищает записи новее чекпоинта от prune.
describe('UndoStack — prune защищает пост-чекпоинт записи (review #4)', () => {
  let dir: string
  let db: Database | undefined
  const PP = 'C:/proj'
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-undo-')) })
  afterEach(() => { db?.close(); db = undefined; rmSync(dir, { recursive: true, force: true }) })

  it('без чекпоинта prune держит 50 (baseline)', () => {
    db = openDb(join(dir, 't.db'))
    const u = createUndoStack(db)
    for (let i = 0; i < 60; i++) u.push(PP, `f${i}.ts`, '', `v${i}`)
    expect(u.count(PP)).toBe(50)
  })

  it('protectFrom: все записи новее чекпоинта выживают (откат к чекпоинту полный)', () => {
    db = openDb(join(dir, 't.db'))
    const u = createUndoStack(db)
    for (let i = 0; i < 5; i++) u.push(PP, `pre${i}.ts`, '', 'x')
    const checkpointId = u.list(PP)[0].id
    u.protectFrom(PP, checkpointId)
    // 60 пост-чекпоинт правок — без защиты ранние (id > checkpoint, но вне top-50) пруньнулись бы
    for (let i = 0; i < 60; i++) u.push(PP, `post${i}.ts`, '', `v${i}`)
    const postCheckpoint = u.list(PP).filter(e => e.id > checkpointId)
    expect(postCheckpoint.length).toBe(60)
    expect(postCheckpoint.some(e => e.filePath === 'post0.ts')).toBe(true) // самая ранняя на месте
  })

  it('clearProtection: после снятия защиты prune снова режет до 50', () => {
    db = openDb(join(dir, 't.db'))
    const u = createUndoStack(db)
    u.push(PP, 'a.ts', '', 'x')
    u.protectFrom(PP, 0) // floor=0 → защитить всё
    for (let i = 0; i < 60; i++) u.push(PP, `f${i}.ts`, '', 'x')
    expect(u.count(PP)).toBeGreaterThan(50)
    u.clearProtection(PP)
    u.push(PP, 'trigger.ts', '', 'x')
    expect(u.count(PP)).toBe(50)
  })
})
