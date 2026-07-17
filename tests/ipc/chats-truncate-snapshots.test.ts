import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Ре-ревью 2.0.11-B, находка #12: тест инвалидации проверял НЕ ТОТ шов.
 *
 * Он звал chats.truncateAfter и invalidateSnapshotsAfter рядом, руками — то есть
 * воспроизводил связку сам, вместо того чтобы дёрнуть продовую (truncateWithSnapshots в
 * registerChatsIpc). Удали инвалидацию из IPC — и тот тест остался бы зелёным: он
 * проверял, что две функции работают, а не что кто-то их СВЯЗАЛ.
 *
 * Ровно тот же класс, что и главная находка первого ревью (тест сам подставлял chatId).
 * Поэтому здесь дёргается настоящий handler 'chats:truncate-after'.
 */

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  app: { getPath: () => tmpdir() },
}))

const { openDb } = await import('../../electron/storage/db')
const { createChats } = await import('../../electron/storage/chats')
const { createChatSessions } = await import('../../electron/storage/chat-sessions')
const { registerChatsIpc } = await import('../../electron/ipc/chats')
const { saveSnapshot, activeSnapshot } = await import('../../electron/storage/chat-context-snapshots')

let dir: string
let db: DB
let chats: ReturnType<typeof createChats>

const CHAT = 7

beforeEach(() => {
  handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'vst-trunc-'))
  db = openDb(join(dir, 'test.db'))
  chats = createChats(db)
  registerChatsIpc(chats, createChatSessions(db), db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const msg = (content: string): number => chats.appendToSession(CHAT, '/p', 'user', content).id

describe('продовый шов: откат диалога через IPC уносит сжатый итог', () => {
  it('handler chats:truncate-after сам инвалидирует задетые снапшоты', async () => {
    for (let i = 1; i <= 40; i++) msg(`сообщение ${i}`)
    saveSnapshot(db, {
      chatId: CHAT, summary: 'итог ветки, которую отменят',
      throughMessageId: 34, sourceMaxMessageId: 40,
    }, 1)

    // Именно то, что делает кнопка «Откатить задачу» — без ручной подстановки половин.
    const deleted = await handlers.get('chats:truncate-after')!({}, CHAT, 20)

    expect(deleted).toBe(20)
    expect(activeSnapshot(db, CHAT)).toBeNull()
  })

  it('снапшот внутри уцелевшей части переживает откат через IPC', async () => {
    for (let i = 1; i <= 40; i++) msg(`сообщение ${i}`)
    saveSnapshot(db, { chatId: CHAT, summary: 'итог начала', throughMessageId: 14, sourceMaxMessageId: 40 }, 1)

    await handlers.get('chats:truncate-after')!({}, CHAT, 20)

    expect(activeSnapshot(db, CHAT)?.summary).toBe('итог начала')
  })

  // Атомарность: сообщения и итог обязаны уйти вместе или не уйти вовсе.
  it('сообщения и снапшот уходят одной транзакцией', async () => {
    for (let i = 1; i <= 40; i++) msg(`сообщение ${i}`)
    saveSnapshot(db, { chatId: CHAT, summary: 'итог', throughMessageId: 34, sourceMaxMessageId: 40 }, 1)

    await handlers.get('chats:truncate-after')!({}, CHAT, 20)

    const left = db.prepare('SELECT COUNT(*) as c FROM chats WHERE session_id = ?').get(CHAT) as { c: number }
    expect(left.c).toBe(20)
    expect(activeSnapshot(db, CHAT)).toBeNull()
  })
})
