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

  // 5.2 (review P0): один финальный assistant-ответ может прийти в append дважды
  // (active-чат Chat.tsx + snapshot-путь applyEventToChat) — голый INSERT плодил
  // дубль-строки. appendToSession теперь дедупит ПОВТОР того же assistant-сообщения.
  it('дедуп: повторный append того же assistant-ответа не плодит дубль', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const s = sessions.create('/p')
    chats.appendToSession(s.id, '/p', 'assistant', 'готовый ответ')
    chats.appendToSession(s.id, '/p', 'assistant', 'готовый ответ')
    expect(chats.listBySession(s.id)).toHaveLength(1)
  })

  it('дедуп НЕ срабатывает на разный assistant-контент', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const s = sessions.create('/p')
    chats.appendToSession(s.id, '/p', 'assistant', 'ответ 1')
    chats.appendToSession(s.id, '/p', 'assistant', 'ответ 2')
    expect(chats.listBySession(s.id)).toHaveLength(2)
  })

  it('user-сообщения НЕ дедупятся — намеренный повтор сохраняется', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db)
    const chats = createChats(db)
    const s = sessions.create('/p')
    chats.appendToSession(s.id, '/p', 'user', 'давай')
    chats.appendToSession(s.id, '/p', 'user', 'давай')
    expect(chats.listBySession(s.id)).toHaveLength(2)
  })

  // F (ось 3): «Откатить задачу» — граница + truncate.
  it('maxMessageId — макс. id сессии; 0 для пустой', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db); const chats = createChats(db)
    const s = sessions.create('/p')
    expect(chats.maxMessageId(s.id)).toBe(0)
    chats.appendToSession(s.id, '/p', 'user', 'a')
    chats.appendToSession(s.id, '/p', 'assistant', 'b')
    const list = chats.listBySession(s.id)
    expect(chats.maxMessageId(s.id)).toBe(list[list.length - 1].id)
  })

  it('truncateAfter — удаляет сообщения после границы, граница и до неё остаются', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db); const chats = createChats(db)
    const s = sessions.create('/p')
    chats.appendToSession(s.id, '/p', 'user', 'q1')
    chats.appendToSession(s.id, '/p', 'assistant', 'a1')
    const boundary = chats.maxMessageId(s.id) // чекпоинт здесь
    chats.appendToSession(s.id, '/p', 'user', 'q2')
    chats.appendToSession(s.id, '/p', 'assistant', 'a2')
    expect(chats.listBySession(s.id)).toHaveLength(4)
    const deleted = chats.truncateAfter(s.id, boundary)
    expect(deleted).toBe(2)
    expect(chats.listBySession(s.id).map(m => m.content)).toEqual(['q1', 'a1'])
  })

  it('truncateAfter изолирован по сессии', () => {
    db = openDb(join(dir, 't.db'))
    const sessions = createChatSessions(db); const chats = createChats(db)
    const a = sessions.create('/p'); const b = sessions.create('/p')
    chats.appendToSession(a.id, '/p', 'user', 'a1')
    chats.appendToSession(b.id, '/p', 'user', 'b1')
    chats.truncateAfter(a.id, 0) // снести всё в A
    expect(chats.listBySession(a.id)).toHaveLength(0)
    expect(chats.listBySession(b.id)).toHaveLength(1) // B не тронут
  })
})
