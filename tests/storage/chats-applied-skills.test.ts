import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import RawDatabase from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createChatSessions } from '../../electron/storage/chat-sessions'
import { createChats } from '../../electron/storage/chats'

describe('chats applied skills metadata', () => {
  let dir: string
  let db: ReturnType<typeof openDb>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-chat-skills-'))
    db = openDb(join(dir, 't.db'))
  })

  afterEach(() => {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stores and restores skills attached to a user message', () => {
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const session = sessions.create('/p')

    chats.appendToSession(session.id, '/p', 'user', 'review this', {
      appliedSkills: [{ id: 'code-review', name: 'Code Review', icon: 'R' }]
    })

    expect(chats.listBySession(session.id)[0].appliedSkills).toEqual([
      { id: 'code-review', name: 'Code Review', icon: 'R' }
    ])
  })

  it('keeps legacy chats readable when applied_skills column is missing', () => {
    const legacy = new RawDatabase(':memory:')
    legacy.exec(`
      CREATE TABLE chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        title TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        last_message_at INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'main',
        parent_chat_id INTEGER
      );
      CREATE TABLE chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        session_id INTEGER,
        thinking TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO chat_sessions (id, project_path, title, created_at, last_message_at)
      VALUES (1, '/p', 'Основной чат', 1, 1);
      INSERT INTO chats (session_id, project_path, role, content, created_at)
      VALUES (1, '/p', 'user', 'old message', 1);
    `)

    try {
      const chats = createChats(legacy)
      expect(chats.listBySession(1)).toMatchObject([
        { role: 'user', content: 'old message', appliedSkills: [] }
      ])
    } finally {
      legacy.close()
    }
  })
})
