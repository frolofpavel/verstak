// C1 (P5, пакет 2.5.0): хранилище задач по расписанию.
// Два предохранителя против вечного фонового расхода — обязательный max_runs и
// минимальный интервал — закреплены зеркальными парами (отказ + контрольный успех).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createScheduledJobs, computeNextRunAt, MIN_INTERVAL_MINUTES } from '../../electron/storage/scheduled-jobs'

describe('scheduled_jobs — таблица и валидация', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let jobs: ReturnType<typeof createScheduledJobs>
  const NOW = 1_700_000_000_000

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-sched-'))
    db = openDb(join(dir, 'test.db'))
    jobs = createScheduledJobs(db)
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('миграция создала таблицу scheduled_jobs', () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_jobs'").get()
    expect(t).toBeTruthy()
  })

  it('КОНТРОЛЬ: валидная interval-задача создаётся, next_run_at = now + период', () => {
    const job = jobs.create({
      name: 'ревизия', prompt: 'прогони ревизию',
      schedule: { kind: 'interval', everyMinutes: 30 }, maxRuns: 3
    }, NOW)
    expect(job.id).toBeGreaterThan(0)
    expect(job.nextRunAt).toBe(NOW + 30 * 60_000)
    expect(job.runsDone).toBe(0)
    expect(job.enabled).toBe(true)
  })

  it('без max_runs (NaN) задача НЕ создаётся — лимит итераций обязателен', () => {
    expect(() => jobs.create({
      name: 'x', prompt: 'y', schedule: { kind: 'interval', everyMinutes: 30 }, maxRuns: Number.NaN
    })).toThrow(/max_runs/)
  })

  it('max_runs 0 и 101 отвергаются (границы 1..100)', () => {
    const mk = (maxRuns: number) => () => jobs.create({
      name: 'x', prompt: 'y', schedule: { kind: 'once', runAt: NOW }, maxRuns
    })
    expect(mk(0)).toThrow(/max_runs/)
    expect(mk(101)).toThrow(/max_runs/)
    expect(mk(1)).not.toThrow()  // контроль: граница входит
  })

  it(`интервал чаще ${MIN_INTERVAL_MINUTES} минут отвергается`, () => {
    expect(() => jobs.create({
      name: 'x', prompt: 'y', schedule: { kind: 'interval', everyMinutes: 1 }, maxRuns: 1
    })).toThrow(/не чаще/)
  })

  it('due отдаёт только включённые, просроченные и не исчерпавшие лимит', () => {
    const due = jobs.create({ name: 'due', prompt: 'p', schedule: { kind: 'once', runAt: NOW - 1000 }, maxRuns: 1 }, NOW - 2000)
    jobs.create({ name: 'future', prompt: 'p', schedule: { kind: 'once', runAt: NOW + 60_000 }, maxRuns: 1 }, NOW)
    const off = jobs.create({ name: 'off', prompt: 'p', schedule: { kind: 'once', runAt: NOW - 1000 }, maxRuns: 1 }, NOW - 2000)
    jobs.setEnabled(off.id, false)
    expect(jobs.due(NOW).map(j => j.id)).toEqual([due.id])
  })

  it('recordRun тратит итерацию; лимит исчерпан → задача ВЫКЛЮЧАЕТСЯ, а не крутится вечно', () => {
    const job = jobs.create({ name: 'j', prompt: 'p', schedule: { kind: 'interval', everyMinutes: 10 }, maxRuns: 2 }, NOW - 11 * 60_000)
    jobs.recordRun(job.id, { runId: 'r1' }, NOW)
    let cur = jobs.get(job.id)!
    expect(cur.runsDone).toBe(1)
    expect(cur.enabled).toBe(true)
    expect(cur.nextRunAt).toBe(NOW + 10 * 60_000)  // от момента запуска, не навёрстывает
    expect(cur.lastRunId).toBe('r1')

    jobs.recordRun(job.id, { runId: 'r2' }, NOW + 10 * 60_000)
    cur = jobs.get(job.id)!
    expect(cur.runsDone).toBe(2)
    expect(cur.enabled, 'лимит исчерпан, а задача осталась включённой — вечный расход').toBe(false)
    expect(jobs.due(NOW + 100 * 60_000)).toEqual([])
  })

  it('once после запуска выключается даже при max_runs > 1', () => {
    const job = jobs.create({ name: 'j', prompt: 'p', schedule: { kind: 'once', runAt: NOW }, maxRuns: 5 }, NOW - 1000)
    jobs.recordRun(job.id, { runId: 'r1' }, NOW)
    expect(jobs.get(job.id)!.enabled).toBe(false)
  })

  it('ошибка старта тратит итерацию и оставляет след last_error (не бесконечный ретрай)', () => {
    const job = jobs.create({ name: 'j', prompt: 'p', schedule: { kind: 'interval', everyMinutes: 10 }, maxRuns: 3 }, NOW - 11 * 60_000)
    jobs.recordRun(job.id, { error: 'нет ключа провайдера' }, NOW)
    const cur = jobs.get(job.id)!
    expect(cur.lastError).toBe('нет ключа провайдера')
    expect(cur.runsDone).toBe(1)
    expect(jobs.due(NOW + 1000), 'битая задача сразу снова due — ретраится вечно').toEqual([])
  })

  it('computeNextRunAt daily: сегодня, если время впереди; иначе завтра', () => {
    const base = new Date(2026, 7, 10, 8, 0, 0, 0).getTime()   // 08:00 локального
    const at9 = computeNextRunAt({ kind: 'daily', time: '09:00' }, base)
    expect(new Date(at9).getHours()).toBe(9)
    expect(at9 - base).toBe(60 * 60_000)
    const at7 = computeNextRunAt({ kind: 'daily', time: '07:00' }, base)
    expect(at7 - base).toBe(23 * 60 * 60_000)  // завтра в 07:00
    expect(() => computeNextRunAt({ kind: 'daily', time: '25:99' }, base)).toThrow(/время/)
  })
})
