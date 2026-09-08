// Цикл пробуждения целиком: событие → работа → состояние → сон.
//
// Сценарий постановки проверяется целиком на настоящей базе: задача заводится,
// приложение «перезапускается», задача просыпается по триггеру, делает шаг,
// сохраняет результат и снова засыпает.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createPersistentJobs } from '../../electron/storage/persistent-jobs'
import { createJobEventBus } from '../../electron/jobs/event-bus'
import { handleSignal, reconcileStaleJobs } from '../../electron/jobs/wake-cycle'
import type { JobSignal } from '../../shared/contracts/persistent-job'

const NOW = 1_800_000_000_000

describe('шина событий', () => {
  it('подписчик получает опубликованный сигнал', () => {
    const bus = createJobEventBus()
    const seen: JobSignal[] = []
    bus.subscribe(s => seen.push(s))
    bus.publish({ kind: 'tick', at: NOW })
    expect(seen).toEqual([{ kind: 'tick', at: NOW }])
  })

  it('отписка работает', () => {
    const bus = createJobEventBus()
    const seen: JobSignal[] = []
    const off = bus.subscribe(s => seen.push(s))
    off()
    bus.publish({ kind: 'tick', at: NOW })
    expect(seen).toEqual([])
    expect(bus.size()).toBe(0)
  })

  // Один сломанный подписчик не имеет права глушить чужие пробуждения: шина —
  // общий ресурс.
  it('падение одного подписчика не мешает остальным', () => {
    const bus = createJobEventBus()
    const seen: string[] = []
    bus.subscribe(() => { throw new Error('сломался') })
    bus.subscribe(() => seen.push('второй жив'))
    expect(() => bus.publish({ kind: 'tick', at: NOW })).not.toThrow()
    expect(seen).toEqual(['второй жив'])
  })
})

describe('цикл пробуждения', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-cycle-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const open = () => openDb(join(dir, 'test.db'))

  const seed = (db: ReturnType<typeof open>, over = {}) => {
    const jobs = createPersistentJobs(db)
    jobs.create({
      id: 'brief',
      projectPath: '/p',
      title: 'Утренняя сводка',
      goal: 'Проверить активные задачи и подготовить краткую сводку владельцу',
      triggerKind: 'schedule',
      triggerConfig: { everyMinutes: 60 },
      maxRuns: 10,
      nextRunAt: NOW - 1000,
      ...over,
    })
    return jobs
  }

  // Сценарий из постановки целиком.
  it('задача переживает перезапуск, просыпается, работает и снова засыпает', async () => {
    const first = open()
    seed(first)
    first.close()

    // «Перезапуск приложения»: новое соединение, состояние только из базы.
    const second = open()
    const jobs = createPersistentJobs(second)
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      result: 'три задачи в работе, одна просрочена',
      state: { lastCheckedAt: NOW },
      nextAction: 'сравнить с прошлым разом',
      costCents: 4,
    })

    const report = await handleSignal({ jobs, execute, now: () => NOW }, { kind: 'tick', at: NOW })
    expect(report.woken).toEqual(['brief'])
    expect(execute).toHaveBeenCalledTimes(1)

    const after = jobs.get('brief')!
    expect(after.status).toBe('active')          // снова спит, а не «выполняется»
    expect(after.runsDone).toBe(1)
    expect(after.state).toEqual({ lastCheckedAt: NOW })
    expect(after.lastResult).toContain('просрочена')
    expect(after.nextRunAt).toBe(NOW + 60 * 60_000)
    second.close()
  })

  it('несозревшая задача не будится, и причина названа', async () => {
    const db = open()
    const jobs = createPersistentJobs(db)
    seed(db, { nextRunAt: NOW + 60_000 })
    const execute = vi.fn()
    const report = await handleSignal({ jobs, execute, now: () => NOW }, { kind: 'tick', at: NOW })
    expect(execute).not.toHaveBeenCalled()
    expect(report.woken).toEqual([])
    expect(report.skipped[0].why.length).toBeGreaterThan(3)
    db.close()
  })

  it('упавший исполнитель не оставляет задачу в «выполняется»', async () => {
    const db = open()
    const jobs = createPersistentJobs(db)
    seed(db)
    const execute = vi.fn().mockRejectedValue(new Error('провайдер недоступен'))
    await handleSignal({ jobs, execute, now: () => NOW }, { kind: 'tick', at: NOW })
    const after = jobs.get('brief')!
    expect(after.status).toBe('failed')
    expect(after.lastResult).toContain('провайдер')
    db.close()
  })

  it('событийная задача просыпается по своему событию, а не по тику', async () => {
    const db = open()
    const jobs = createPersistentJobs(db)
    seed(db, { id: 'on-task', triggerKind: 'event', triggerConfig: { event: 'task.status-changed' }, nextRunAt: null })
    jobs.remove('brief')
    const execute = vi.fn().mockResolvedValue({ ok: true, result: 'ок', state: {}, nextAction: null, costCents: 0 })

    await handleSignal({ jobs, execute, now: () => NOW }, { kind: 'tick', at: NOW })
    expect(execute).not.toHaveBeenCalled()

    await handleSignal({ jobs, execute, now: () => NOW }, { kind: 'event', name: 'task.status-changed', at: NOW })
    expect(execute).toHaveBeenCalledTimes(1)
    db.close()
  })
})

describe('после падения приложения деструктив не повторяется', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-stale-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const open = () => openDb(join(dir, 'test.db'))

  // ГЛАВНЫЙ ПИН безопасности фоновых задач. После падения НЕИЗВЕСТНО, успело ли
  // пробуждение выполнить своё действие. Вернуть задачу в активные значит
  // рискнуть повторить его — второй платёж, вторую отправку, второе удаление.
  it('застрявшая в «выполняется» уходит на паузу, а не в активные', () => {
    const first = open()
    const jobs = createPersistentJobs(first)
    jobs.create({ id: 'risky', projectPath: '/p', title: 'Оплата', goal: 'Оплатить счёт', triggerKind: 'schedule', triggerConfig: { everyMinutes: 60 }, maxRuns: 5, nextRunAt: NOW - 1 })
    jobs.claim('risky')            // приложение упало ровно здесь
    first.close()

    const second = open()
    const restored = createPersistentJobs(second)
    expect(restored.get('risky')!.status).toBe('running')
    expect(reconcileStaleJobs(restored)).toEqual(['risky'])
    expect(restored.get('risky')!.status).toBe('paused')
    second.close()
  })

  it('на паузе задача не просыпается никаким сигналом', async () => {
    const db = open()
    const jobs = createPersistentJobs(db)
    jobs.create({ id: 'risky', projectPath: '/p', title: 'Оплата', goal: 'Оплатить счёт', triggerKind: 'schedule', triggerConfig: { everyMinutes: 60 }, maxRuns: 5, nextRunAt: NOW - 1 })
    jobs.claim('risky')
    reconcileStaleJobs(jobs)
    const execute = vi.fn()
    await handleSignal({ jobs, execute, now: () => NOW }, { kind: 'tick', at: NOW })
    expect(execute).not.toHaveBeenCalled()
    db.close()
  })

  // Контроль: здоровая задача этой уборкой НЕ трогается — иначе пины выше зелены
  // и у реализации, которая ставит на паузу всё подряд.
  it('контроль: активную задачу уборка не трогает', () => {
    const db = open()
    const jobs = createPersistentJobs(db)
    jobs.create({ id: 'ok', projectPath: '/p', title: 'Сводка', goal: 'Сводка', triggerKind: 'schedule', triggerConfig: { everyMinutes: 60 }, maxRuns: 5, nextRunAt: NOW - 1 })
    expect(reconcileStaleJobs(jobs)).toEqual([])
    expect(jobs.get('ok')!.status).toBe('active')
    db.close()
  })
})
