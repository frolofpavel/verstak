import { describe, it, expect } from 'vitest'
import { schedulerHealth, schedulerPromptLifecycleRisk, selectDueTasks } from '../../electron/ipc/scheduler'
import type { TimeParts } from '../../electron/ai/schedule-parse'
import type { ScheduledTask } from '../../electron/storage/scheduled-tasks'

const mk = (over: Partial<ScheduledTask>): ScheduledTask => ({
  id: 1, project_path: '/p', prompt: 'x', cron: '0 9 * * *', human: '', enabled: true,
  provider_id: null, model: null, created_at: 0, last_run_at: null, last_status: null,
  last_result: null, last_run_minute: null, last_heartbeat_at: null, next_run_at: null, ...over,
})

const at = (p: Partial<TimeParts>): TimeParts => ({ minute: 0, hour: 9, dom: 1, month: 1, dow: 3, ...p })

describe('selectDueTasks', () => {
  it('запускает задачу, чей cron совпал с текущей минутой', () => {
    const due = selectDueTasks([mk({ cron: '0 9 * * *' })], at({ minute: 0, hour: 9 }), 1000)
    expect(due).toHaveLength(1)
  })

  it('НЕ запускает, если cron не совпал', () => {
    expect(selectDueTasks([mk({ cron: '0 9 * * *' })], at({ minute: 0, hour: 10 }), 1000)).toHaveLength(0)
  })

  it('НЕ запускает выключенную задачу', () => {
    expect(selectDueTasks([mk({ enabled: false })], at({ minute: 0, hour: 9 }), 1000)).toHaveLength(0)
  })

  it('анти-двойное срабатывание: last_run_minute == minuteIdx → не запускаем повторно', () => {
    expect(selectDueTasks([mk({ last_run_minute: 1000 })], at({ minute: 0, hour: 9 }), 1000)).toHaveLength(0)
    // но в СЛЕДУЮЩУЮ минуту того же часа cron уже не совпадёт (minute 0 only) — корректно
    expect(selectDueTasks([mk({ last_run_minute: 999 })], at({ minute: 0, hour: 9 }), 1000)).toHaveLength(1)
  })

  it('из нескольких — только подходящие', () => {
    const tasks = [
      mk({ id: 1, cron: '0 9 * * *' }),     // due
      mk({ id: 2, cron: '0 21 * * *' }),    // не due (вечер)
      mk({ id: 3, cron: '0 9 * * 1-5', enabled: false }), // выключена
    ]
    const due = selectDueTasks(tasks, at({ minute: 0, hour: 9, dow: 3 }), 1000)
    expect(due.map(t => t.id)).toEqual([1])
  })
})

describe('schedulerHealth', () => {
  it('marks scheduler stalled after 3 minutes without heartbeat', () => {
    expect(schedulerHealth(1_000, 1_000 + 180_001).stalled).toBe(true)
    expect(schedulerHealth(1_000, 1_000 + 179_999).stalled).toBe(false)
  })

  it('reports no heartbeat as unknown, not stalled', () => {
    const health = schedulerHealth(null, 10_000)
    expect(health.heartbeatAgeMs).toBeNull()
    expect(health.stalled).toBe(false)
  })
})

describe('schedulerPromptLifecycleRisk', () => {
  it('rejects lifecycle-control prompts', () => {
    expect(schedulerPromptLifecycleRisk('каждую ночь restart Verstak')).toContain('Verstak')
    expect(schedulerPromptLifecycleRisk('kill scheduler if it hangs')).toContain('планировщик')
    expect(schedulerPromptLifecycleRisk('shutdown the computer')).toContain('систем')
  })

  it('allows normal outbound report prompts', () => {
    expect(schedulerPromptLifecycleRisk('проверь новые заказы и отправь сводку')).toBeNull()
  })
})
