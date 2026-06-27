import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createChats } from '../../electron/storage/chats'
import { createChatSessions } from '../../electron/storage/chat-sessions'

// Tier-2 #3 — ветвление сессий: форк копирует историю до точки в новую main-сессию
// (parentChatId = источник → дерево), оригинал не трогается.
describe('chat-sessions fork', () => {
  let dir: string
  let db: Database | undefined
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-fork-')) })
  afterEach(() => { db?.close(); db = undefined; rmSync(dir, { recursive: true, force: true }) })

  it('копирует историю ДО точки + parentChatId, оригинал цел', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const src = sessions.create('/p', { title: 'Исходный', model: 'opus' })
    chats.appendToSession(src.id, '/p', 'user', 'm1')
    chats.appendToSession(src.id, '/p', 'assistant', 'm2')
    chats.appendToSession(src.id, '/p', 'user', 'm3')
    const msgs = chats.listBySession(src.id)

    const branch = sessions.fork(src.id, { uptoMessageId: msgs[1].id }) // до m2
    expect(branch).not.toBeNull()
    expect(branch!.parentChatId).toBe(src.id)
    expect(branch!.kind).toBe('main')
    expect(branch!.model).toBe('opus') // наследует провайдер/модель
    expect(chats.listBySession(branch!.id).map(m => m.content)).toEqual(['m1', 'm2'])
    expect(chats.listBySession(src.id).map(m => m.content)).toEqual(['m1', 'm2', 'm3']) // оригинал цел
  })

  it('без uptoMessageId — вся история', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const src = sessions.create('/p')
    chats.appendToSession(src.id, '/p', 'user', 'a')
    chats.appendToSession(src.id, '/p', 'assistant', 'b')
    const branch = sessions.fork(src.id)
    expect(chats.listBySession(branch!.id).map(m => m.content)).toEqual(['a', 'b'])
  })

  it('несуществующий источник → null', () => {
    db = openDb(join(dir, 't.db'))
    expect(createChatSessions(db).fork(99999)).toBeNull()
  })

  it('ветка видна в list (main) с parentChatId (для дерева)', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const src = sessions.create('/p')
    chats.appendToSession(src.id, '/p', 'user', 'x')
    const branch = sessions.fork(src.id)
    expect(sessions.list('/p').some(s => s.id === branch!.id && s.parentChatId === src.id)).toBe(true)
  })
})
