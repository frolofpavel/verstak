import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { saveSnapshot, activeSnapshot, snapshotHistory, maxMessageId } from '../../electron/storage/chat-context-snapshots'

/**
 * Срез 2.0.11-B: persistent context snapshot. Сценарии — прямо из карточки:
 * пустой чат, конкурентное сообщение, отказ модели, рестарт, повторная компакция поверх
 * старой, разные чаты.
 *
 * DoD: после рестарта модель получает тот же snapshot + хвост; при ЛЮБОЙ ошибке
 * предыдущий контекст остаётся рабочим.
 */

let dir: string
let db: DB

const msg = (chatId: number, role: string, content: string): number => {
  const info = db.prepare(
    "INSERT INTO chats (project_path, session_id, role, content, created_at) VALUES ('/p', ?, ?, ?, 1)"
  ).run(chatId, role, content)
  return info.lastInsertRowid as number
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vst-ctx-'))
  db = openDb(join(dir, 'test.db'))
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('persistent context snapshot (2.0.11-B)', () => {
  it('миграция 52 создаёт таблицу', () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_context_snapshots'").get()).toBeTruthy()
  })

  it('сжатия не было → активного снапшота нет (модель получает историю как раньше)', () => {
    expect(activeSnapshot(db, 7)).toBeNull()
  })

  it('ПУСТОЙ чат → граница не выбирается, отказ без записи', () => {
    const res = saveSnapshot(db, { chatId: 7, summary: 'итог', throughMessageId: 0, sourceMaxMessageId: 0 }, 1000)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toBe('invalid-boundary')
    expect(activeSnapshot(db, 7)).toBeNull()
  })

  it('сохранение снапшота → он становится активным', () => {
    msg(7, 'user', 'привет'); const last = msg(7, 'assistant', 'здравствуйте')
    const res = saveSnapshot(db, {
      chatId: 7, summary: 'обсудили приветствие', throughMessageId: last, sourceMaxMessageId: last,
      providerId: 'claude', model: 'claude-sonnet-4-6', estimatedTokensBefore: 5000, estimatedTokensAfter: 300,
    }, 1000)
    expect(res.ok).toBe(true)
    const active = activeSnapshot(db, 7)!
    expect(active.summary).toBe('обсудили приветствие')
    expect(active.throughMessageId).toBe(last)
    expect(active.estimatedTokensBefore).toBe(5000)
  })

  // ГЛАВНЫЙ СТРАЖ (карточка п.5). Суммаризация идёт секунды — за это время человек может
  // дописать. Записать снапшот, «съевший» новое сообщение, нельзя.
  it('КОНКУРЕНТНОЕ сообщение во время суммаризации → conflict, НЕ записано ничего', () => {
    msg(7, 'user', 'первое'); const readMax = msg(7, 'assistant', 'ответ')
    // …пока считали summary, человек дописал:
    msg(7, 'user', 'ещё вопрос')

    const res = saveSnapshot(db, { chatId: 7, summary: 'итог', throughMessageId: readMax, sourceMaxMessageId: readMax }, 1000)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toBe('conflict')
    expect(activeSnapshot(db, 7)).toBeNull() // ничего не записали
  })

  it('conflict НЕ рушит уже существующий снапшот (предыдущий контекст остаётся рабочим)', () => {
    const m1 = msg(7, 'user', 'первое')
    saveSnapshot(db, { chatId: 7, summary: 'снапшот №1', throughMessageId: m1, sourceMaxMessageId: m1 }, 1000)
    // Вторая компакция читает max=m2, но чат успевает пополниться.
    const m2 = msg(7, 'assistant', 'второе')
    msg(7, 'user', 'третье — прилетело во время суммаризации')

    const res = saveSnapshot(db, { chatId: 7, summary: 'снапшот №2', throughMessageId: m2, sourceMaxMessageId: m2 }, 2000)
    expect(res.ok).toBe(false)
    expect(activeSnapshot(db, 7)!.summary).toBe('снапшот №1') // старый цел и работает
  })

  it('ОТКАЗ МОДЕЛИ (summary не получен) → вызывающий просто не пишет; активный не меняется', () => {
    const m1 = msg(7, 'user', 'первое')
    saveSnapshot(db, { chatId: 7, summary: 'рабочий итог', throughMessageId: m1, sourceMaxMessageId: m1 }, 1000)
    // Провал генерации = отсутствие вызова saveSnapshot. Проверяем инвариант:
    expect(activeSnapshot(db, 7)!.summary).toBe('рабочий итог')
  })

  it('ПОВТОРНАЯ компакция поверх старой → активным становится новый, старый ЖИВ (аудит/откат)', () => {
    const m1 = msg(7, 'user', 'первое')
    saveSnapshot(db, { chatId: 7, summary: 'снапшот №1', throughMessageId: m1, sourceMaxMessageId: m1 }, 1000)
    const m2 = msg(7, 'assistant', 'второе')
    const res = saveSnapshot(db, { chatId: 7, summary: 'снапшот №2', throughMessageId: m2, sourceMaxMessageId: m2 }, 2000)

    expect(res.ok).toBe(true)
    expect(activeSnapshot(db, 7)!.summary).toBe('снапшот №2')
    const hist = snapshotHistory(db, 7)
    expect(hist).toHaveLength(2)
    expect(hist.map(h => h.summary)).toEqual(['снапшот №2', 'снапшот №1']) // старый не стёрт
  })

  it('РАЗНЫЕ чаты не мешают друг другу', () => {
    const a = msg(7, 'user', 'чат 7')
    const b = msg(8, 'user', 'чат 8')
    saveSnapshot(db, { chatId: 7, summary: 'итог 7', throughMessageId: a, sourceMaxMessageId: a }, 1000)
    saveSnapshot(db, { chatId: 8, summary: 'итог 8', throughMessageId: b, sourceMaxMessageId: b }, 1000)
    expect(activeSnapshot(db, 7)!.summary).toBe('итог 7')
    expect(activeSnapshot(db, 8)!.summary).toBe('итог 8')
    expect(snapshotHistory(db, 7)).toHaveLength(1) // чужие снапшоты не подмешались
  })

  it('РЕСТАРТ: снапшот переживает переоткрытие БД (ради этого всё и делалось)', () => {
    const m1 = msg(7, 'user', 'длинная история')
    saveSnapshot(db, { chatId: 7, summary: 'сжатый итог', throughMessageId: m1, sourceMaxMessageId: m1 }, 1000)
    const file = join(dir, 'test.db')
    db.close()
    db = openDb(file) // как будто перезапустили приложение
    expect(activeSnapshot(db, 7)!.summary).toBe('сжатый итог')
  })

  // Видимая переписка — святое: сжатие влияет только на то, что уходит модели.
  it('сообщения НЕ удаляются и не переписываются компакцией', () => {
    const m1 = msg(7, 'user', 'важное сообщение')
    saveSnapshot(db, { chatId: 7, summary: 'итог', throughMessageId: m1, sourceMaxMessageId: m1 }, 1000)
    const rows = db.prepare('SELECT id, content FROM chats WHERE session_id = 7').all() as Array<{ id: number; content: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('важное сообщение')
  })

  it('граница впереди прочитанного источника → отказ (защита от кривого вызова)', () => {
    const m1 = msg(7, 'user', 'первое')
    const res = saveSnapshot(db, { chatId: 7, summary: 'итог', throughMessageId: m1 + 5, sourceMaxMessageId: m1 }, 1000)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toBe('invalid-boundary')
  })

  it('maxMessageId: пустой чат → 0, иначе последний id', () => {
    expect(maxMessageId(db, 7)).toBe(0)
    msg(7, 'user', 'раз'); const last = msg(7, 'user', 'два')
    expect(maxMessageId(db, 7)).toBe(last)
  })
})
