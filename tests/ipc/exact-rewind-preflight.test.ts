import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { openDb } from '../../electron/storage/db'
import { createUndoStack } from '../../electron/storage/undo'
import { preflightRewind } from '../../electron/ipc/exact-rewind'

/**
 * Срез 2.0.11-F: Exact Rewind — PREFLIGHT (без единой записи).
 *
 * Показать ЧЕСТНО, что произойдёт при откате, ДО действия: какие файлы восстановятся/
 * удалятся, насколько полно (уровень из E), какие файлы кто-то переписал после нас.
 * Preflight ТОЛЬКО читает — ни одной записи на диск/в БД (иначе это уже не preview).
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

let dir: string
let db: DB
let undo: ReturnType<typeof createUndoStack>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vst-preflight-'))
  db = openDb(join(dir, 'test.db'))
  undo = createUndoStack(db)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// Хеш «текущего файла» — инъекция вместо fs (в проде sha256 содержимого).
const hashMap = (m: Record<string, string | null>) => async (filePath: string) => m[filePath] ?? null

describe('preflightRewind — превью отката', () => {
  it('всё под контролем, файлы не переписаны → complete + список восстановления', async () => {
    undo.push('/p', 'a.ts', 'старое-a', 'новое-a', { runId: 'run-1', chatId: 1, messageId: 1 })
    undo.push('/p', 'b.ts', null, 'новое-b', { runId: 'run-1', chatId: 1, messageId: 2 })

    const r = await preflightRewind(undo, '/p', 0, {
      hashFile: hashMap({ 'a.ts': sha('новое-a'), 'b.ts': sha('новое-b') }),
      hasBypassWriters: false,
    })

    expect(r.coverage.level).toBe('complete')
    expect(r.files).toHaveLength(2)
    // a.ts восстанавливается (было содержимое), b.ts удаляется (создавался, before null).
    expect(r.files.find(f => f.filePath === 'a.ts')?.action).toBe('restore')
    expect(r.files.find(f => f.filePath === 'b.ts')?.action).toBe('delete')
  })

  it('файл переписан после нас → помечен stale, уровень partial', async () => {
    undo.push('/p', 'a.ts', 'старое', 'новое', { runId: 'run-1', chatId: 1, messageId: 1 })

    const r = await preflightRewind(undo, '/p', 0, {
      hashFile: hashMap({ 'a.ts': sha('КТО-ТО-ПЕРЕПИСАЛ') }),
      hasBypassWriters: false,
    })

    expect(r.coverage.level).toBe('partial')
    expect(r.files.find(f => f.filePath === 'a.ts')?.stale).toBe(true)
  })

  // Прогон менял файлы мимо нас (run_command/CLI) → честно partial, не complete.
  it('bypass-writers → partial (полный откат обещать нельзя)', async () => {
    undo.push('/p', 'a.ts', 'старое', 'новое', { runId: 'run-1', chatId: 1, messageId: 1 })

    const r = await preflightRewind(undo, '/p', 0, {
      hashFile: hashMap({ 'a.ts': sha('новое') }),
      hasBypassWriters: true,
    })

    expect(r.coverage.level).toBe('partial')
    expect(r.coverage.hasUntracedWriters).toBe(true)
  })

  it('нечего откатывать → none, пустой список', async () => {
    const r = await preflightRewind(undo, '/p', 0, { hashFile: hashMap({}), hasBypassWriters: false })
    expect(r.coverage.level).toBe('none')
    expect(r.files).toHaveLength(0)
  })

  // КЛЮЧЕВОЕ: preflight ничего не пишет — стек нетронут после превью.
  it('preflight НЕ трогает undo-стек (только превью)', async () => {
    undo.push('/p', 'a.ts', 'старое', 'новое', { runId: 'run-1', chatId: 1, messageId: 1 })
    const before = undo.count('/p')

    await preflightRewind(undo, '/p', 0, { hashFile: hashMap({ 'a.ts': sha('новое') }), hasBypassWriters: false })

    expect(undo.count('/p')).toBe(before) // записи на месте, ничего не pop'нуто
  })

  it('откат только записей после чекпоинта (id > checkpointId)', async () => {
    const e1 = undo.push('/p', 'a.ts', 'a0', 'a1', { runId: 'r', chatId: 1, messageId: 1 })
    undo.push('/p', 'b.ts', 'b0', 'b1', { runId: 'r', chatId: 1, messageId: 2 })

    const r = await preflightRewind(undo, '/p', e1.id, {
      hashFile: hashMap({ 'a.ts': sha('a1'), 'b.ts': sha('b1') }),
      hasBypassWriters: false,
    })
    // Только b.ts (id > e1.id); a.ts (id == checkpoint) не откатывается.
    expect(r.files.map(f => f.filePath)).toEqual(['b.ts'])
  })
})
