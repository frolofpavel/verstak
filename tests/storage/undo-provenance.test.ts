import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { openDb } from '../../electron/storage/db'
import { createUndoStack } from '../../electron/storage/undo'

/**
 * Срез 2.0.11-E: провенанс отката файлов.
 *
 * Каждая undo-запись обогащается: КТО её сделал (run_id / chat_id / message_id) и хеши
 * содержимого до/после. Провенанс — фундамент честного отката: по нему видно, какой
 * прогон что менял, а по хешам — не переписал ли файл кто-то ПОСЛЕ (тогда откат перезатрёт
 * чужое). Колонки nullable (append-only миграция): legacy-записи и записи без контекста
 * остаются валидными, просто «непротрассированными».
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

let dir: string
let db: DB
let undo: ReturnType<typeof createUndoStack>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vst-undoprov-'))
  db = openDb(join(dir, 'test.db'))
  undo = createUndoStack(db)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('провенанс undo-записи (2.0.11-E)', () => {
  it('миграция добавила колонки провенанса (append-only)', () => {
    const cols = (db.prepare('PRAGMA table_info(file_undo)').all() as Array<{ name: string }>).map(c => c.name)
    for (const c of ['run_id', 'chat_id', 'message_id', 'before_hash', 'after_hash']) {
      expect(cols, `колонка ${c}`).toContain(c)
    }
  })

  it('push с провенансом сохраняет КТО менял файл', () => {
    const entry = undo.push('/p', 'a.ts', 'старое', 'новое', { runId: 'run-1', chatId: 7, messageId: 42 })
    expect(entry.runId).toBe('run-1')
    expect(entry.chatId).toBe(7)
    expect(entry.messageId).toBe(42)
  })

  it('push считает хеши содержимого до/после (для проверки «файл не переписан»)', () => {
    const entry = undo.push('/p', 'a.ts', 'старое', 'новое', { runId: 'run-1', chatId: 7, messageId: 42 })
    expect(entry.beforeHash).toBe(sha('старое'))
    expect(entry.afterHash).toBe(sha('новое'))
  })

  it('создание файла (before null) → beforeHash null, afterHash есть', () => {
    const entry = undo.push('/p', 'new.ts', null, 'содержимое', { runId: 'r', chatId: 1, messageId: 2 })
    expect(entry.beforeHash).toBeNull()
    expect(entry.afterHash).toBe(sha('содержимое'))
  })

  // Legacy / непротрассированный writer: провенанса нет → колонки NULL, запись валидна.
  it('push без провенанса → непротрассированная запись (провенанс null)', () => {
    const entry = undo.push('/p', 'a.ts', 'x', 'y')
    expect(entry.runId).toBeNull()
    expect(entry.chatId).toBeNull()
    expect(entry.messageId).toBeNull()
    // хеши считаются всегда (не зависят от провенанса).
    expect(entry.afterHash).toBe(sha('y'))
  })

  it('list возвращает провенанс', () => {
    undo.push('/p', 'a.ts', 'x', 'y', { runId: 'run-9', chatId: 3, messageId: 5 })
    const [row] = undo.list('/p')
    expect(row.runId).toBe('run-9')
    expect(row.afterHash).toBe(sha('y'))
  })

  it('pop возвращает провенанс (для отката с проверкой хеша)', () => {
    const e = undo.push('/p', 'a.ts', 'x', 'y', { runId: 'run-9', chatId: 3, messageId: 5 })
    const popped = undo.pop(e.id)
    expect(popped?.runId).toBe('run-9')
    expect(popped?.afterHash).toBe(sha('y'))
  })
})
