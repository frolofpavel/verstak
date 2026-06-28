import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { listMemories } from '../../electron/storage/memories'
import { summarizeAndSaveSession } from '../../electron/ai/session-summary'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Резюме сессии встраивает сырые user-сообщения (Темы) в память. Если юзер вставил
// токен/ключ в чат — без редакции он осядет в памяти и всплывёт в recall → system
// prompt внешнего провайдера (ревью ТОП-3: HIGH утечка секрета). Фикс — scanText.
describe('summarizeAndSaveSession — редакция секретов', () => {
  let dir: string
  let db: DB

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-ss-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('GitHub-токен из user-сообщения редактится в сохранённом резюме', () => {
    const token = 'ghp_' + 'A'.repeat(36)
    summarizeAndSaveSession(db, 1, '/proj', [
      { role: 'user', content: `подключись с токеном ${token} к репо` },
      { role: 'assistant', content: 'ок' },
      { role: 'user', content: 'дальше' },
      { role: 'assistant', content: 'готово' },
    ])
    const saved = listMemories(db, '/proj')
    expect(saved).toHaveLength(1)
    expect(saved[0].content).not.toContain(token)
    expect(saved[0].content).toContain('[REDACTED')
  })
})
