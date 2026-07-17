import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Срез 2.0.11-C: безопасный экспорт транскрипта через save-диалог.
 *
 * Требования карточки, которые здесь проверяются:
 *  · renderer НЕ передаёт произвольный путь записи — только chatId; путь выбирает
 *    пользователь в нативном диалоге (main). Иначе renderer мог бы писать куда угодно.
 *  · отмена диалога = { cancelled: true }, НЕ error (человек передумал — это не сбой).
 *  · путь и секрет вычищены в файле (нормализация приватности + scanText).
 */

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const dialogMock = { showSaveDialog: vi.fn() }
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  app: { getPath: () => tmpdir() },
  dialog: dialogMock,
}))

const { openDb } = await import('../../electron/storage/db')
const { createChats } = await import('../../electron/storage/chats')
const { createChatSessions } = await import('../../electron/storage/chat-sessions')
const { registerHandoffIpc } = await import('../../electron/ipc/handoff')

let dir: string
let db: DB
let outPath: string

beforeEach(() => {
  handlers.clear()
  dialogMock.showSaveDialog.mockReset()
  dir = mkdtempSync(join(tmpdir(), 'vst-export-'))
  outPath = join(dir, 'экспорт.md')
  db = openDb(join(dir, 'test.db'))
  const chats = createChats(db)
  const sessions = createChatSessions(db)
  registerHandoffIpc(chats, sessions, undefined, {
    getKnownRoots: () => ['C:\\Users\\Pavel\\Progetc\\Проекты\\verstak'],
    getHomeDir: () => 'C:\\Users\\Pavel',
    getWindow: () => null,
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const seed = (): number => {
  const chats = createChats(db)
  const sessions = createChatSessions(db)
  const s = sessions.create('C:\\Users\\Pavel\\Progetc\\Проекты\\verstak', { title: 'Сессия' })
  chats.appendToSession(s.id, 'C:\\Users\\Pavel\\Progetc\\Проекты\\verstak', 'user',
    'ключ sk-ant-api03-SECRETSECRETSECRET1234567890 в C:\\Users\\Pavel\\Downloads\\cfg.json')
  return s.id
}

describe('transcript:export — безопасный экспорт с диалогом', () => {
  it('handler принимает ТОЛЬКО chatId — renderer не задаёт путь записи', () => {
    const fn = handlers.get('transcript:export')!
    // Сигнатура: (event, chatId). Путь не в аргументах — его даёт диалог в main.
    expect(fn.length).toBeLessThanOrEqual(2)
  })

  it('отмена диалога → cancelled, НЕ error, файл не создан', async () => {
    const chatId = seed()
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })

    const r = await handlers.get('transcript:export')!({}, chatId) as { ok: boolean; cancelled?: boolean; error?: string }

    expect(r.ok).toBe(false)
    expect(r.cancelled).toBe(true)
    expect(r.error).toBeUndefined()
  })

  it('выбор пути → файл записан по ВЫБРАННОМУ пути, приватность вычищена', async () => {
    const chatId = seed()
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outPath })

    const r = await handlers.get('transcript:export')!({}, chatId) as { ok: boolean; path?: string }

    expect(r.ok).toBe(true)
    expect(r.path).toBe(outPath)
    expect(existsSync(outPath)).toBe(true)

    const written = readFileSync(outPath, 'utf8')
    expect(written).not.toContain('SECRETSECRETSECRET') // секрет вычищен
    expect(written).not.toContain('Pavel')              // имя пользователя вычищено
    expect(written).toContain('~\\Downloads\\cfg.json')  // путь нормализован
  })

  it('диалог получает разумный defaultPath и .md-фильтр', async () => {
    const chatId = seed()
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true })
    await handlers.get('transcript:export')!({}, chatId)

    const opts = dialogMock.showSaveDialog.mock.calls[0].at(-1) as { defaultPath?: string; filters?: Array<{ extensions: string[] }> }
    expect(opts.defaultPath).toMatch(/\.md$/)
    expect(opts.filters?.some(f => f.extensions.includes('md'))).toBe(true)
  })

  it('ошибка записи (несуществующая папка) → error, не падение', async () => {
    const chatId = seed()
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(dir, 'нет', 'такой', 'папки.md') })

    const r = await handlers.get('transcript:export')!({}, chatId) as { ok: boolean; error?: string; cancelled?: boolean }
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(r.cancelled).toBeUndefined()
  })

  it('пустой/неизвестный chatId не роняет — экспортирует пустой транскрипт', async () => {
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outPath })
    const r = await handlers.get('transcript:export')!({}, 999999) as { ok: boolean }
    expect(r.ok).toBe(true)
  })
})
