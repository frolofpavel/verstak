import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createChats } from '../../electron/storage/chats'
import { createChatSessions } from '../../electron/storage/chat-sessions'
import { saveSnapshot, activeSnapshot, invalidateSnapshotsAfter } from '../../electron/storage/chat-context-snapshots'

/**
 * Хвост ревью 2.0.11-B, находка #1 (critical): откат диалога и сжатие контекста
 * ничего не знали друг о друге.
 *
 * СЦЕНАРИЙ БЕДЫ. Человек сжал контекст (снапшот покрывает сообщения 1..34), потом нажал
 * «Откатить задачу» — строки 21..40 удалены. Снапшот остаётся жить:
 *   · хвост (id > 34) пуст → модель получает ОДИН summary, а весь видимый человеку
 *     диалог 1..20 из запроса выпадает;
 *   · сам summary пересказывает откаченную ветку 21..34 — человек её отменил, а модель
 *     продолжает считать её актуальной.
 * После нового сообщения (id=41 > 34) снапшот выглядит «валидным» и воскрешает отменённое
 * НАВСЕГДА. Поэтому мало проверки «граница не выше максимума» — нужна инвалидация.
 */

let dir: string
let db: DB
let chats: ReturnType<typeof createChats>

const CHAT = 7

const msg = (chatId: number, content: string): number =>
  chats.appendToSession(chatId, '/p', 'user', content).id

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vst-inval-'))
  db = openDb(join(dir, 'test.db'))
  chats = createChats(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('откат диалога инвалидирует сжатие (ревью B #1)', () => {
  it('снапшот, покрывающий откаченные сообщения, перестаёт быть активным', () => {
    for (let i = 1; i <= 40; i++) msg(CHAT, `сообщение ${i}`)
    const saved = saveSnapshot(db, {
      chatId: CHAT, summary: 'итог ветки, которую потом отменят',
      throughMessageId: 34, sourceMaxMessageId: 40,
    }, 1)
    expect(saved.ok).toBe(true)

    // Человек откатывает задачу к чекпоинту на 20-м сообщении.
    chats.truncateAfter(CHAT, 20)
    invalidateSnapshotsAfter(db, CHAT, 20)

    // Снапшот пересказывал 21..34 — эту ветку человек отменил. Он не смеет остаться.
    expect(activeSnapshot(db, CHAT)).toBeNull()
  })

  it('снапшот ЦЕЛИКОМ внутри уцелевшей части остаётся рабочим (не рубим лишнего)', () => {
    for (let i = 1; i <= 40; i++) msg(CHAT, `сообщение ${i}`)
    saveSnapshot(db, { chatId: CHAT, summary: 'итог начала', throughMessageId: 14, sourceMaxMessageId: 40 }, 1)

    chats.truncateAfter(CHAT, 20)
    invalidateSnapshotsAfter(db, CHAT, 20)

    // Граница 14 < 20: всё, что покрыто итогом, на месте. Сжатие честно работает дальше.
    expect(activeSnapshot(db, CHAT)?.summary).toBe('итог начала')
  })

  it('граница ровно на точке отката — снапшот остаётся (покрытое не удалено)', () => {
    for (let i = 1; i <= 40; i++) msg(CHAT, `сообщение ${i}`)
    saveSnapshot(db, { chatId: CHAT, summary: 'итог', throughMessageId: 20, sourceMaxMessageId: 40 }, 1)

    chats.truncateAfter(CHAT, 20)
    invalidateSnapshotsAfter(db, CHAT, 20)

    expect(activeSnapshot(db, CHAT)?.summary).toBe('итог')
  })

  // Главный сценарий ревью: зомби оживает после нового сообщения.
  it('новое сообщение после отката НЕ воскрешает отменённый итог', () => {
    for (let i = 1; i <= 40; i++) msg(CHAT, `сообщение ${i}`)
    saveSnapshot(db, { chatId: CHAT, summary: 'итог отменённой ветки', throughMessageId: 34, sourceMaxMessageId: 40 }, 1)

    chats.truncateAfter(CHAT, 20)
    invalidateSnapshotsAfter(db, CHAT, 20)
    msg(CHAT, 'что дальше?') // id = 41 > 34 → зомби выглядел бы «валидным»

    expect(activeSnapshot(db, CHAT)).toBeNull()
  })

  it('инвалидация не трогает другие чаты', () => {
    for (let i = 1; i <= 40; i++) msg(CHAT, `с ${i}`)
    for (let i = 1; i <= 40; i++) msg(8, `с ${i}`)
    saveSnapshot(db, { chatId: 8, summary: 'итог соседа', throughMessageId: 74, sourceMaxMessageId: 80 }, 1)

    invalidateSnapshotsAfter(db, CHAT, 20)

    expect(activeSnapshot(db, 8)?.summary).toBe('итог соседа')
  })

  it('несколько снапшотов: рубятся только задетые откатом, история сжатий сохраняется', () => {
    for (let i = 1; i <= 40; i++) msg(CHAT, `с ${i}`)
    saveSnapshot(db, { chatId: CHAT, summary: 'первый (ранний)', throughMessageId: 10, sourceMaxMessageId: 40 }, 1)
    saveSnapshot(db, { chatId: CHAT, summary: 'второй (поздний)', throughMessageId: 34, sourceMaxMessageId: 40 }, 2)

    chats.truncateAfter(CHAT, 20)
    invalidateSnapshotsAfter(db, CHAT, 20)

    // Поздний покрывал откаченное — ушёл. Ранний цел и снова становится активным.
    expect(activeSnapshot(db, CHAT)?.summary).toBe('первый (ранний)')
  })

  it('нечего инвалидировать → 0 и без падения', () => {
    expect(invalidateSnapshotsAfter(db, CHAT, 20)).toBe(0)
  })
})

describe('удаление чата уносит его сжатия (ревью B #14)', () => {
  it('снапшоты удалённого чата не остаются сиротами', () => {
    const sessions = createChatSessions(db)
    const s = sessions.create('/p', { title: 'чат' })
    for (let i = 1; i <= 20; i++) msg(s.id, `с ${i}`)
    saveSnapshot(db, { chatId: s.id, summary: 'итог', throughMessageId: 14, sourceMaxMessageId: 20 }, 1)

    sessions.remove(s.id)

    const left = db.prepare('SELECT COUNT(*) as c FROM chat_context_snapshots WHERE chat_id = ?').get(s.id) as { c: number }
    expect(left.c).toBe(0)
  })

  it('удаление одного чата не трогает сжатия другого', () => {
    const sessions = createChatSessions(db)
    const a = sessions.create('/p', { title: 'a' })
    const b = sessions.create('/p', { title: 'b' })
    const bMsg = msg(b.id, 'сообщение соседа')
    saveSnapshot(db, { chatId: b.id, summary: 'итог соседа', throughMessageId: bMsg, sourceMaxMessageId: bMsg }, 1)

    sessions.remove(a.id)

    expect(activeSnapshot(db, b.id)?.summary).toBe('итог соседа')
  })
})
