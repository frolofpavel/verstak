// C1 (P5, пакет 2.5.0): инструмент schedule.
//
// Зеркальная пара: без фасада (десктоп) — честный отказ, ничего не пишется;
// с фасадом (headless) — задача создаётся ЧЕРЕЗ РЕАЛЬНОЕ хранилище (фикстура =
// продовая форма, §3.1: фасад собран так же, как в host.ts). max_runs без
// значения отвергается — обязательный лимит итераций держится и на этой ручке.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createScheduledJobs, type ScheduleSpec } from '../../electron/storage/scheduled-jobs'
import { scheduleHandler } from '../../electron/ipc/tool-handlers/schedule'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'

function call(args: Record<string, unknown>) {
  return { id: 'c1', name: 'schedule', args }
}

describe('schedule tool', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let store: ReturnType<typeof createScheduledJobs>
  let ctx: ToolContext

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-sched-tool-'))
    db = openDb(join(dir, 'test.db'))
    store = createScheduledJobs(db)
    // Фасад — та же форма, что собирает host.ts (create с дефолтами прогона).
    ctx = {
      scheduledJobs: {
        create: (job: { name: string; prompt: string; schedule: ScheduleSpec; maxRuns: number }) => {
          const created = store.create({ ...job, providerId: 'deepseek', model: 'm', workspace: '/w' })
          return { id: created.id, nextRunAt: created.nextRunAt, maxRuns: created.maxRuns }
        }
      }
    } as unknown as ToolContext
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('без фасада (десктоп) → честный отказ, строка в БД не появляется', async () => {
    const r = await scheduleHandler.handle(call({ name: 'x', prompt: 'y', kind: 'once', run_at_ms: 1, max_runs: 1 }), {} as ToolContext)
    expect(r.error).toContain('headless')
    expect(store.list()).toEqual([])
  })

  it('КОНТРОЛЬ: с фасадом задача создаётся и лежит в scheduled_jobs', async () => {
    const r = await scheduleHandler.handle(
      call({ name: 'ревизия', prompt: 'прогони ревизию', kind: 'daily', time: '09:00', max_runs: 7 }), ctx
    )
    expect(r.error).toBeUndefined()
    expect(String(r.result)).toContain('#')
    const rows = store.list()
    expect(rows.length).toBe(1)
    expect(rows[0].prompt).toBe('прогони ревизию')
    expect(rows[0].maxRuns).toBe(7)
    expect(rows[0].providerId).toBe('deepseek')  // дефолт прогона доехал через фасад
  })

  it('без max_runs → отказ с причиной, задача не создана', async () => {
    const r = await scheduleHandler.handle(call({ name: 'x', prompt: 'y', kind: 'daily', time: '09:00' }), ctx)
    expect(r.error).toMatch(/max_runs/)
    expect(store.list()).toEqual([])
  })

  it('неизвестный kind → отказ', async () => {
    const r = await scheduleHandler.handle(call({ name: 'x', prompt: 'y', kind: 'weekly', max_runs: 1 }), ctx)
    expect(r.error).toMatch(/once \| interval \| daily/)
  })
})
