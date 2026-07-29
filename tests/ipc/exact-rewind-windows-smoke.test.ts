import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * WINDOWS-SMOKE Exact Rewind (хвост 2.0.11-F, поручение Павла 25.07 — «сделай сам»).
 * Ручной клик-smoke Павла в приложении это НЕ заменяет — здесь механика на враждебных
 * Windows-условиях через НАСТОЯЩИЕ IPC-хендлеры (mock только ipcMain, fs и БД реальные):
 *  1. CRLF/юникод/большой файл — round-trip execute→unrevert байт-в-байт.
 *  2. READONLY-файл — реальный сбой записи (EACCES) → частичный execute → unrevert
 *     возвращает остальные байт-в-байт, readonly не тронут (сценарий «не удалось N файлов»).
 *  3. Глубокие вложенные пути — restore и delete-created в nested-дереве.
 */

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  app: { getPath: () => tmpdir() },
}))

const { openDb } = await import('../../electron/storage/db')
const { createUndoStack } = await import('../../electron/storage/undo')
const { registerExactRewindIpc } = await import('../../electron/ipc/exact-rewind-ipc')

let dir: string
let db: DB
let undo: ReturnType<typeof createUndoStack>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vst-rewind-winsmoke-'))
  db = openDb(join(dir, 'test.db'))
  undo = createUndoStack(db)
  handlers.clear()
  registerExactRewindIpc({
    undoStack: undo,
    getKey: () => 'true', // флаг ON — smoke идёт по включённой фиче
    getProjectRoot: () => dir,
    hasBypassWriters: () => false,
  })
})
afterEach(() => {
  db.close()
  // readonly-файлы Windows не даёт удалить — снимаем атрибут перед зачисткой
  try { chmodSync(join(dir, 'locked.ts'), 0o666) } catch { /* мог и не создаться */ }
  rmSync(dir, { recursive: true, force: true })
})

const preflight = (checkpointId: number) =>
  handlers.get('exact-rewind:preflight')!({}, checkpointId) as Promise<{ disabled?: boolean; files?: Array<{ filePath: string }> }>
const execute = (checkpointId: number) =>
  handlers.get('exact-rewind:execute')!({}, checkpointId) as Promise<{
    ok?: boolean
    restored?: string[]
    failed?: Array<{ filePath: string; reason: string }>
    // Контракт с 30.07 (SEC-SECRET-04): содержимое бэкапов остаётся в main, наружу токен.
    backupToken?: string
  }>
const unrevert = (backupToken: string) =>
  handlers.get('exact-rewind:unrevert')!({}, backupToken) as Promise<{ ok?: boolean }>

describe('Exact Rewind — Windows smoke (флаг ON, реальные IPC+fs)', () => {
  it('CRLF + юникод + килобайты текста: execute→unrevert байт-в-байт', async () => {
    const before = 'первая строка\r\nвторая строка с «кавычками»\r\n' + 'x'.repeat(8192) + '\r\n'
    const after = 'agent rewrote\nall lines\n'
    writeFileSync(join(dir, 'crlf.ts'), after)
    undo.push(dir, 'crlf.ts', before, after, { runId: 'r', chatId: 1, messageId: 1 })

    const pre = await preflight(0)
    expect(pre.disabled).toBeFalsy()
    expect(pre.files).toHaveLength(1)

    const exec = await execute(0)
    expect(exec.failed).toEqual([])
    expect(readFileSync(join(dir, 'crlf.ts'), 'utf8')).toBe(before) // CRLF вернулись как были

    await unrevert(exec.backupToken!)
    expect(readFileSync(join(dir, 'crlf.ts'), 'utf8')).toBe(after) // и обратно байт-в-байт
  })

  it('readonly-файл ломает запись → частичный сбой → unrevert честно возвращает остальное', async () => {
    writeFileSync(join(dir, 'ok.ts'), 'ok-new')
    undo.push(dir, 'ok.ts', 'ok-old', 'ok-new', { runId: 'r', chatId: 1, messageId: 1 })
    writeFileSync(join(dir, 'locked.ts'), 'locked-new')
    chmodSync(join(dir, 'locked.ts'), 0o444) // Windows: запись в readonly → EACCES
    undo.push(dir, 'locked.ts', 'locked-old', 'locked-new', { runId: 'r', chatId: 1, messageId: 1 })

    const exec = await execute(0)
    // ok.ts откатился, locked.ts — честный failed (а не тихая поломка), бэкапы есть по обоим
    expect(exec.restored).toEqual(['ok.ts'])
    expect(exec.failed?.map(f => f.filePath)).toEqual(['locked.ts'])
    expect(exec.ok).toBe(false)
    expect(readFileSync(join(dir, 'ok.ts'), 'utf8')).toBe('ok-old')
    expect(readFileSync(join(dir, 'locked.ts'), 'utf8')).toBe('locked-new') // не тронут

    // Сценарий «не удалось N файлов → вернуть как было»: unrevert откатывает откат.
    // Readonly-файл вернуть нельзя (тот же EPERM) — но он НЕ должен ронять возврат
    // остальных: ok.ts восстановлен, про locked.ts — честная ошибка (раньше unrevert
    // умирал на первом сбойном, бросая остальные в откаченном состоянии).
    const back = await unrevert(exec.backupToken!) as { ok?: boolean; error?: string }
    expect(back.ok).toBe(false)
    expect(back.error).toContain('locked.ts')
    expect(readFileSync(join(dir, 'ok.ts'), 'utf8')).toBe('ok-new')
    expect(readFileSync(join(dir, 'locked.ts'), 'utf8')).toBe('locked-new')
  })

  it('глубокая вложенность: restore и delete-created работают в nested-дереве', async () => {
    const nested = join(dir, 'src', 'deep', 'nested', 'path')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'changed.ts'), 'new')
    undo.push(dir, join('src', 'deep', 'nested', 'path', 'changed.ts'), 'old', 'new', { runId: 'r', chatId: 1, messageId: 1 })
    writeFileSync(join(nested, 'created.ts'), 'created')
    undo.push(dir, join('src', 'deep', 'nested', 'path', 'created.ts'), null, 'created', { runId: 'r', chatId: 1, messageId: 1 })

    const exec = await execute(0)
    expect(exec.failed).toEqual([])
    expect(readFileSync(join(nested, 'changed.ts'), 'utf8')).toBe('old')
    expect(existsSync(join(nested, 'created.ts'))).toBe(false)

    await unrevert(exec.backupToken!)
    expect(readFileSync(join(nested, 'changed.ts'), 'utf8')).toBe('new')
    expect(readFileSync(join(nested, 'created.ts'), 'utf8')).toBe('created')
  })
})
