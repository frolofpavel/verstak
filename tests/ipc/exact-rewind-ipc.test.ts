import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Срез 2.0.11-F: IPC-проводка Exact Rewind ЗА ФЛАГОМ.
 *
 * ГЛАВНОЕ, что здесь проверяется: с выключенным флагом (состояние поставки) НИ ОДИН
 * мутирующий путь не срабатывает — ни preflight, ни execute, ни unrevert. Фича собрана,
 * но спит, пока Павел вручную не включит и не проверит на Windows.
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
let flag: string | null

const register = () => {
  handlers.clear()
  registerExactRewindIpc({
    undoStack: undo,
    getKey: () => flag,
    getProjectRoot: () => dir,
    hasBypassWriters: () => false,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vst-rewind-ipc-'))
  db = openDb(join(dir, 'test.db'))
  undo = createUndoStack(db)
  flag = null // фича ВЫКЛЮЧЕНА по умолчанию
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Exact Rewind IPC — за флагом', () => {
  it('флаг OFF → preflight отказывает (disabled), ничего не считает', async () => {
    register()
    const r = await handlers.get('exact-rewind:preflight')!({}, 0) as { disabled?: boolean }
    expect(r.disabled).toBe(true)
  })

  it('флаг OFF → execute НЕ трогает файлы', async () => {
    writeFileSync(join(dir, 'a.ts'), 'новое')
    undo.push(dir, 'a.ts', 'старое', 'новое', { runId: 'r', chatId: 1, messageId: 1 })
    register()

    const r = await handlers.get('exact-rewind:execute')!({}, 0) as { disabled?: boolean }
    expect(r.disabled).toBe(true)
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('новое') // файл НЕ откачен
  })

  it('флаг ON → preflight считает превью (реальные хеши файлов)', async () => {
    writeFileSync(join(dir, 'a.ts'), 'новое')
    undo.push(dir, 'a.ts', 'старое', 'новое', { runId: 'r', chatId: 1, messageId: 1 })
    flag = 'true'
    register()

    const r = await handlers.get('exact-rewind:preflight')!({}, 0) as { disabled?: boolean; coverage?: { level: string }; files?: unknown[] }
    expect(r.disabled).toBeFalsy()
    expect(r.coverage?.level).toBe('complete') // файл не переписан
    expect(r.files).toHaveLength(1)
  })

  // Полный цикл под включённым флагом: preflight → execute → файл откачен → unrevert вернул.
  it('флаг ON → execute откатывает, unrevert возвращает (round-trip через IPC)', async () => {
    writeFileSync(join(dir, 'a.ts'), 'новое')
    undo.push(dir, 'a.ts', 'старое', 'новое', { runId: 'r', chatId: 1, messageId: 1 })
    flag = 'true'
    register()

    const exec = await handlers.get('exact-rewind:execute')!({}, 0) as { ok?: boolean; backups?: Record<string, string | null> }
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('старое') // откат применён

    await handlers.get('exact-rewind:unrevert')!({}, exec.backups)
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('новое') // unrevert вернул
  })

  it('флаг ON, создание файла → execute удаляет, unrevert воссоздаёт', async () => {
    writeFileSync(join(dir, 'new.ts'), 'создано')
    undo.push(dir, 'new.ts', null, 'создано', { runId: 'r', chatId: 1, messageId: 1 })
    flag = 'true'
    register()

    const exec = await handlers.get('exact-rewind:execute')!({}, 0) as { backups?: Record<string, string | null> }
    expect(existsSync(join(dir, 'new.ts'))).toBe(false) // удалён откатом

    await handlers.get('exact-rewind:unrevert')!({}, exec.backups)
    expect(readFileSync(join(dir, 'new.ts'), 'utf8')).toBe('создано') // воссоздан
  })
})
