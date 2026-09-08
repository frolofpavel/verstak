/**
 * Цикл пробуждения постоянных задач.
 *
 * событие → пробуждение → восстановление состояния → ОГРАНИЧЕННАЯ работа →
 * обновление состояния → сон. Вечно работающего агента нет: каждое пробуждение
 * делает один шаг и заканчивается, а связь между шагами держит durable состояние.
 */
import { shouldWake, nextRunAfter, type JobSignal, type PersistentJobV1 } from '../../shared/contracts/persistent-job'
import type { JobRunOutcome, PersistentJobs } from '../storage/persistent-jobs'

/** Исполнитель одного пробуждения. Внедряется снаружи — цикл не знает про провайдеров. */
export type JobExecutor = (job: PersistentJobV1) => Promise<Omit<JobRunOutcome, 'nextRunAt'>>

export interface WakeCycleDeps {
  jobs: PersistentJobs
  execute: JobExecutor
  now?: () => number
}

/**
 * Задачи, застрявшие в «выполняется» после падения приложения, переводятся в
 * ПАУЗУ, а не в «активна».
 *
 * Это прямое требование безопасности, а не осторожность: после падения неизвестно,
 * успело ли пробуждение выполнить своё действие. Вернуть задачу в активные значит
 * рискнуть повторить его — второй платёж, вторую отправку, второе удаление.
 * Пауза требует человека, и это дешевле любого из этих повторов.
 */
export function reconcileStaleJobs(jobs: PersistentJobs): string[] {
  const stuck = jobs.list().filter(j => j.status === 'running')
  for (const job of stuck) jobs.setStatus(job.id, 'paused')
  return stuck.map(j => j.id)
}

export interface WakeReport {
  woken: string[]
  skipped: Array<{ id: string; why: string }>
}

/**
 * Обработать один сигнал. Возвращает отчёт, а не молчит: «ничего не проснулось»
 * и «проснулось и упало» должны различаться снаружи.
 */
export async function handleSignal(deps: WakeCycleDeps, signal: JobSignal): Promise<WakeReport> {
  const now = deps.now?.() ?? Date.now()
  const report: WakeReport = { woken: [], skipped: [] }

  for (const job of deps.jobs.list()) {
    const decision = shouldWake(job, signal, now)
    if (!decision.wake) {
      report.skipped.push({ id: job.id, why: decision.why })
      continue
    }
    // Захват атомарен: если задачу уже взял параллельный сигнал, второй заход
    // просто уходит. Проверка статуса выше от гонки не спасает — спасает UPDATE.
    if (!deps.jobs.claim(job.id)) {
      report.skipped.push({ id: job.id, why: 'Задачу уже захватил другой сигнал.' })
      continue
    }

    try {
      const outcome = await deps.execute(job)
      const finishedAt = deps.now?.() ?? Date.now()
      deps.jobs.complete(job.id, { ...outcome, nextRunAt: nextRunAfter(job, finishedAt) }, finishedAt)
      report.woken.push(job.id)
    } catch (err) {
      // Падение исполнителя — итог пробуждения, а не потеря задачи: она обязана
      // получить статус и причину, иначе останется «выполняется» навсегда.
      const message = err instanceof Error ? err.message : String(err)
      deps.jobs.complete(job.id, {
        ok: false,
        result: message,
        state: job.state,
        nextAction: job.nextAction,
        costCents: 0,
        nextRunAt: null,
      })
      report.woken.push(job.id)
    }
  }

  return report
}
