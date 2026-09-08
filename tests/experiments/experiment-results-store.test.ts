// Артефакт эксперимента в НАСТОЯЩЕЙ базе. Главное здесь — не запись и чтение, а
// невозможность записать «применено автоматически»: запрет живёт в схеме, а не
// в коде, потому что код обходится забывчивостью следующей правки.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createExperimentResults } from '../../electron/storage/experiment-results'
import type { ExperimentResultV1 } from '../../shared/contracts/experiment'

const result = (over: Partial<ExperimentResultV1> = {}): ExperimentResultV1 => ({
  hypothesis: 'кандидат дешевле при том же качестве',
  changedFactor: 'model',
  baseline: 'kimi-k2.7-code',
  candidate: 'deepseek-chat',
  taskSet: 'bugfix',
  repeats: 3,
  successRateBefore: 0.6,
  successRateAfter: 0.65,
  costBefore: 900,
  costAfter: 300,
  latencyBefore: 120_000,
  latencyAfter: 90_000,
  verificationBefore: 0.6,
  verificationAfter: 0.7,
  recommendation: 'promote',
  confidence: 0.5,
  autoApplied: false,
  appliedAt: null,
  createdAt: 1_800_000_000_000,
  ...over,
})

describe('итог эксперимента', () => {
  let dir: string
  let db: Database
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-exp-')); db = openDb(join(dir, 'test.db')) })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('записывается и читается без потерь', () => {
    const store = createExperimentResults(db)
    store.insert('/p', result())
    const [saved] = store.list('/p')
    expect(saved.hypothesis).toContain('дешевле')
    expect(saved.changedFactor).toBe('model')
    expect(saved.costAfter).toBe(300)
    expect(saved.recommendation).toBe('promote')
  })

  it('прочитанный итог всегда помечен как НЕ применённый', () => {
    const store = createExperimentResults(db)
    store.insert('/p', result())
    expect(store.list('/p')[0].autoApplied).toBe(false)
    expect(store.list('/p')[0].appliedAt).toBeNull()
  })

  // ГЛАВНЫЙ ПИН: запрет самовольного применения живёт в СХЕМЕ. Попытка записать
  // «применено» мимо слоя доступа обязана падать, а не тихо проходить.
  it('схема не даёт записать «применено автоматически» даже в обход слоя', () => {
    expect(() =>
      db.prepare(`
        INSERT INTO experiment_results (
          project_path, hypothesis, changed_factor, baseline, candidate, task_set, repeats,
          success_rate_before, success_rate_after, cost_before, cost_after,
          latency_before, latency_after, verification_before, verification_after,
          recommendation, confidence, auto_applied, created_at
        ) VALUES ('/p','x','model','a','b','t',3, 0,0,0,0,0,0,0,0,'promote',1, 1, 1)
      `).run()
    ).toThrow()
  })

  // Контроль: та же вставка с нулём обязана проходить — иначе пин выше зелен
  // просто потому, что вставка сломана целиком.
  it('контроль: та же запись с auto_applied = 0 проходит', () => {
    expect(() =>
      db.prepare(`
        INSERT INTO experiment_results (
          project_path, hypothesis, changed_factor, baseline, candidate, task_set, repeats,
          success_rate_before, success_rate_after, cost_before, cost_after,
          latency_before, latency_after, verification_before, verification_after,
          recommendation, confidence, auto_applied, created_at
        ) VALUES ('/p','x','model','a','b','t',3, 0,0,0,0,0,0,0,0,'promote',1, 0, 1)
      `).run()
    ).not.toThrow()
  })

  it('чужая рекомендация схемой не принимается', () => {
    expect(() => createExperimentResults(db).insert('/p', result({ recommendation: 'применить' as never }))).toThrow()
  })

  it('итоги чужого проекта не смешиваются', () => {
    const store = createExperimentResults(db)
    store.insert('/p', result())
    store.insert('/другой', result())
    expect(store.list('/p').length).toBe(1)
  })
})
