// SEC-SECRET-03 · стек отката наружу содержимого не отдаёт.
//
// Хвост правки 29.07 и следствие ИМЕННО ЕЁ. До неё в стеке отката лежало
// отредактированное содержимое (`[REDACTED:…]`) — потому откат и уничтожал
// секрет. Починка сделала «до» СЫРЫМ, и это правильно: только так откат
// возвращает живое значение. Но тем самым в стеке появились настоящие секреты
// пользователя, а канал `undo:list` отдавал записи ЦЕЛИКОМ, вместе с
// `beforeContent`/`afterContent`.
//
// ВЫБРАН ОТКАЗ, А НЕ МАСКА, и вот почему. Дифф подтверждения маскируют потому,
// что его ПОКАЗЫВАЮТ: человек по нему принимает решение, значит нужна
// информативная замена. Здесь показывать нечего — содержимое из этого канала не
// читает никто: вызовов `undo.list` в renderer ноль, а весь откат
// (`undo:revert`, `undo:revertToCheckpoint`, exact-rewind, dev-task) работает со
// стеком внутри main напрямую. Маскировать неиспользуемое значило бы гонять файл
// целиком через IPC без пользы и оставить сигнал «это безопасно показывать»,
// приглашая будущего потребителя отрисовать блоб не думая.
//
// «Вызовов нет» НЕ причина отложить: канал в preload есть, и первый вызывающий
// придёт, не зная истории.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } }
}))

const { openDb } = await import('../../electron/storage/db')
const { createUndoStack } = await import('../../electron/storage/undo')
const { registerUndoIpc, revertToCheckpoint } = await import('../../electron/ipc/undo')

const SECRET = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGA7F2'
const RAW_BEFORE = `export const config = {\n  key: '${SECRET}',\n}\n`
const AFTER = `export const config = {\n  key: '${SECRET}',\n  timeout: 60,\n}\n`

let dir: string
let db: DB
let stack: ReturnType<typeof createUndoStack>

beforeEach(() => {
  handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'vst-undolist-'))
  db = openDb(join(dir, 'test.db'))
  stack = createUndoStack(db)
  registerUndoIpc(stack)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const list = () => handlers.get('undo:list')!(null, dir) as Array<Record<string, unknown>>

describe('SEC-SECRET-03 · undo:list не выносит содержимое из main', () => {
  // ОБЯЗАТЕЛЬНЫЙ пин: сырой секрет не выходит наружу.
  it('сырой секрет не выходит из main через undo:list', () => {
    stack.push(dir, 'config.ts', RAW_BEFORE, AFTER)

    const dump = JSON.stringify(list())

    expect(dump, 'сырой секрет уехал в renderer через стек отката').not.toContain(SECRET)
    expect(dump, 'содержимое файла уехало в renderer').not.toContain('export const config')
  })

  it('полей содержимого в ответе нет вовсе — маскировать нечего', () => {
    stack.push(dir, 'config.ts', RAW_BEFORE, AFTER)

    const [row] = list()

    expect(Object.keys(row).sort()).toEqual([
      'afterHash', 'beforeHash', 'chatId', 'createdAt', 'existedBefore',
      'filePath', 'id', 'messageId', 'runId'
    ])
  })

  // КОНТРОЛЬ. Без него пин выше был бы зелёным и на СЛОМАННОМ откате: если бы
  // содержимое перестало храниться вовсе, наружу оно тоже не вышло бы — и мы
  // «починили» бы утечку ценой возврата того самого дефекта.
  it('контроль: внутри main стек по-прежнему хранит СЫРОЕ содержимое', () => {
    stack.push(dir, 'config.ts', RAW_BEFORE, AFTER)

    const [entry] = stack.list(dir)

    expect(entry.beforeContent, 'откат потерял живое значение').toBe(RAW_BEFORE)
    expect(entry.beforeContent).toContain(SECRET)
  })

  // Сквозная проверка того же: откат по-прежнему возвращает на диск ЖИВОЙ
  // секрет. Проекция стоит на границе IPC и самого отката не касается.
  it('откат восстанавливает живой секрет на диск', async () => {
    const file = join(dir, 'config.ts')
    writeFileSync(file, AFTER, 'utf8')
    stack.push(dir, 'config.ts', RAW_BEFORE, AFTER)

    const res = await revertToCheckpoint(stack, dir, 0)

    expect(res.ok).toBe(true)
    expect(readFileSync(file, 'utf8'), 'откат затёр секрет').toBe(RAW_BEFORE)
  })

  // Единственное, что решение об откате берёт из содержимого: файла не было →
  // откат его УДАЛИТ, а не восстановит пустым. Флаг обязан пережить проекцию,
  // иначе будущий экран истории не отличит создание от правки.
  it('«файла не было» доезжает флагом, а не выводится из хешей', () => {
    stack.push(dir, 'created.ts', null, 'new')
    stack.push(dir, 'changed.ts', '', 'x')

    const rows = list()
    const created = rows.find(r => r.filePath === 'created.ts')!
    const changed = rows.find(r => r.filePath === 'changed.ts')!

    expect(created.existedBefore, 'созданный файл выглядит как изменённый — откат его не удалит').toBe(false)
    // Пустой существовавший файл — не «его не было» (B4).
    expect(changed.existedBefore, 'пустой существовавший файл принят за несуществовавший').toBe(true)
  })
})
