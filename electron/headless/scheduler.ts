/**
 * C1 (P5, пакет 2.5.0): исполнитель расписания headless-сервиса.
 *
 * «Каждый день в 9:00 прогоняй ревизию», «через 30 минут проверь сборку» — задачи
 * отрабатывают при закрытом окне: сервис умеет полный агентный цикл без GUI.
 * Состояния в памяти нет — только sqlite (scheduled_jobs), поэтому перезапуск
 * сервиса расписание переживает: первый же tick подбирает просроченное и выполняет
 * ОДИН раз (recordRun пересчитывает next_run_at от момента запуска, не навёрстывает).
 *
 * Режим прогона ЖЁСТКО 'auto': расписание по определению unattended, а в 'auto'
 * план-гейт не применяется по построению (plan-gate-modes.ts, ветка auto/bypass) —
 * это закреплено пином tests/headless/scheduler.test.ts, а не оставлено на веру.
 */
import type { ScheduledJobs, ScheduledJob } from '../storage/scheduled-jobs'
import { logRuntime } from '../runtime-log'

export interface SchedulerStartTask {
  (opts: {
    prompt: string
    workspace?: string
    providerId?: string
    model?: string
    agentMode: 'auto'
  }): Promise<{ runId: string; completion: Promise<void> }>
}

export interface SchedulerOptions {
  jobs: ScheduledJobs
  startTask: SchedulerStartTask
  /** Период опроса; по умолчанию 30 с. null — без таймера (tick только вручную). */
  pollMs?: number | null
  /** Часы для тестов. */
  now?: () => number
}

export interface Scheduler {
  /** Один проход: запустить всё просроченное. Возвращает число запущенных задач. */
  tick: () => Promise<number>
  stop: () => void
}

export function startScheduler(opts: SchedulerOptions): Scheduler {
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? 30_000
  let stopped = false
  let ticking = false

  async function runJob(job: ScheduledJob): Promise<void> {
    try {
      const task = await opts.startTask({
        prompt: job.prompt,
        workspace: job.workspace ?? undefined,
        providerId: job.providerId ?? undefined,
        model: job.model ?? undefined,
        // Unattended по определению — план-гейт в 'auto' не применяется по построению.
        agentMode: 'auto'
      })
      // Фиксируем СТАРТ, не дожидаясь завершения прогона: упавший или длинный прогон
      // не должен ни блокировать расписание, ни давать задаче второй запуск.
      opts.jobs.recordRun(job.id, { runId: task.runId }, now())
      logRuntime('headless.scheduler.job-started', { jobId: job.id, runId: task.runId })
      task.completion.catch((err: unknown) => {
        logRuntime('headless.scheduler.job-run-failed', {
          jobId: job.id, runId: task.runId, error: err instanceof Error ? err.message : String(err)
        })
      })
    } catch (err) {
      // Старт не удался (нет ключа, нет провайдера). След обязателен, итерация
      // ТРАТИТСЯ (recordRun) — иначе битая задача ретраилась бы вечно.
      const msg = err instanceof Error ? err.message : String(err)
      opts.jobs.recordRun(job.id, { error: msg }, now())
      logRuntime('headless.scheduler.job-start-failed', { jobId: job.id, error: msg })
    }
  }

  async function tick(): Promise<number> {
    if (ticking) return 0  // прошлый tick ещё стартует задачи — не дублируем
    ticking = true
    try {
      const due = opts.jobs.due(now())
      for (const job of due) {
        if (stopped) break
        await runJob(job)
      }
      return due.length
    } finally {
      ticking = false
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  if (pollMs !== null) {
    timer = setInterval(() => { void tick() }, pollMs)
    // unref: расписание не должно держать процесс живым, когда сервис закрывается.
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    tick,
    stop: () => { stopped = true; if (timer) clearInterval(timer) }
  }
}
