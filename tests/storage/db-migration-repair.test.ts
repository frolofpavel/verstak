import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import RawDatabase from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createUndoStack } from '../../electron/storage/undo'

describe('database migration repairs', () => {
  let dir: string | undefined
  let db: Database | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('creates undo_floors when an already-upgraded database missed that table', () => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-db-repair-'))
    const dbPath = join(dir, 'repair.db')
    const raw = new RawDatabase(dbPath)
    raw.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (id, version, updated_at) VALUES (1, 36, 1);
    `)
    raw.close()

    db = openDb(dbPath)

    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'undo_floors'").get()
    expect(table).toBeTruthy()
    expect(() => createUndoStack(db!)).not.toThrow()
  })

  it('adds chats.applied_skills when schema_version is current but the column is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-db-repair-'))
    const dbPath = join(dir, 'repair.db')
    const raw = new RawDatabase(dbPath)
    raw.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (id, version, updated_at) VALUES (1, 37, 1);
      CREATE TABLE chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        session_id INTEGER,
        thinking TEXT NOT NULL DEFAULT ''
      );
    `)
    raw.close()

    db = openDb(dbPath)

    const cols = (db.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('applied_skills')
  })
})
