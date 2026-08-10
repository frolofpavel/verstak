/**
 * C1 (P5, пакет 2.5.0): scheduled_jobs — хранилище задач по расписанию.
 *
 * Исполняет их headless-scheduler (electron/headless/scheduler.ts) — сервис, который
 * умеет полный агентный цикл без GUI. Вся правда о расписании живёт в sqlite:
 * next_run_at / runs_done / enabled переживают перезапуск, в памяти состояния нет.
 *
 * Два жёстких предохранителя против «вечного фонового расхода»:
 *   - maxRuns ОБЯЗАТЕЛЕН (1..MAX_RUNS_CAP) — задача без лимита не создаётся вовсе;
 *   - интервал не чаще MIN_INTERVAL_MINUTES.
 */
import type { Database } from 'better-sqlite3'

export const MAX_RUNS_CAP = 100
export const MIN_INTERVAL_MINUTES = 5

export type ScheduleSpec =
  | { kind: 'once'; runAt: number }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; time: string }  // 'HH:MM' локального времени сервиса

export interface NewScheduledJob {
  name: string
  prompt: string
  workspace?: string | null
  providerId?: string | null
  model?: string | null
  schedule: ScheduleSpec
  /** Обязательный явный лимит итераций. Задача исчерпала лимит → выключается. */
  maxRuns: number
}

export interface ScheduledJob {
  id: number
  name: string
  prompt: string
  workspace: string | null
  providerId: string | null
  model: string | null
  scheduleKind: ScheduleSpec['kind']
  intervalMinutes: number | null
  dailyTime: string | null
  nextRunAt: number
  maxRuns: number
  runsDone: number
  enabled: boolean
  lastRunId: string | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

/** Следующий момент запуска по спецификации. Чистая функция — тестируется без БД. */
export function computeNextRunAt(spec: ScheduleSpec, now: number): number {
  if (spec.kind === 'once') return spec.runAt
  if (spec.kind === 'interval') return now + spec.everyMinutes * 60_000
  // daily: ближайшее HH:MM после now (локальное время процесса-сервиса).
  const m = /^(\d{1,2}):(\d{2})$/.exec(spec.time.trim())
  if (!m) throw new Error(`расписание daily: время должно быть 'HH:MM', получено '${spec.time}'`)
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) throw new Error(`расписание daily: некорректное время '${spec.time}'`)
  const d = new Date(now)
  d.setHours(hours, minutes, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** Провалидировать спецификацию + лимит. Бросает с человеческой причиной. */
export function validateNewJob(job: NewScheduledJob): void {
  if (!job.name?.trim()) throw new Error('расписание: name обязателен')
  if (!job.prompt?.trim()) throw new Error('расписание: prompt обязателен')
  if (!Number.isInteger(job.maxRuns) || job.maxRuns < 1 || job.maxRuns > MAX_RUNS_CAP) {
    throw new Error(`расписание: max_runs обязателен, целое 1..${MAX_RUNS_CAP} — задача без лимита итераций не создаётся`)
  }
  const s = job.schedule
  if (s.kind === 'interval') {
    if (!Number.isFinite(s.everyMinutes) || s.everyMinutes < MIN_INTERVAL_MINUTES) {
      throw new Error(`расписание: интервал не чаще ${MIN_INTERVAL_MINUTES} минут`)
    }
  } else if (s.kind === 'once') {
    if (!Number.isFinite(s.runAt)) throw new Error('расписание once: runAt обязателен (unix ms)')
  } else if (s.kind === 'daily') {
    computeNextRunAt(s, Date.now())  // валидирует формат времени
  } else {
    throw new Error('расписание: kind должен быть once | interval | daily')
  }
}

interface JobRow {
  id: number
  name: string
  prompt: string
  workspace: string | null
  provider_id: string | null
  model: string | null
  schedule_kind: ScheduleSpec['kind']
  interval_minutes: number | null
  daily_time: string | null
  next_run_at: number
  max_runs: number
  runs_done: number
  enabled: number
  last_run_id: string | null
  last_error: string | null
  created_at: number
  updated_at: number
}

function toJob(r: JobRow): ScheduledJob {
  return {
    id: r.id, name: r.name, prompt: r.prompt, workspace: r.workspace,
    providerId: r.provider_id, model: r.model,
    scheduleKind: r.schedule_kind, intervalMinutes: r.interval_minutes, dailyTime: r.daily_time,
    nextRunAt: r.next_run_at, maxRuns: r.max_runs, runsDone: r.runs_done,
    enabled: r.enabled === 1, lastRunId: r.last_run_id, lastError: r.last_error,
    createdAt: r.created_at, updatedAt: r.updated_at
  }
}

export interface ScheduledJobs {
  create: (job: NewScheduledJob, now?: number) => ScheduledJob
  get: (id: number) => ScheduledJob | null
  list: () => ScheduledJob[]
  /** Задачи, которым пора: enabled, next_run_at <= now, лимит не исчерпан. */
  due: (now: number) => ScheduledJob[]
  /**
   * Зафиксировать запуск: runs_done+1, last_run_id/last_error, следующий момент.
   * Лимит исчерпан или once → задача выключается (enabled=0), а не удаляется:
   * человек видит, что она отработала, и её результаты (last_run_id → agent_runs).
   */
  recordRun: (id: number, outcome: { runId?: string; error?: string }, now: number) => void
  setEnabled: (id: number, enabled: boolean) => void
  remove: (id: number) => void
}

export function createScheduledJobs(db: Database): ScheduledJobs {
  return {
    create: (job, now = Date.now()) => {
      validateNewJob(job)
      const s = job.schedule
      const nextRunAt = computeNextRunAt(s, now)
      const info = db.prepare(`
        INSERT INTO scheduled_jobs (name, prompt, workspace, provider_id, model,
          schedule_kind, interval_minutes, daily_time, next_run_at, max_runs,
          runs_done, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
      `).run(
        job.name.trim(), job.prompt, job.workspace ?? null, job.providerId ?? null, job.model ?? null,
        s.kind, s.kind === 'interval' ? s.everyMinutes : null, s.kind === 'daily' ? s.time : null,
        nextRunAt, job.maxRuns, now, now
      )
      return toJob(db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(Number(info.lastInsertRowid)) as JobRow)
    },
    get: (id) => {
      const r = db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as JobRow | undefined
      return r ? toJob(r) : null
    },
    list: () => (db.prepare('SELECT * FROM scheduled_jobs ORDER BY id').all() as JobRow[]).map(toJob),
    due: (now) => (db.prepare(
      'SELECT * FROM scheduled_jobs WHERE enabled = 1 AND next_run_at <= ? AND runs_done < max_runs ORDER BY next_run_at'
    ).all(now) as JobRow[]).map(toJob),
    recordRun: (id, outcome, now) => {
      const r = db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as JobRow | undefined
      if (!r) return
      const runsDone = r.runs_done + 1
      const exhausted = runsDone >= r.max_runs || r.schedule_kind === 'once'
      // next_run_at считается ОТ МОМЕНТА запуска, не от прежнего плана: сервис,
      // простоявший сутки, выполняет пропущенную задачу ОДИН раз, а не навёрстывает.
      const spec: ScheduleSpec = r.schedule_kind === 'interval'
        ? { kind: 'interval', everyMinutes: r.interval_minutes ?? MIN_INTERVAL_MINUTES }
        : r.schedule_kind === 'daily'
          ? { kind: 'daily', time: r.daily_time ?? '09:00' }
          : { kind: 'once', runAt: r.next_run_at }
      const nextRunAt = exhausted ? r.next_run_at : computeNextRunAt(spec, now)
      db.prepare(`
        UPDATE scheduled_jobs SET runs_done = ?, enabled = ?, next_run_at = ?,
          last_run_id = COALESCE(?, last_run_id), last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(runsDone, exhausted ? 0 : 1, nextRunAt, outcome.runId ?? null, outcome.error ?? null, now, id)
    },
    setEnabled: (id, enabled) => {
      db.prepare('UPDATE scheduled_jobs SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id)
    },
    remove: (id) => { db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id) }
  }
}
