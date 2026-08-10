// C1 (P5, пакет 2.5.0): исполнитель расписания headless-сервиса.
//
// Закреплено: (1) просроченная задача запускается при «закрытом окне» — прямым
// tick без GUI; (2) расписание переживает перезапуск — второй scheduler над ТОЙ ЖЕ
// sqlite продолжает с места, где остановился первый, и не навёрстывает пропуски;
// (3) объявленный лимит итераций тратится и исчерпывается; (4) прогон расписания
// идёт ЖЁСТКО в agentMode='auto', а в 'auto' план-гейт не применяется по
// построению — пин с зеркальным контролем ('ask' → применяется), иначе «не
// получает план-гейт» было бы утверждением на веру.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createScheduledJobs } from '../../electron/storage/scheduled-jobs'
import { startScheduler } from '../../electron/headless/scheduler'
import { planGateApplies } from '../../electron/ai/plan-gate-modes'

describe('headless scheduler', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let jobs: ReturnType<typeof createScheduledJobs>
  const NOW = 1_700_000_000_000
  let clock = NOW

  const started: Array<{ prompt: string; agentMode: string }> = []
  const startTask = vi.fn(async (opts: { prompt: string; agentMode: 'auto' }) => {
    started.push({ prompt: opts.prompt, agentMode: opts.agentMode })
    return { runId: `run-${started.length}`, completion: Promise.resolve() }
  })

  function makeScheduler() {
    // pollMs: null — без таймера; время подаём сами (детерминизм, §3.1).
    return startScheduler({ jobs, startTask, pollMs: null, now: () => clock })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-scheduler-'))
    db = openDb(join(dir, 'test.db'))
    jobs = createScheduledJobs(db)
    clock = NOW
    started.length = 0
    startTask.mockClear()
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('просроченная задача запускается tick-ом; agentMode ЖЁСТКО auto (пин)', async () => {
    jobs.create({ name: 'ревизия', prompt: 'прогони ревизию', schedule: { kind: 'once', runAt: NOW - 1000 }, maxRuns: 1 }, NOW - 2000)
    const s = makeScheduler()
    const n = await s.tick()
    expect(n).toBe(1)
    expect(started).toEqual([{ prompt: 'прогони ревизию', agentMode: 'auto' }])
    const job = jobs.list()[0]
    expect(job.lastRunId).toBe('run-1')
    expect(job.enabled).toBe(false)  // once исполнена и выключена
    s.stop()
  })

  it('пин план-гейта: в auto гейт НЕ применяется даже при включённой настройке; контроль — в ask применяется', () => {
    // Ровно вход unattended-прогона расписания: режим auto, настройка включена.
    expect(planGateApplies({ agentMode: 'auto', planApprovalSetting: true })).toBe(false)
    // Зеркальный контроль (§3.1): тот же вход с ask даёт true — проверка не пустая.
    expect(planGateApplies({ agentMode: 'ask', planApprovalSetting: true })).toBe(true)
  })

  it('перезапуск сервиса: второй scheduler над той же sqlite продолжает, третьего запуска нет', async () => {
    jobs.create({ name: 'j', prompt: 'p', schedule: { kind: 'interval', everyMinutes: 10 }, maxRuns: 2 }, NOW - 11 * 60_000)
    const s1 = makeScheduler()
    expect(await s1.tick()).toBe(1)   // первый запуск
    s1.stop()

    // «Перезапуск»: новое хранилище и новый scheduler над тем же файлом БД.
    const jobs2 = createScheduledJobs(db)
    const s2 = startScheduler({ jobs: jobs2, startTask, pollMs: null, now: () => clock })
    expect(await s2.tick(), 'сразу после рестарта задача не due — не навёрстывает').toBe(0)

    clock = NOW + 10 * 60_000 + 1000  // подошёл следующий интервал
    expect(await s2.tick()).toBe(1)   // второй (последний по лимиту) запуск
    expect(startTask).toHaveBeenCalledTimes(2)

    clock = NOW + 100 * 60_000
    expect(await s2.tick(), 'лимит итераций исчерпан, а задача запустилась снова').toBe(0)
    expect(startTask).toHaveBeenCalledTimes(2)
    s2.stop()
  })

  it('ошибка старта: след в last_error, итерация потрачена, немедленного ретрая нет', async () => {
    jobs.create({ name: 'j', prompt: 'p', schedule: { kind: 'interval', everyMinutes: 10 }, maxRuns: 3 }, NOW - 11 * 60_000)
    startTask.mockRejectedValueOnce(new Error('нет ключа провайдера'))
    const s = makeScheduler()
    expect(await s.tick()).toBe(1)
    const job = jobs.list()[0]
    expect(job.lastError).toBe('нет ключа провайдера')
    expect(job.runsDone).toBe(1)
    expect(await s.tick(), 'битая задача ретраится в том же tick-цикле').toBe(0)
    s.stop()
  })
})
