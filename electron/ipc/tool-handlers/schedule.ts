// C1 (P5, пакет 2.5.0): инструмент schedule — создать задачу по расписанию.
// Исполняет её headless-scheduler; здесь только валидация и строка в scheduled_jobs.
import type { ToolHandler } from './shared'
import type { ScheduleSpec } from '../../storage/scheduled-jobs'

export const scheduleHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    // Фасад даёт только headless-хост. На десктопе честный отказ: строка в БД,
    // которую никто никогда не исполнит, — ровно класс «галочка обещает и врёт».
    if (!ctx.scheduledJobs) {
      return {
        id: call.id, name: call.name, result: '',
        error: 'Расписание исполняет headless-сервис Verstak — в этом прогоне создать задачу по расписанию нельзя.'
      }
    }
    const kind = String(call.args.kind ?? '')
    let schedule: ScheduleSpec
    if (kind === 'once') schedule = { kind: 'once', runAt: Number(call.args.run_at_ms) }
    else if (kind === 'interval') schedule = { kind: 'interval', everyMinutes: Number(call.args.every_minutes) }
    else if (kind === 'daily') schedule = { kind: 'daily', time: String(call.args.time ?? '') }
    else {
      return { id: call.id, name: call.name, result: '', error: 'schedule: kind должен быть once | interval | daily' }
    }
    try {
      // Валидация (обязательный max_runs 1..100, интервал не чаще 5 минут) — в
      // validateNewJob хранилища: у ручки и у будущих ручек одна граница.
      const job = ctx.scheduledJobs.create({
        name: String(call.args.name ?? ''),
        prompt: String(call.args.prompt ?? ''),
        schedule,
        maxRuns: Number(call.args.max_runs)
      })
      return {
        id: call.id, name: call.name,
        result: `Задача по расписанию создана: #${job.id}, следующий запуск ${new Date(job.nextRunAt).toISOString()}, лимит итераций ${job.maxRuns}.`
      }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
