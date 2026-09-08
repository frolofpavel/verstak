// Постоянная задача в НАСТОЯЩЕЙ базе: переживание перезапуска, состояние между
// пробуждениями и предохранители, без которых фоновая работа превращается в
// вечный расход.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createPersistentJobs, type PersistentJobInput } from '../../electron/storage/persistent-jobs'
import { MAX_RUNS_CAP } from '../../shared/contracts/persistent-job'

const input = (over: Partial<PersistentJobInput> = {}): PersistentJobInput => ({
  id: 'job-1',
  projectPath: '/p',
  title: 'Утренняя сводка',
  goal: 'Проверить активные задачи и подготовить краткую сводку владельцу',
  triggerKind: 'schedule',
  triggerConfig: { everyMinutes: 60 },
  maxRuns: 10,
  ...over,
})

describe('постоянная задача переживает перезапуск', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-jobs-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const open = () => openDb(join(dir, 'test.db'))

  it('заведённая задача читается после переоткрытия базы', () => {
    const first = open()
    createPersistentJobs(first).create(input())
    first.close()

    const second = open()
    const job = createPersistentJobs(second).get('job-1')
    expect(job?.title).toBe('Утренняя сводка')
    expect(job?.status).toBe('active')
    expect(job?.triggerConfig).toEqual({ everyMinutes: 60 })
    second.close()
  })

  // Ради этого свойства задача и заведена: сегодняшние расписания перезапускают
  // промпт с нуля и ничего не помнят.
  it('состояние доезжает до следующего пробуждения через перезапуск', () => {
    const first = open()
    const jobs = createPersistentJobs(first)
    jobs.create(input())
    jobs.claim('job-1')
    jobs.complete('job-1', {
      ok: true,
      result: 'сводка готова',
      state: { lastSeenTaskId: 42, повторов: 1 },
      nextAction: 'сравнить с прошлым разом',
      costCents: 7,
      nextRunAt: 1_800_000_000_000,
    })
    first.close()

    const second = open()
    const job = createPersistentJobs(second).get('job-1')!
    expect(job.state).toEqual({ lastSeenTaskId: 42, повторов: 1 })
    expect(job.nextAction).toBe('сравнить с прошлым разом')
    expect(job.status).toBe('active')
    expect(job.runsDone).toBe(1)
    expect(job.costUsedCents).toBe(7)
    second.close()
  })
})

describe('предохранители', () => {
  let dir: string
  let db: Database
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-jobs2-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('задача без предела запусков не создаётся вовсе', () => {
    const jobs = createPersistentJobs(db)
    expect(() => jobs.create(input({ maxRuns: 0 }))).toThrow(/предел/i)
    expect(() => jobs.create(input({ maxRuns: MAX_RUNS_CAP + 1 }))).toThrow(/предел/i)
  })

  // Контроль: законный предел обязан приниматься — иначе пин выше зелен и у
  // реализации, которая не создаёт задач вообще.
  it('контроль: задача с законным пределом создаётся', () => {
    expect(() => createPersistentJobs(db).create(input({ maxRuns: MAX_RUNS_CAP }))).not.toThrow()
  })

  // Захват атомарен: два тика, пришедшие одновременно, не должны запустить одну
  // задачу дважды — иначе фоновая работа удваивает и расход, и правки файлов.
  it('второй захват той же задачи не проходит', () => {
    const jobs = createPersistentJobs(db)
    jobs.create(input())
    expect(jobs.claim('job-1')).toBe(true)
    expect(jobs.claim('job-1')).toBe(false)
  })

  it('исчерпав предел, задача переходит в завершённые и не ждёт следующего раза', () => {
    const jobs = createPersistentJobs(db)
    jobs.create(input({ maxRuns: 1 }))
    jobs.claim('job-1')
    jobs.complete('job-1', { ok: true, result: 'готово', state: {}, nextAction: null, costCents: 1, nextRunAt: Date.now() + 3_600_000 })
    const job = jobs.get('job-1')!
    expect(job.status).toBe('done')
    expect(job.nextRunAt).toBeNull()
  })

  it('упавшая задача не планирует следующее пробуждение сама', () => {
    const jobs = createPersistentJobs(db)
    jobs.create(input())
    jobs.claim('job-1')
    jobs.complete('job-1', { ok: false, result: 'провайдер недоступен', state: {}, nextAction: null, costCents: 0, nextRunAt: Date.now() + 3_600_000 })
    const job = jobs.get('job-1')!
    expect(job.status).toBe('failed')
    expect(job.nextRunAt).toBeNull()
    expect(job.lastResult).toContain('провайдер')
  })

  // Контроль: успешная задача с оставшимся запасом обязана вернуться в строй —
  // иначе пины выше зелены и у реализации, которая всё завершает после первого раза.
  it('контроль: успешная задача с запасом возвращается в активные и получает время', () => {
    const jobs = createPersistentJobs(db)
    jobs.create(input({ maxRuns: 5 }))
    jobs.claim('job-1')
    const next = Date.now() + 3_600_000
    jobs.complete('job-1', { ok: true, result: 'ок', state: {}, nextAction: null, costCents: 1, nextRunAt: next })
    const job = jobs.get('job-1')!
    expect(job.status).toBe('active')
    expect(job.nextRunAt).toBe(next)
  })

  it('задача, сказавшая «закончил», больше не просыпается даже с запасом', () => {
    const jobs = createPersistentJobs(db)
    jobs.create(input({ maxRuns: 50 }))
    jobs.claim('job-1')
    jobs.complete('job-1', { ok: true, result: 'цель достигнута', state: {}, nextAction: null, costCents: 1, nextRunAt: Date.now() + 60_000, finished: true })
    expect(jobs.get('job-1')!.status).toBe('done')
  })

  // Битое состояние не должно ронять весь список: одна испорченная запись иначе
  // сделала бы недоступными все задачи проекта.
  it('битый JSON состояния не роняет чтение', () => {
    const jobs = createPersistentJobs(db)
    jobs.create(input())
    db.prepare('UPDATE persistent_jobs SET state_json = ? WHERE id = ?').run('{это не json', 'job-1')
    expect(jobs.get('job-1')?.state).toEqual({})
    expect(jobs.list('/p').length).toBe(1)
  })
})
