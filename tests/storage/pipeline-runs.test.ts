import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createPipelineRuns } from '../../electron/storage/pipeline-runs'
import { validContract } from '../contracts/outcome-contract.test'

/**
 * Storage Pipeline Brief→Proof (миграция 22). Падает по ABI вместе с остальными
 * sqlite-тестами при запущенном Electron — известный шум, не регрессия.
 */
describe('pipeline-runs (migration 22)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-pipeline-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const brief = { goal: 'починить tsc в auth', constraints: 'не трогать билд', dod: 'npm run type' }

  it('миграция 22 создаёт таблицу pipeline_runs', () => {
    const db = openDb(join(dir, 'test.db'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name)
    expect(tables).toContain('pipeline_runs')
    db.close()
  })

  it('create → get: поля и бриф сохранены, step=plan по умолчанию', () => {
    const db = openDb(join(dir, 'test.db'))
    const pr = createPipelineRuns(db)
    const before = Date.now()
    const run = pr.create({ projectPath: 'C:/proj', mode: 'dev', brief, chatId: 7 })
    expect(run.id).toBeGreaterThan(0)
    expect(run.mode).toBe('dev')
    expect(run.step).toBe('plan')
    expect(run.chatId).toBe(7)
    expect(run.brief).toEqual(brief)
    expect(run.createdAt).toBeGreaterThanOrEqual(before)
    expect(pr.get(run.id)).toEqual(run)
    db.close()
  })

  it('advance: меняет step + planId + agentRunId, обновляет updated_at', () => {
    const db = openDb(join(dir, 'test.db'))
    const pr = createPipelineRuns(db)
    const run = pr.create({ projectPath: 'C:/proj', mode: 'dev', brief })
    const moved = pr.advance(run.id, { step: 'execute', planId: 42, agentRunId: 'r-1' })
    expect(moved?.step).toBe('execute')
    expect(moved?.planId).toBe(42)
    expect(moved?.agentRunId).toBe('r-1')
    expect(moved!.updatedAt).toBeGreaterThanOrEqual(run.updatedAt)
    db.close()
  })

  it('getActive: возвращает последний НЕтерминальный, игнорирует completed/cancelled', () => {
    const db = openDb(join(dir, 'test.db'))
    const pr = createPipelineRuns(db)
    // старый прогон завершён
    const done = pr.create({ projectPath: 'C:/proj', mode: 'dev', brief })
    pr.advance(done.id, { step: 'completed' })
    // активный прогон
    const active = pr.create({ projectPath: 'C:/proj', mode: 'dev', brief })
    expect(pr.getActive('C:/proj')?.id).toBe(active.id)
    // отменяем активный → getActive снова null
    pr.cancel(active.id)
    expect(pr.getActive('C:/proj')).toBeNull()
    db.close()
  })

  it('getActive изолирован по проекту', () => {
    const db = openDb(join(dir, 'test.db'))
    const pr = createPipelineRuns(db)
    pr.create({ projectPath: 'C:/a', mode: 'dev', brief })
    expect(pr.getActive('C:/b')).toBeNull()
    db.close()
  })

  it('Task Contract переживает reopen и revision нельзя уменьшить', () => {
    const path = join(dir, 'test.db')
    let db = openDb(path)
    let pr = createPipelineRuns(db)
    const run = pr.create({ projectPath: 'C:/proj', mode: 'dev', brief })
    pr.saveContract(run.id, validContract)
    db.close()

    db = openDb(path)
    pr = createPipelineRuns(db)
    expect(pr.get(run.id)?.taskContract).toEqual(validContract)
    expect(pr.get(run.id)?.contractRevision).toBe(1)
    expect(() => pr.saveContract(run.id, validContract)).toThrow('revision must be 2')
    db.close()
  })
})
