// SEC-SECRET-04 · exact-rewind не выносит содержимое файлов из main.
//
// Дореформенный путь той же природы, что undo:list (SEC-SECRET-03): после правки
// 29.07 стек отката хранит СЫРОЕ содержимое, и `exact-rewind:execute` отдавал в
// renderer `backups` — снимок ВСЕХ откатываемых файлов целиком, с живыми
// секретами. Renderer это содержимое никому не показывает (превью и confirm
// строятся из счётчиков и путей) — он лишь гонял его обратно в
// `exact-rewind:unrevert`.
//
// ВЫБРАН ОТКАЗ, А НЕ МАСКА, по тому же признаку, что в SEC-SECRET-03: маскируют
// то, что ПОКАЗЫВАЮТ человеку и по чему он принимает решение. Здесь человек
// решения по содержимому не принимает — значит содержимому нечего делать за
// границей main. Бэкапы остаются в main под одноразовым токеном; renderer
// ссылается токеном. Заодно закрылся и обратный канал: прежний unrevert принимал
// произвольный Record<путь, содержимое> ИЗ renderer — примитив записи любого
// файла проекта в обход подтверждений.
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
const { registerExactRewindIpc } = await import('../../electron/ipc/exact-rewind-ipc')

const SECRET = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGA7F2'
/** Состояние на момент чекпоинта — то, что откат вернёт на диск. */
const RAW_BEFORE = `export const config = {\n  key: '${SECRET}',\n}\n`
/** Текущее состояние — то, что уходит в бэкап и возвращается unrevert'ом. */
const AFTER = `export const config = {\n  key: '${SECRET}',\n  timeout: 60,\n}\n`

let dir: string
let db: DB
let stack: ReturnType<typeof createUndoStack>

beforeEach(() => {
  handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'vst-rewind-sec-'))
  db = openDb(join(dir, 'test.db'))
  stack = createUndoStack(db)
  registerExactRewindIpc({
    undoStack: stack,
    getKey: () => 'true', // флаг ON: выключенный путь отвечает { disabled } и не проверяет ничего
    getProjectRoot: () => dir,
    hasBypassWriters: () => false
  })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const execute = () => handlers.get('exact-rewind:execute')!({}, 0) as Promise<Record<string, unknown>>
const unrevert = (token: unknown) => handlers.get('exact-rewind:unrevert')!({}, token) as Promise<{ ok?: boolean }>

const seed = () => {
  writeFileSync(join(dir, 'config.ts'), AFTER, 'utf8')
  stack.push(dir, 'config.ts', RAW_BEFORE, AFTER, { runId: 'r', chatId: 1, messageId: 1 })
}

describe('SEC-SECRET-04 · exact-rewind:execute не выносит содержимое из main', () => {
  // ОБЯЗАТЕЛЬНЫЙ пин: сырой секрет не выходит наружу.
  it('сырой секрет не выходит из main через exact-rewind:execute', async () => {
    seed()

    const dump = JSON.stringify(await execute())

    expect(dump, 'сырой секрет уехал в renderer в бэкапах отката').not.toContain(SECRET)
    expect(dump, 'содержимое файла уехало в renderer').not.toContain('export const config')
  })

  it('поля backups в ответе нет вовсе — вместо него одноразовый токен', async () => {
    seed()

    const res = await execute()

    expect(res, 'содержимое по-прежнему в ответе').not.toHaveProperty('backups')
    expect(typeof res.backupToken, 'ссылки на бэкап нет — unrevert стал невозможен').toBe('string')
  })

  // КОНТРОЛЬ, парный к пинам утечки. Без него «утечку» можно закрыть, перестав
  // хранить бэкапы вовсе: пины выше остались бы зелёными, а «вернуть как было»
  // молча перестало бы возвращать. Мутация «хранить пустой бэкап» обязана
  // краснить именно этот пин при зелёных пинах утечки.
  it('контроль: бэкап ЖИВ внутри main — unrevert по токену возвращает файл с секретом', async () => {
    seed()
    const res = await execute()
    expect(readFileSync(join(dir, 'config.ts'), 'utf8'), 'сам откат не сработал').toBe(RAW_BEFORE)

    const back = await unrevert(res.backupToken)

    expect(back.ok, 'unrevert по токену не сработал').toBe(true)
    expect(readFileSync(join(dir, 'config.ts'), 'utf8'), 'бэкап внутри main мёртв — вернуть как было нечем').toBe(AFTER)
  })

  it('созданный файл: откат удаляет, unrevert по токену воссоздаёт', async () => {
    writeFileSync(join(dir, 'new.ts'), 'создано', 'utf8')
    stack.push(dir, 'new.ts', null, 'создано', { runId: 'r', chatId: 1, messageId: 1 })

    const res = await execute()
    const back = await unrevert(res.backupToken)

    expect(back.ok).toBe(true)
    expect(readFileSync(join(dir, 'new.ts'), 'utf8')).toBe('создано')
  })

  // Токен одноразовый и единственный: чужая строка не даёт ни записи, ни чтения.
  // Контрольная пара к «unrevert по токену работает» — иначе проверка отказа
  // была бы зелёной и у хендлера, который игнорирует аргумент вовсе.
  it('unrevert с неизвестным токеном отказывает и файлов не трогает', async () => {
    seed()
    await execute()
    const rewound = readFileSync(join(dir, 'config.ts'), 'utf8')

    const back = await unrevert('not-a-real-token')

    expect(back.ok, 'unrevert принял чужой токен').toBe(false)
    expect(readFileSync(join(dir, 'config.ts'), 'utf8'), 'файл изменён по чужому токену').toBe(rewound)
  })

  it('токен одноразовый: повторный unrevert отказывает', async () => {
    seed()
    const res = await execute()

    expect((await unrevert(res.backupToken)).ok).toBe(true)
    expect((await unrevert(res.backupToken)).ok, 'использованный токен сработал второй раз').toBe(false)
  })
})
