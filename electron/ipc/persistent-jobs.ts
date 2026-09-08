/**
 * IPC постоянных задач.
 *
 * Заведён потому, что фоновый работник, которого нельзя создать, — инертный
 * механизм: он есть в коде, доказан тестами и не существует для человека.
 *
 * Ручного «разбудить сейчас» здесь НЕТ намеренно: пробуждение идёт через ту же
 * шину и те же предохранители, что и по расписанию, — отдельная дверь в обход
 * лимитов однажды стала бы способом их не соблюдать.
 */
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { PersistentJobs } from '../storage/persistent-jobs'
import { MAX_RUNS_CAP, MIN_WAKE_INTERVAL_MS, type JobSignal } from '../../shared/contracts/persistent-job'

export interface PersistentJobsIpcDeps {
  jobs: PersistentJobs
  publish: (signal: JobSignal) => void
  /** Корни зарегистрированных проектов — задача не заводится вне них. */
  getKnownRoots: () => string[]
}

export interface CreateJobInput {
  projectPath: string
  title: string
  goal: string
  everyMinutes: number
  maxRuns: number
}

/**
 * Проверка входа отдельной ЧИСТОЙ функцией, а не внутри обработчика: предохранители
 * фоновой задачи — самое ценное в ней, и они обязаны проверяться тестом напрямую,
 * а не через мок ipcMain.
 */
export function validateCreateJob(
  input: CreateJobInput | undefined,
  knownRoots: readonly string[]
): { ok: true; everyMinutes: number; maxRuns: number; title: string; goal: string } | { ok: false; error: string } {
  const title = (input?.title ?? '').trim()
  const goal = (input?.goal ?? '').trim()
  if (!title || !goal) return { ok: false, error: 'Нужны название и цель задачи.' }

  if (!input || !knownRoots.some(root => input.projectPath === root)) {
    return { ok: false, error: 'Проект не зарегистрирован.' }
  }

  const minMinutes = Math.round(MIN_WAKE_INTERVAL_MS / 60_000)
  const everyMinutes = Number(input.everyMinutes)
  if (!Number.isFinite(everyMinutes) || everyMinutes < minMinutes) {
    return { ok: false, error: `Интервал не может быть чаще ${minMinutes} минут.` }
  }

  const maxRuns = Number(input.maxRuns)
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_RUNS_CAP) {
    return { ok: false, error: `Предел запусков обязателен: от 1 до ${MAX_RUNS_CAP}.` }
  }

  return { ok: true, everyMinutes, maxRuns, title, goal }
}

export function registerPersistentJobsIpc(deps: PersistentJobsIpcDeps): void {
  ipcMain.handle('jobs:list', (_e, projectPath?: string) => deps.jobs.list(projectPath))

  ipcMain.handle('jobs:limits', () => ({
    maxRunsCap: MAX_RUNS_CAP,
    minIntervalMinutes: Math.round(MIN_WAKE_INTERVAL_MS / 60_000),
  }))

  ipcMain.handle('jobs:create', (_e, input: CreateJobInput) => {
    const checked = validateCreateJob(input, deps.getKnownRoots())
    if (!checked.ok) return { error: checked.error }
    try {
      const job = deps.jobs.create({
        id: randomUUID(),
        projectPath: input.projectPath,
        title: checked.title,
        goal: checked.goal,
        triggerKind: 'schedule',
        triggerConfig: { everyMinutes: checked.everyMinutes },
        maxRuns: checked.maxRuns,
        // Первое пробуждение — не раньше минимального интервала: задача,
        // стартующая мгновенно, обходит защиту от слишком частой работы.
        nextRunAt: Date.now() + checked.everyMinutes * 60_000,
      })
      return { job }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Не удалось создать задачу.' }
    }
  })

  ipcMain.handle('jobs:pause', (_e, id: string) => { deps.jobs.setStatus(id, 'paused'); return deps.jobs.get(id) })

  ipcMain.handle('jobs:resume', (_e, id: string) => {
    const job = deps.jobs.get(id)
    if (!job) return null
    // Возобновление НЕ сбрасывает счётчики: задача, исчерпавшая предел, не
    // получает второй жизни нажатием кнопки.
    deps.jobs.setStatus(id, 'active')
    return deps.jobs.get(id)
  })

  ipcMain.handle('jobs:delete', (_e, id: string) => { deps.jobs.remove(id); return true })
}
