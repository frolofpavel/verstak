/**
 * Постоянная задача — фоновый работник, который ЖИВЁТ между пробуждениями.
 *
 * ПОЧЕМУ НЕ ЧЕТВЁРТЫЙ ПЛАНИРОВЩИК. В продукте их уже три: `scheduled_tasks`
 * (десктоп, тик раз в минуту), `scheduled_jobs` (headless-сервис) и `reminders`.
 * Четвёртый был бы прямым дублированием. Не хватало ДВУХ вещей, которых нет ни у
 * одного из них: расширяемого источника пробуждения (все три умеют только время)
 * и durable СОСТОЯНИЯ между пробуждениями — сегодняшние расписания просто
 * перезапускают промпт с нуля и ничего не помнят.
 *
 * Цикл: событие → пробуждение → восстановление состояния → ограниченная работа →
 * проверка → обновление состояния → уведомление при необходимости → сон.
 * Вечно работающего агента здесь нет и не предполагается.
 */

export type JobStatus = 'active' | 'running' | 'paused' | 'done' | 'failed'

/**
 * Вид триггера. Список открыт СОЗНАТЕЛЬНО: добавление источника (изменение файла,
 * смена статуса задачи, событие коннектора) — это новое значение и новая ветка в
 * `matchesTrigger`, а не новый планировщик рядом.
 */
export type TriggerKind = 'schedule' | 'event' | 'manual'

/** Сигнал, по которому проверяется пробуждение. */
export type JobSignal =
  | { kind: 'tick'; at: number }
  | { kind: 'event'; name: string; at: number; payload?: Record<string, unknown> }
  | { kind: 'manual'; at: number }

export interface PersistentJobV1 {
  id: string
  projectPath: string
  title: string
  goal: string
  status: JobStatus
  triggerKind: TriggerKind
  triggerConfig: Record<string, unknown>
  /** Durable состояние МЕЖДУ пробуждениями — то, чего нет у сегодняшних расписаний. */
  state: Record<string, unknown>
  /** Что задача собирается сделать в следующее пробуждение. */
  nextAction: string | null
  /** Возможность, от имени которой работает задача (ключ реестра возможностей). */
  assignedCapabilityId: string | null
  requiredCapabilities: string[]
  budgetCents: number | null
  maxRuntimeMs: number | null
  maxRuns: number
  runsDone: number
  costUsedCents: number
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: string | null
  createdAt: number
  updatedAt: number
}

/**
 * Потолок числа запусков. Задача без предела не создаётся вовсе — то же правило,
 * что у расписаний headless-сервиса: фоновая работа не имеет права быть вечным
 * расходом, о котором человек забыл.
 */
export const MAX_RUNS_CAP = 100

/**
 * Минимальный промежуток между пробуждениями. Слишком частое пробуждение — тот же
 * вечный расход, только растянутый по времени.
 */
export const MIN_WAKE_INTERVAL_MS = 5 * 60_000

export interface WakeDecision {
  wake: boolean
  /** Почему разбудили или почему нет — человек должен читать основание. */
  why: string
}

/** Подходит ли сигнал под триггер задачи. Неизвестный вид — отказ, а не догадка. */
function matchesTrigger(job: PersistentJobV1, signal: JobSignal, now: number): WakeDecision {
  switch (job.triggerKind) {
    case 'schedule': {
      if (signal.kind !== 'tick') return { wake: false, why: 'Задача по расписанию: ждёт своего времени.' }
      if (job.nextRunAt === null) return { wake: false, why: 'Время следующего запуска не назначено.' }
      return job.nextRunAt <= now
        ? { wake: true, why: 'Пришло время по расписанию.' }
        : { wake: false, why: 'Время следующего запуска ещё не наступило.' }
    }
    case 'event': {
      if (signal.kind !== 'event') return { wake: false, why: 'Задача ждёт события, а не времени.' }
      const expected = typeof job.triggerConfig.event === 'string' ? job.triggerConfig.event : null
      if (!expected) return { wake: false, why: 'У задачи не указано, какого события она ждёт.' }
      return signal.name === expected
        ? { wake: true, why: `Пришло событие «${signal.name}».` }
        : { wake: false, why: 'Пришло чужое событие.' }
    }
    case 'manual':
      return signal.kind === 'manual'
        ? { wake: true, why: 'Запущено человеком.' }
        : { wake: false, why: 'Ручная задача сама не просыпается.' }
    default:
      // Неизвестный вид триггера означает, что задачу завели новее, чем этот код.
      // Разбудить «на всякий случай» значит потратить деньги без основания.
      return { wake: false, why: 'Неизвестный вид триггера — задача не будится.' }
  }
}

/**
 * Будить ли задачу.
 *
 * Порядок намеренный: сначала СОСТОЯНИЕ и ПРЕДОХРАНИТЕЛИ, потом триггер. Ручной
 * запуск — воля человека, но не обход предела: исчерпанный бюджет не перестаёт
 * быть исчерпанным оттого, что нажали кнопку.
 */
export function shouldWake(job: PersistentJobV1, signal: JobSignal, now: number): WakeDecision {
  if (job.status === 'paused') return { wake: false, why: 'Задача на паузе.' }
  if (job.status === 'running') return { wake: false, why: 'Задача уже выполняется.' }
  if (job.status === 'done' || job.status === 'failed') {
    return { wake: false, why: 'Задача завершена и больше не просыпается.' }
  }
  if (job.runsDone >= job.maxRuns) {
    return { wake: false, why: `Исчерпан лимит запусков (${job.runsDone} из ${job.maxRuns}).` }
  }
  if (job.budgetCents !== null && job.costUsedCents >= job.budgetCents) {
    return { wake: false, why: `Исчерпан бюджет задачи (${job.costUsedCents} из ${job.budgetCents} центов).` }
  }
  if (job.lastRunAt !== null && now - job.lastRunAt < MIN_WAKE_INTERVAL_MS) {
    return { wake: false, why: 'Слишком частое пробуждение: не прошёл минимальный интервал.' }
  }
  return matchesTrigger(job, signal, now)
}

/** Когда задаче проснуться в следующий раз. Не расписание — значит по событию. */
export function nextRunAfter(job: PersistentJobV1, finishedAt: number): number | null {
  if (job.triggerKind !== 'schedule') return null
  const every = typeof job.triggerConfig.everyMinutes === 'number' ? job.triggerConfig.everyMinutes : null
  if (every === null) return null
  const interval = Math.max(every * 60_000, MIN_WAKE_INTERVAL_MS)
  return finishedAt + interval
}
