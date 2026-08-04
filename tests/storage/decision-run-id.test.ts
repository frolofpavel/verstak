import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createProjectBrainStore, type NewDecisionRecord } from '../../electron/storage/project-brain'

// Задача 7B: decision_record.run_id (миграция 62) — привязка решения к прогону.
describe('decision_record.run_id (задача 7B)', () => {
  let dir: string
  let db: Database
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-dec-')); db = openDb(join(dir, 'test.db')) })
  afterEach(() => { try { db.close() } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }) })

  const base = (patch: Partial<NewDecisionRecord> = {}): NewDecisionRecord => ({
    sourceMessageId: null, title: 'Решение', userRequest: null, finalDecision: 'Делаем так',
    why: 'потому что', keyArguments: [], objections: [], risks: [], alternativesRejected: [],
    nextActions: [], confidence: 'high', revisitDate: null, ...patch,
  })

  it('save с runId → get возвращает его; фильтр по прогону работает', () => {
    const store = createProjectBrainStore(db)
    store.saveDecisionRecord('/p', base({ title: 'A', runId: 'run-1' }))
    store.saveDecisionRecord('/p', base({ title: 'B', runId: 'run-2' }))
    store.saveDecisionRecord('/p', base({ title: 'C', runId: 'run-1' }))
    const all = store.getDecisionRecords('/p')
    expect(all).toHaveLength(3)
    const run1 = all.filter(d => d.runId === 'run-1')
    expect(run1.map(d => d.title).sort()).toEqual(['A', 'C'])
  })

  it('runId необязателен: решение без прогона читается с runId=null (обратная совместимость)', () => {
    const store = createProjectBrainStore(db)
    store.saveDecisionRecord('/p', base({ title: 'Без прогона' }))
    const rec = store.getDecisionRecords('/p')[0]
    expect(rec.runId).toBeNull()
  })
})
