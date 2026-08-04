import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createUserWorkflows } from '../../electron/storage/user-workflows'

// Задача 7A: user_workflows (миграция 61) — CRUD пользовательских workflow.
describe('user_workflows storage (задача 7A)', () => {
  let dir: string
  let db: Database
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-uwf-')); db = openDb(join(dir, 'test.db')) })
  afterEach(() => { try { db.close() } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }) })

  const steps = [
    { id: 's1', title: 'Собрать', instruction: 'Собери метрики' },
    { id: 's2', title: 'Свести', instruction: 'Сведи отчёт' },
  ]

  it('миграция 61 создаёт таблицу; save → list → get с распарсенными шагами', () => {
    const store = createUserWorkflows(db)
    const saved = store.save('/proj', { name: 'Аудит', description: 'из прогона', steps })
    expect(saved.id).toBeGreaterThan(0)
    expect(saved.name).toBe('Аудит')
    expect(saved.steps).toHaveLength(2)
    expect(saved.steps[0].instruction).toBe('Собери метрики')

    const list = store.listByProject('/proj')
    expect(list).toHaveLength(1)
    expect(list[0].steps).toHaveLength(2)

    const got = store.get(saved.id)
    expect(got?.name).toBe('Аудит')
  })

  it('listByProject фильтрует по проекту; remove удаляет', () => {
    const store = createUserWorkflows(db)
    const a = store.save('/proj-a', { name: 'A', steps })
    store.save('/proj-b', { name: 'B', steps })
    expect(store.listByProject('/proj-a')).toHaveLength(1)
    expect(store.listByProject('/proj-b')).toHaveLength(1)
    store.remove(a.id)
    expect(store.listByProject('/proj-a')).toHaveLength(0)
    expect(store.get(a.id)).toBeNull()
  })

  it('битый steps_json не роняет чтение (пустые шаги)', () => {
    const store = createUserWorkflows(db)
    db.prepare('INSERT INTO user_workflows (project_path, name, steps_json, created_at) VALUES (?, ?, ?, ?)')
      .run('/proj', 'Битый', '{not json', Date.now())
    const list = store.listByProject('/proj')
    expect(list).toHaveLength(1)
    expect(list[0].steps).toEqual([])
  })
})
