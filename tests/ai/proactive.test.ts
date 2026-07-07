import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../electron/storage/db'
import { generateSuggestions } from '../../electron/ai/proactive'

describe('proactive suggestions', () => {
  let dir: string
  let db: ReturnType<typeof openDb>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-proactive-'))
    db = openDb(join(dir, 't.db'))
  })

  afterEach(() => {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not show raw session-summary JSON as a continue suggestion', () => {
    db.prepare(`
      INSERT INTO journal (project_path, kind, title, detail, created_at)
      VALUES (?, 'session', ?, ?, ?)
    `).run(
      '/p',
      'Сводка дня - 01.07.2026',
      JSON.stringify({
        version: 1,
        type: 'session-summary',
        reason: 'day',
        remaining: 'служебное поле не должно стать подсказкой'
      }),
      1
    )

    db.prepare(`
      INSERT INTO journal (project_path, kind, title, detail, created_at)
      VALUES (?, 'session', ?, ?, ?)
    `).run('/p', 'Проверить объявления', 'TODO: допроверить РСЯ', 2)

    const suggestions = generateSuggestions(db, '/p')

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].title).toContain('Проверить объявления')
    expect(suggestions[0].description).not.toContain('"type"')
  })
})
