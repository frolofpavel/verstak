import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createChats } from '../../electron/storage/chats'
import { createChatSessions } from '../../electron/storage/chat-sessions'

describe('chats', () => {
  let dir: string
  let db: Database | undefined

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-')) })
  afterEach(() => {
    db?.close()
    db = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty list for new session', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const s = sessions.create('/my/project')
    expect(chats.listBySession(s.id)).toEqual([])
  })

  it('appends and lists in order', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const s = sessions.create('/my/project')
    chats.appendToSession(s.id, '/my/project', 'user', 'hello')
    chats.appendToSession(s.id, '/my/project', 'assistant', 'hi back')
    const list = chats.listBySession(s.id)
    expect(list.map(m => [m.role, m.content])).toEqual([['user', 'hello'], ['assistant', 'hi back']])
  })

  it('isolates messages per session', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const a = sessions.create('/a')
    const b = sessions.create('/b')
    chats.appendToSession(a.id, '/a', 'user', 'msg-a')
    chats.appendToSession(b.id, '/b', 'user', 'msg-b')
    expect(chats.listBySession(a.id)).toHaveLength(1)
    expect(chats.listBySession(b.id)).toHaveLength(1)
  })

  it('legacy list() returns all messages of project across sessions', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const s1 = sessions.create('/p')
    const s2 = sessions.create('/p')
    chats.appendToSession(s1.id, '/p', 'user', 'first')
    chats.appendToSession(s2.id, '/p', 'user', 'second')
    expect(chats.list('/p')).toHaveLength(2)
  })
})
