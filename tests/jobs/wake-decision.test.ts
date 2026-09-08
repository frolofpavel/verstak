// Решение о пробуждении постоянной задачи.
//
// Здесь опаснее всего ошибиться в сторону «просыпается»: фоновая задача тратит
// деньги и трогает файлы без человека рядом. Поэтому пины перечисляют условия
// ОТКАЗА поимённо, а рядом с каждым стоит случай, где та же задача просыпается —
// иначе «не проснулась» зелено и у функции, которая не будит никогда.
import { describe, it, expect } from 'vitest'
import {
  shouldWake,
  MIN_WAKE_INTERVAL_MS,
  MAX_RUNS_CAP,
  type PersistentJobV1,
  type JobSignal,
} from '../../shared/contracts/persistent-job'

const NOW = 1_800_000_000_000

const job = (over: Partial<PersistentJobV1> = {}): PersistentJobV1 => ({
  id: 'job-1',
  projectPath: '/p',
  title: 'Утренняя сводка',
  goal: 'Проверить активные задачи и подготовить краткую сводку',
  status: 'active',
  triggerKind: 'schedule',
  triggerConfig: { everyMinutes: 60 },
  state: {},
  nextAction: null,
  assignedCapabilityId: null,
  requiredCapabilities: [],
  budgetCents: null,
  maxRuntimeMs: null,
  maxRuns: 10,
  runsDone: 0,
  costUsedCents: 0,
  lastRunAt: null,
  nextRunAt: NOW - 1000,
  lastResult: null,
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 86_400_000,
  ...over,
})

const tick = (at = NOW): JobSignal => ({ kind: 'tick', at })

describe('созревшая задача просыпается', () => {
  it('пришло время — будим, и причина названа', () => {
    const r = shouldWake(job(), tick(), NOW)
    expect(r.wake).toBe(true)
    expect(r.why.length).toBeGreaterThan(3)
  })

  it('время ещё не пришло — не будим', () => {
    expect(shouldWake(job({ nextRunAt: NOW + 60_000 }), tick(), NOW).wake).toBe(false)
  })
})

describe('условия отказа названы поимённо', () => {
  it('на паузе не просыпается', () => {
    const r = shouldWake(job({ status: 'paused' }), tick(), NOW)
    expect(r.wake).toBe(false)
    expect(r.why).toMatch(/пауз/i)
  })

  for (const status of ['done', 'failed'] as const) {
    it(`завершённая (${status}) не просыпается`, () => {
      expect(shouldWake(job({ status }), tick(), NOW).wake).toBe(false)
    })
  }

  // Главная защита от вечного фонового расхода — та же, что у расписаний
  // headless-сервиса: задача без предела не создаётся, а исчерпавшая его встаёт.
  it('исчерпанный лимит запусков останавливает задачу навсегда', () => {
    const r = shouldWake(job({ maxRuns: 5, runsDone: 5 }), tick(), NOW)
    expect(r.wake).toBe(false)
    expect(r.why).toMatch(/лимит|запуск/i)
  })

  it('исчерпанный бюджет останавливает задачу', () => {
    const r = shouldWake(job({ budgetCents: 100, costUsedCents: 100 }), tick(), NOW)
    expect(r.wake).toBe(false)
    expect(r.why).toMatch(/бюджет/i)
  })

  // Слишком частое пробуждение — это тот же вечный расход, только растянутый.
  it('чаще минимального интервала не будим, даже если сигнал пришёл', () => {
    const r = shouldWake(job({ lastRunAt: NOW - 1000, nextRunAt: NOW - 1 }), tick(), NOW)
    expect(r.wake).toBe(false)
    expect(r.why).toMatch(/часто|интервал/i)
  })

  it('уже бежит — второй раз не запускаем', () => {
    expect(shouldWake(job({ status: 'running' }), tick(), NOW).wake).toBe(false)
  })

  // Контроль ко всей группе: та же задача без единого стоп-условия обязана
  // проснуться — иначе пины выше зелены у функции, которая не будит никогда.
  it('контроль: без стоп-условий та же задача просыпается', () => {
    expect(shouldWake(job({ lastRunAt: NOW - MIN_WAKE_INTERVAL_MS - 1 }), tick(), NOW).wake).toBe(true)
  })
})

describe('триггеры расширяемы, а не захардкожены под источник', () => {
  it('событийная задача спит на тике и просыпается на СВОЁМ событии', () => {
    const onEvent = job({ triggerKind: 'event', triggerConfig: { event: 'task.status-changed' }, nextRunAt: null })
    expect(shouldWake(onEvent, tick(), NOW).wake).toBe(false)
    expect(shouldWake(onEvent, { kind: 'event', name: 'task.status-changed', at: NOW }, NOW).wake).toBe(true)
  })

  it('чужое событие задачу не будит', () => {
    const onEvent = job({ triggerKind: 'event', triggerConfig: { event: 'task.status-changed' }, nextRunAt: null })
    expect(shouldWake(onEvent, { kind: 'event', name: 'file.changed', at: NOW }, NOW).wake).toBe(false)
  })

  it('ручная задача просыпается только по команде человека', () => {
    const manual = job({ triggerKind: 'manual', nextRunAt: null })
    expect(shouldWake(manual, tick(), NOW).wake).toBe(false)
    expect(shouldWake(manual, { kind: 'manual', at: NOW }, NOW).wake).toBe(true)
  })

  // Ручной запуск — воля человека, но не обход предохранителей: исчерпанный
  // бюджет не перестаёт быть исчерпанным оттого, что нажали кнопку.
  it('ручной запуск не обходит лимиты', () => {
    const manual = job({ triggerKind: 'manual', maxRuns: 3, runsDone: 3, nextRunAt: null })
    expect(shouldWake(manual, { kind: 'manual', at: NOW }, NOW).wake).toBe(false)
  })

  // Неизвестный вид триггера — отказ, а не догадка: задача, которую разбудили
  // «на всякий случай», тратит деньги без основания.
  it('неизвестный триггер не будит', () => {
    const weird = job({ triggerKind: 'что-то-новое' as PersistentJobV1['triggerKind'] })
    expect(shouldWake(weird, tick(), NOW).wake).toBe(false)
  })
})

describe('предел запусков объявлен и ограничен сверху', () => {
  it('потолок существует и он не бесконечный', () => {
    expect(MAX_RUNS_CAP).toBeGreaterThan(0)
    expect(Number.isFinite(MAX_RUNS_CAP)).toBe(true)
  })

  it('минимальный интервал не нулевой', () => {
    expect(MIN_WAKE_INTERVAL_MS).toBeGreaterThan(0)
  })
})
