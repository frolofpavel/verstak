import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createAgentRuns } from '../../electron/storage/agent-runs'

/**
 * Тесты storage-слоя Multi-agent Manager (Фаза 1) + миграции 16.
 * Падают по ABI (NODE_MODULE_VERSION) вместе с остальными sqlite-тестами —
 * это известный шум, не регрессия. Логику миграции/функций проверяем здесь.
 */
describe('agent-runs (migration 16)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-runs-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('миграция 16 создаёт таблицы agent_runs и agent_run_events', () => {
    const db = openDb(join(dir, 'test.db'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name)
    expect(tables).toContain('agent_runs')
    expect(tables).toContain('agent_run_events')
    db.close()
  })

  it('create → get: поля совпали, status=running, started_at проставлен', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    const before = Date.now()
    runs.create({
      runId: 'r1', projectPath: '/p', chatId: 7, title: 'Задача A',
      providerId: 'grok', model: 'grok-4', sendId: 42
    })
    const row = runs.get('r1')
    expect(row).not.toBeNull()
    expect(row!.runId).toBe('r1')
    expect(row!.projectPath).toBe('/p')
    expect(row!.chatId).toBe(7)
    expect(row!.owner).toBe('main')              // default
    expect(row!.title).toBe('Задача A')
    expect(row!.status).toBe('running')
    expect(row!.providerId).toBe('grok')
    expect(row!.model).toBe('grok-4')
    expect(row!.sendId).toBe(42)
    expect(row!.agentsCount).toBe(0)
    expect(row!.toolCount).toBe(0)
    expect(row!.filesCount).toBe(0)
    expect(row!.costCents).toBe(0)
    expect(row!.error).toBeNull()
    expect(row!.startedAt).toBeGreaterThanOrEqual(before)
    expect(row!.endedAt).toBeNull()
    db.close()
  })

  it('get несуществующего прогона → null', () => {
    const db = openDb(join(dir, 'test.db'))
    expect(createAgentRuns(db).get('nope')).toBeNull()
    db.close()
  })

  it('finish меняет status, ended_at и итоговые счётчики', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A' })
    runs.finish('r1', 'done', { costCents: 123, toolCount: 9, filesCount: 3, agentsCount: 2 })
    const row = runs.get('r1')!
    expect(row.status).toBe('done')
    expect(row.endedAt).not.toBeNull()
    expect(row.endedAt).toBeGreaterThan(0)
    expect(row.costCents).toBe(123)
    expect(row.toolCount).toBe(9)
    expect(row.filesCount).toBe(3)
    expect(row.agentsCount).toBe(2)
    db.close()
  })

  it('finish с error пишет текст ошибки и status=failed', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A' })
    runs.finish('r1', 'failed', { error: 'boom' })
    const row = runs.get('r1')!
    expect(row.status).toBe('failed')
    expect(row.error).toBe('boom')
    db.close()
  })

  it('finish идемпотентен по ended_at: stop→естественный finally не затирает stopped (Фаза 4)', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A' })
    // 1) Stop: agent-runs:stop пишет finish('stopped') первым.
    runs.finish('r1', 'stopped', {})
    const afterStop = runs.get('r1')!
    expect(afterStop.status).toBe('stopped')
    const endedAt = afterStop.endedAt
    expect(endedAt).not.toBeNull()
    // 2) Естественный finally runner'а по exitReason='aborted' тоже зовёт finish.
    //    Без guard'а WHERE ended_at IS NULL это затёрло бы статус и счётчики.
    runs.finish('r1', 'stopped', { toolCount: 99, costCents: 500, error: 'aborted' })
    const afterSecond = runs.get('r1')!
    expect(afterSecond.status).toBe('stopped')   // не изменился
    expect(afterSecond.endedAt).toBe(endedAt)    // ended_at тот же (первый финиш)
    expect(afterSecond.toolCount).toBe(0)        // второй finish — no-op
    expect(afterSecond.costCents).toBe(0)
    expect(afterSecond.error).toBeNull()
    db.close()
  })

  it('appendEvent + getEvents возвращает события в порядке id', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A' })
    runs.appendEvent('r1', 'user_msg', { label: 'первое', detail: 'd1' })
    runs.appendEvent('r1', 'tool_call', { label: 'второе', ref: 'read_file', status: 'ok' })
    runs.appendEvent('r1', 'status', { label: 'третье' })
    const events = runs.getEvents('r1')
    expect(events).toHaveLength(3)
    expect(events.map(e => e.label)).toEqual(['первое', 'второе', 'третье'])
    expect(events.map(e => e.kind)).toEqual(['user_msg', 'tool_call', 'status'])
    // id строго возрастает
    expect(events[0].id).toBeLessThan(events[1].id)
    expect(events[1].id).toBeLessThan(events[2].id)
    expect(events[1].ref).toBe('read_file')
    expect(events[1].status).toBe('ok')
    db.close()
  })

  it('appendEvent капит detail до 500 символов', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A' })
    runs.appendEvent('r1', 'tool_call', { detail: 'x'.repeat(900) })
    const events = runs.getEvents('r1')
    expect(events[0].detail).toHaveLength(500)
    db.close()
  })

  it('incr атомарно увеличивает счётчик', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A' })
    runs.incr('r1', 'tool_count')          // +1 default
    runs.incr('r1', 'tool_count', 4)       // +4
    runs.incr('r1', 'files_count', 2)
    runs.incr('r1', 'agents_count')
    const row = runs.get('r1')!
    expect(row.toolCount).toBe(5)
    expect(row.filesCount).toBe(2)
    expect(row.agentsCount).toBe(1)
    db.close()
  })

  it('list отдаёт новейшие первыми и фильтрует по status', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A' })
    runs.create({ runId: 'r2', projectPath: '/p', title: 'B' })
    runs.create({ runId: 'r3', projectPath: '/p', title: 'C' })
    runs.finish('r1', 'done')
    // Новейшие первыми (started_at DESC). r3 создан последним.
    const all = runs.list('/p')
    expect(all.map(r => r.runId)).toEqual(['r3', 'r2', 'r1'])
    // Фильтр по status.
    const done = runs.list('/p', { status: 'done' })
    expect(done.map(r => r.runId)).toEqual(['r1'])
    const running = runs.list('/p', { status: 'running' })
    expect(running.map(r => r.runId).sort()).toEqual(['r2', 'r3'])
    db.close()
  })

  it('list фильтрует по owner и уважает limit', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'm1', projectPath: '/p', title: 'main', owner: 'main' })
    runs.create({ runId: 'b1', projectPath: '/p', title: 'bg', owner: 'background' })
    runs.create({ runId: 'r1', projectPath: '/p', title: 'rev', owner: 'review' })
    const bg = runs.list('/p', { owner: 'background' })
    expect(bg.map(r => r.runId)).toEqual(['b1'])
    const limited = runs.list('/p', { limit: 2 })
    expect(limited).toHaveLength(2)
    db.close()
  })

  it('list изолирует прогоны по проекту', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'a', projectPath: '/p1', title: 'A' })
    runs.create({ runId: 'b', projectPath: '/p2', title: 'B' })
    expect(runs.list('/p1').map(r => r.runId)).toEqual(['a'])
    expect(runs.list('/p2').map(r => r.runId)).toEqual(['b'])
    db.close()
  })

  it('reconcileStale помечает зависшие running/queued (ended_at null) как failed', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    // r1 — зависший running (краш/выход без живого процесса), ended_at null.
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A' })
    // r2 — штатно завершён (done): reconcile его не трогает.
    runs.create({ runId: 'r2', projectPath: '/p', title: 'B' })
    runs.finish('r2', 'done')
    const reconciled = runs.reconcileStale()
    expect(reconciled).toBe(1)                       // только r1
    const r1 = runs.get('r1')!
    expect(r1.status).toBe('failed')                 // running → failed
    expect(r1.endedAt).not.toBeNull()                // проставлен ended_at
    const r2 = runs.get('r2')!
    expect(r2.status).toBe('done')                   // done не тронут
    db.close()
  })

  it('reconcileStale фильтрует по projectPath', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'a', projectPath: '/p1', title: 'A' })   // зависший
    runs.create({ runId: 'b', projectPath: '/p2', title: 'B' })   // зависший
    const reconciled = runs.reconcileStale('/p1')
    expect(reconciled).toBe(1)                       // только из /p1
    expect(runs.get('a')!.status).toBe('failed')
    expect(runs.get('b')!.status).toBe('running')    // /p2 не тронут
    db.close()
  })
})
