import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createVerifications } from '../../electron/storage/verifications'

/**
 * Тесты storage-слоя Verification Artifact (Фаза 3) + миграции 17.
 * Падают по ABI (NODE_MODULE_VERSION) вместе с остальными sqlite-тестами —
 * это известный шум, не регрессия. Логику миграции/функций проверяем здесь.
 */
describe('verifications (migration 17)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-verif-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function baseRow(over: Partial<Parameters<ReturnType<typeof createVerifications>['insert']>[0]> = {}) {
    return {
      projectPath: '/p',
      chatId: 7,
      runId: 'r1',
      overall: 'passed' as const,
      checksTotal: 3,
      checksPassed: 3,
      changedFilesCount: 2,
      artifactPath: '/p/.verstak/artifacts/2026-06-16/task.verification.json',
      htmlPath: '/p/.verstak/artifacts/2026-06-16/task.verification.html',
      taskSummary: 'Сделал X',
      createdAt: Date.now(),
      ...over
    }
  }

  it('миграция 17 создаёт таблицу verifications', () => {
    const db = openDb(join(dir, 'test.db'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name)
    expect(tables).toContain('verifications')
    db.close()
  })

  it('insert → get: поля совпали (camelCase mapping)', () => {
    const db = openDb(join(dir, 'test.db'))
    const v = createVerifications(db)
    const id = v.insert(baseRow())
    const row = v.get(id)
    expect(row).not.toBeNull()
    expect(row!.id).toBe(id)
    expect(row!.projectPath).toBe('/p')
    expect(row!.chatId).toBe(7)
    expect(row!.runId).toBe('r1')
    expect(row!.overall).toBe('passed')
    expect(row!.checksTotal).toBe(3)
    expect(row!.checksPassed).toBe(3)
    expect(row!.changedFilesCount).toBe(2)
    expect(row!.htmlPath).toContain('.verification.html')
    expect(row!.taskSummary).toBe('Сделал X')
    db.close()
  })

  it('insert → latest по chatId возвращает свежайшую строку этого чата', () => {
    const db = openDb(join(dir, 'test.db'))
    const v = createVerifications(db)
    // Старая верификация чата 7.
    v.insert(baseRow({ overall: 'failed', checksPassed: 1, taskSummary: 'старая', createdAt: 1000 }))
    // Свежая верификация чата 7.
    v.insert(baseRow({ overall: 'passed', checksPassed: 3, taskSummary: 'свежая', createdAt: 2000 }))
    // Верификация ДРУГОГО чата (8) — не должна попасть в latest(7).
    v.insert(baseRow({ chatId: 8, taskSummary: 'чужой чат', createdAt: 3000 }))

    const latest = v.latest('/p', 7)
    expect(latest).not.toBeNull()
    expect(latest!.taskSummary).toBe('свежая')
    expect(latest!.overall).toBe('passed')

    // Без chatId — берёт свежайшую по всему проекту (чужой чат, createdAt=3000).
    const latestProject = v.latest('/p')
    expect(latestProject!.taskSummary).toBe('чужой чат')
    db.close()
  })

  it('latest возвращает null когда у чата нет верификаций', () => {
    const db = openDb(join(dir, 'test.db'))
    const v = createVerifications(db)
    v.insert(baseRow({ chatId: 7 }))
    expect(v.latest('/p', 999)).toBeNull()
    expect(v.latest('/other')).toBeNull()
    db.close()
  })

  it('list: новейшие первыми, в пределах проекта', () => {
    const db = openDb(join(dir, 'test.db'))
    const v = createVerifications(db)
    v.insert(baseRow({ taskSummary: 'A', createdAt: 1000 }))
    v.insert(baseRow({ taskSummary: 'B', createdAt: 2000 }))
    v.insert(baseRow({ projectPath: '/other', taskSummary: 'другой проект', createdAt: 3000 }))

    const rows = v.list('/p')
    expect(rows.map(r => r.taskSummary)).toEqual(['B', 'A'])
    db.close()
  })
})
