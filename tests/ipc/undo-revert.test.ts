import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Тест safety-критичного отката revertToCheckpoint — основа crash-resume и
 * dev-task revert. Реальные временные файлы + реальный undo-стек: восстановление
 * к beforeContent, unlink нового файла (before=null), чекпоинт-гард (правки до
 * checkpointId не трогаются). undo.ts тянет electron.ipcMain — мокаем no-op.
 */
vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))

const { openDb } = await import('../../electron/storage/db')
const { createUndoStack } = await import('../../electron/storage/undo')
const { revertToCheckpoint } = await import('../../electron/ipc/undo')

describe('revertToCheckpoint (safety-критичный откат)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let stack: ReturnType<typeof createUndoStack>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-undo-'))
    db = openDb(join(dir, 'test.db'))
    stack = createUndoStack(db)
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('восстанавливает изменённый файл к beforeContent', async () => {
    writeFileSync(join(dir, 'a.txt'), 'modified')
    stack.push(dir, 'a.txt', 'original', 'modified')
    const res = await revertToCheckpoint(stack, dir, 0)
    expect(res.ok).toBe(true)
    expect(res.restored).toContain('a.txt')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('original')
  })

  it('удаляет новый файл (beforeContent=null → unlink)', async () => {
    // Новый файл в реальном API пушится с before=null → revert удаляет.
    writeFileSync(join(dir, 'new.txt'), 'content')
    stack.push(dir, 'new.txt', null, 'content')
    const res = await revertToCheckpoint(stack, dir, 0)
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, 'new.txt'))).toBe(false)
  })

  // B4: существовавший ПУСТОЙ файл (before='') раньше удалялся (конфликт с «не было»).
  it('восстанавливает существовавший пустой файл (before="") вместо удаления', async () => {
    writeFileSync(join(dir, 'empty.txt'), 'now has content')
    stack.push(dir, 'empty.txt', '', 'now has content')
    const res = await revertToCheckpoint(stack, dir, 0)
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, 'empty.txt'))).toBe(true)            // НЕ удалён
    expect(readFileSync(join(dir, 'empty.txt'), 'utf8')).toBe('')    // восстановлен пустым
  })

  it('чекпоинт-гард: правки до checkpointId не откатываются', async () => {
    writeFileSync(join(dir, 'a.txt'), 'v1')
    const e1 = stack.push(dir, 'a.txt', 'v0', 'v1')
    writeFileSync(join(dir, 'a.txt'), 'v2')
    stack.push(dir, 'a.txt', 'v1', 'v2')
    const res = await revertToCheckpoint(stack, dir, e1.id)
    expect(res.count).toBe(1)                                   // откачен только e2
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('v1') // к e2.before, не дальше v0
    expect(stack.list(dir).some(e => e.id === e1.id)).toBe(true) // e1 не тронут
  })

  // Усиление 23.06 (#1, ревью vs OpenClaw/OpenCode): inner catch глотал ВСЕ ошибки
  // unlink, не только ENOENT. При залоченном файле (EACCES/EBUSY/EPERM) запись
  // помечалась restored, хотя файл на месте → грязное дерево, ретрая нет.
  it('unlink-ошибка (не-ENOENT) → запись в failed[], НЕ restored', async () => {
    // before=null → revert хочет unlink. Делаем путь не-удаляемым: это каталог
    // (unlink каталога падает EPERM/EISDIR ≠ ENOENT). Должно уйти в failed[].
    mkdirSync(join(dir, 'locked.txt'))
    stack.push(dir, 'locked.txt', null, 'content')
    const res = await revertToCheckpoint(stack, dir, 0)
    expect(res.ok).toBe(false)
    expect(res.restored).not.toContain('locked.txt')
    expect(res.failed?.some(f => f.filePath === 'locked.txt')).toBe(true)
    expect(existsSync(join(dir, 'locked.txt'))).toBe(true) // не «удалён»
  })

  // ENOENT (файл уже отсутствует) по-прежнему = успех: цель (файла нет) достигнута.
  it('unlink ENOENT (файл уже отсутствует) → restored (цель достигнута)', async () => {
    stack.push(dir, 'ghost.txt', null, 'content') // файла НЕТ на диске
    const res = await revertToCheckpoint(stack, dir, 0)
    expect(res.ok).toBe(true)
    expect(res.restored).toContain('ghost.txt')
  })

  it('нечего откатывать (checkpoint = текущий top) → count 0', async () => {
    const e1 = stack.push(dir, 'a.txt', 'v0', 'v1')
    const res = await revertToCheckpoint(stack, dir, e1.id)
    expect(res.ok).toBe(true)
    expect(res.count).toBe(0)
  })
})
