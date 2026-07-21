import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createAgentRuns, isAutoResumable, pickResumeGuardTool } from '../../electron/storage/agent-runs'
import { saveRunInput } from '../../electron/storage/run-inputs'

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
    expect(row!.generation).toBe(0)
    expect(row!.agentsCount).toBe(0)
    expect(row!.toolCount).toBe(0)
    expect(row!.filesCount).toBe(0)
    expect(row!.costCents).toBe(0)
    expect(row!.error).toBeNull()
    expect(row!.startedAt).toBeGreaterThanOrEqual(before)
    expect(row!.endedAt).toBeNull()
    db.close()
  })

  it('2.0.7-F: requested (route override) пишется ОТДЕЛЬНО от actual (provider_id/model)', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    // Пользователь запросил grok на один prompt, но fallback увёл на claude (actual).
    runs.create({
      runId: 'rq', projectPath: '/p', title: 'route',
      providerId: 'claude', model: 'claude-sonnet-4-6',           // actual (после fallback)
      requestedProviderId: 'grok', requestedModel: 'grok-4.5',    // requested (override)
    })
    const row = runs.get('rq')!
    // DoD: after-send можно сверить actual vs requested.
    expect(row.providerId).toBe('claude')
    expect(row.model).toBe('claude-sonnet-4-6')
    expect(row.requestedProviderId).toBe('grok')
    expect(row.requestedModel).toBe('grok-4.5')
    db.close()
  })

  it('2.0.7-F: updateActual после fallback меняет actual, requested остаётся (честный vs)', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({
      runId: 'rf', projectPath: '/p', title: 'fb',
      providerId: 'grok', model: 'grok-4.5',            // actual = запрошенный (до fallback)
      requestedProviderId: 'grok', requestedModel: 'grok-4.5',
    })
    // Fallback увёл на claude — actual обновился, requested НЕ трогаем.
    runs.updateActual('rf', 'claude', 'claude-sonnet-4-6')
    const row = runs.get('rf')!
    expect(row.providerId).toBe('claude')             // actual = кто реально отработал
    expect(row.model).toBe('claude-sonnet-4-6')
    expect(row.requestedProviderId).toBe('grok')      // requested неизменен
    expect(row.requestedModel).toBe('grok-4.5')
    // Завершённый прогон updateActual НЕ трогает.
    runs.finish('rf', 'done')
    runs.updateActual('rf', 'openai', 'gpt-5')
    expect(runs.get('rf')!.providerId).toBe('claude')
    db.close()
  })

  it('2.0.7-F: без override requested = null (запрошенное == дефолт чата)', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'rn', projectPath: '/p', title: 't', providerId: 'claude', model: 'claude-sonnet-4-6' })
    const row = runs.get('rn')!
    expect(row.requestedProviderId).toBeNull()
    expect(row.requestedModel).toBeNull()
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
    expect(runs.getEvents('r1').filter(e => e.kind === 'status' && e.label === 'terminal')).toHaveLength(1)
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
    expect(runs.getEvents('r1').filter(e => e.kind === 'status' && e.label === 'terminal')).toHaveLength(1)
    db.close()
  })

  // EF-R1 Б4: finish сообщает, совершил ли ИМЕННО ЭТОТ вызов первый терминальный
  // переход — обёртка успеха (last_success_at) вешается только на transitioned=true.
  it('Б4: finish возвращает true на первом терминальном переходе, false на повторном', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A' })
    expect(runs.finish('r1', 'stopped', {})).toBe(true)
    expect(runs.finish('r1', 'done', {})).toBe(false)   // поздний done — НЕ переход
    expect(runs.finish('r1', 'done', {})).toBe(false)
    expect(runs.finish('missing-run', 'done', {})).toBe(false)
    expect(runs.get('r1')!.status).toBe('stopped')
    db.close()
  })

  // EF-R1 Б3: account_id фиксируется при create и обновляется ротацией (только живой).
  it('Б3: create сохраняет accountId; updateActualAccount обновляет ТОЛЬКО живой прогон', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A', accountId: 11 })
    runs.create({ runId: 'r2', projectPath: '/p', title: 'B' }) // legacy: account_id NULL
    expect(runs.get('r1')!.accountId).toBe(11)
    expect(runs.get('r2')!.accountId).toBeNull()
    runs.updateActualAccount('r1', 22) // ротация аккаунта внутри прогона
    expect(runs.get('r1')!.accountId).toBe(22)
    runs.finish('r1', 'done', {})
    runs.updateActualAccount('r1', 33) // завершённый не переписываем
    expect(runs.get('r1')!.accountId).toBe(22)
    db.close()
  })

  it('finish(timed_out) round-trip для runtime watchdog', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A' })
    runs.finish('r1', 'timed_out', { error: 'timeout' })
    const row = runs.get('r1')!
    expect(row.status).toBe('timed_out')
    expect(row.error).toBe('timeout')
    expect(row.endedAt).not.toBeNull()
    expect(runs.getEvents('r1').filter(e => e.kind === 'status' && e.label === 'terminal')).toHaveLength(1)
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
    expect(runs.get('r1')!.lastEventAt).toBeGreaterThan(0)
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

  it('reconcileStale помечает зависшие running/queued (ended_at null) как interrupted', () => {
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
    expect(r1.status).toBe('interrupted')            // running → interrupted
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
    expect(runs.get('a')!.status).toBe('interrupted')
    expect(runs.get('b')!.status).toBe('running')    // /p2 не тронут
    db.close()
  })
})

/**
 * Crash-resume (P1) — миграция 19 (ALTER agent_runs) + tick + findResumable
 * + гард деструктива isAutoResumable.
 */
describe('agent-runs lifecycle generation (migration 39)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-runs-gen-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('migration 39 adds generation column to agent_runs', () => {
    const db = openDb(join(dir, 'test.db'))
    const cols = (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('generation')
    db.close()
  })

  it('migration 41 allows timed_out status in agent_runs', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'timeout', projectPath: '/p', title: 'Timeout' })
    expect(() => runs.finish('timeout', 'timed_out', { error: 'timeout' })).not.toThrow()
    expect(runs.get('timeout')!.status).toBe('timed_out')
    db.close()
  })

  it('create increments generation per project/chat/owner lane', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)

    expect(runs.create({ runId: 'r1', projectPath: '/p', chatId: 7, title: 'A' })).toBe(0)
    expect(runs.create({ runId: 'r2', projectPath: '/p', chatId: 7, title: 'B' })).toBe(1)
    expect(runs.create({ runId: 'r3', projectPath: '/p', chatId: 8, title: 'C' })).toBe(0)
    expect(runs.create({ runId: 'r4', projectPath: '/p', chatId: 7, owner: 'review', title: 'D' })).toBe(0)

    expect(runs.get('r1')!.generation).toBe(0)
    expect(runs.get('r2')!.generation).toBe(1)
    expect(runs.get('r3')!.generation).toBe(0)
    expect(runs.get('r4')!.generation).toBe(0)
    db.close()
  })
})

describe('crash-resume (migration 19)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-resume-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('миграция 19 добавляет колонки живого прогресса в agent_runs', () => {
    const db = openDb(join(dir, 'test.db'))
    const cols = (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('turn_index')
    expect(cols).toContain('last_tool_name')
    expect(cols).toContain('last_checkpoint_id')
    expect(cols).toContain('agent_mode')
    expect(cols).toContain('updated_at')
    db.close()
  })

  it('create пишет agent_mode + начальный turn_index=0 + updated_at', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A', agentMode: 'ask' })
    const row = runs.get('r1')!
    expect(row.agentMode).toBe('ask')
    expect(row.turnIndex).toBe(0)
    expect(row.updatedAt).not.toBeNull()
    db.close()
  })

  it('tick пишет живой прогресс только для незавершённого прогона', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r1', projectPath: '/p', title: 'A', agentMode: 'ask' })
    runs.tick('r1', { turnIndex: 3, lastToolName: 'read_file', lastCheckpointId: 42 })
    const row = runs.get('r1')!
    expect(row.turnIndex).toBe(3)
    expect(row.lastToolName).toBe('read_file')
    expect(row.lastCheckpointId).toBe(42)
    // После finish тик-«догон» не воскрешает прогон (ended_at IS NULL guard).
    runs.finish('r1', 'done')
    runs.tick('r1', { turnIndex: 99, lastToolName: 'write_file' })
    const after = runs.get('r1')!
    expect(after.turnIndex).toBe(3)                 // не изменился
    expect(after.lastToolName).toBe('read_file')
    db.close()
  })

  it('isAutoResumable: read-only последний tool + безопасный режим → true', () => {
    expect(isAutoResumable({ lastToolName: 'read_file', agentMode: 'ask' })).toBe(true)
    expect(isAutoResumable({ lastToolName: null, agentMode: 'accept-edits' })).toBe(true)
    expect(isAutoResumable({ lastToolName: 'get_project_map', agentMode: 'plan' })).toBe(true)
  })

  it('isAutoResumable: деструктивный последний tool → false (не доигрываем)', () => {
    expect(isAutoResumable({ lastToolName: 'write_file', agentMode: 'ask' })).toBe(false)
    expect(isAutoResumable({ lastToolName: 'apply_patch', agentMode: 'ask' })).toBe(false)
    expect(isAutoResumable({ lastToolName: 'run_command', agentMode: 'ask' })).toBe(false)
    expect(isAutoResumable({ lastToolName: 'ssh', agentMode: 'accept-edits' })).toBe(false)
    expect(isAutoResumable({ lastToolName: 'delegate_task', agentMode: 'ask' })).toBe(false)
    expect(isAutoResumable({ lastToolName: 'connector_query', agentMode: 'ask' })).toBe(false)
  })

  it('isAutoResumable: режим auto/bypass → false даже при read-only tool', () => {
    expect(isAutoResumable({ lastToolName: 'read_file', agentMode: 'auto' })).toBe(false)
    expect(isAutoResumable({ lastToolName: 'read_file', agentMode: 'bypass' })).toBe(false)
    expect(isAutoResumable({ lastToolName: null, agentMode: 'bypass' })).toBe(false)
  })

  it('isAutoResumable: CLI-провайдер → false ВСЕГДА (деструктив невидим, дыра CLI-слепоты)', () => {
    // На CLI-пути tick не пишется → lastToolName=NULL, что без этого гарда ложно
    // проходило бы как read-only → авто-resume = повтор деструктива (аудит P0).
    for (const id of ['claude-cli', 'codex-cli', 'gemini-cli', 'grok-cli']) {
      expect(isAutoResumable({ lastToolName: null, agentMode: 'ask', providerId: id })).toBe(false)
      // даже с явно read-only last tool и безопасным режимом — всё равно false
      expect(isAutoResumable({ lastToolName: 'read_file', agentMode: 'accept-edits', providerId: id })).toBe(false)
    }
    // API-провайдер с теми же безопасными признаками остаётся резюмируемым
    expect(isAutoResumable({ lastToolName: 'read_file', agentMode: 'ask', providerId: 'claude' })).toBe(true)
    expect(isAutoResumable({ lastToolName: null, agentMode: 'ask', providerId: null })).toBe(true)
  })

  it('pickResumeGuardTool: мутирующий tool turn’а побеждает последний (read)', () => {
    // write→run→read в одном turn: гард должен взять деструктив, а не read.
    expect(pickResumeGuardTool(['read_file', 'write_file', 'read_file'])).toBe('write_file')
    expect(pickResumeGuardTool(['search_project', 'run_command', 'get_project_map'])).toBe('run_command')
    expect(pickResumeGuardTool(['connector_query', 'read_file'])).toBe('connector_query')
    // нет мутирующих → последний инструмент
    expect(pickResumeGuardTool(['read_file', 'search_project', 'get_project_map'])).toBe('get_project_map')
    expect(pickResumeGuardTool([])).toBe(null)
  })

  it('findResumable: возвращает зависшие на этом старте + гард деструктива + только с run_inputs', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    // safe — read-only последний tool, режим ask, есть run_input → autoResumable.
    runs.create({ runId: 'safe', projectPath: '/p', chatId: 1, title: 'Безопасная', agentMode: 'ask' })
    runs.tick('safe', { turnIndex: 2, lastToolName: 'read_file' })
    saveRunInput(db, { runId: 'safe', projectPath: '/p', chatId: 1, timestamp: Date.now(), providerId: 'grok', model: 'g', systemPrompt: 's', userMessage: 'почини баг X' })
    // destr — write_file последний → autoResumable=false (показать что было).
    runs.create({ runId: 'destr', projectPath: '/p', chatId: 1, title: 'Деструктив', agentMode: 'ask' })
    runs.tick('destr', { turnIndex: 5, lastToolName: 'write_file' })
    saveRunInput(db, { runId: 'destr', projectPath: '/p', chatId: 1, timestamp: Date.now(), providerId: 'grok', model: 'g', systemPrompt: 's', userMessage: 'перепиши модуль Y' })
    // noinput — без run_inputs → не предлагается (re-send невозможен).
    runs.create({ runId: 'noinput', projectPath: '/p', chatId: 1, title: 'Без ввода', agentMode: 'ask' })
    runs.tick('noinput', { turnIndex: 1, lastToolName: 'read_file' })

    // Метка реконсайла фиксируется ДО reconcileStale (как в main.ts).
    const reconciledAt = Date.now()
    runs.reconcileStale('/p')   // running → failed, ended_at >= reconciledAt

    const getUserReq = (runId: string) => {
      const r = db.prepare('SELECT user_message FROM run_inputs WHERE run_id = ?').get(runId) as { user_message: string | null } | undefined
      return r?.user_message || null
    }
    const list = runs.findResumable('/p', reconciledAt, getUserReq)
    const byId = Object.fromEntries(list.map(r => [r.runId, r]))
    // noinput отсеян (нет run_inputs).
    expect(byId['noinput']).toBeUndefined()
    // safe — предлагается с autoResumable=true.
    expect(byId['safe']).toBeDefined()
    expect(byId['safe'].autoResumable).toBe(true)
    expect(byId['safe'].lastUserRequest).toBe('почини баг X')
    expect(byId['safe'].turnIndex).toBe(2)
    // destr — предлагается, но autoResumable=false (деструктив не доигрываем).
    expect(byId['destr']).toBeDefined()
    expect(byId['destr'].autoResumable).toBe(false)
    expect(byId['destr'].lastToolName).toBe('write_file')
    db.close()
  })

  it('findResumable: прогон, упавший РАНЬШЕ этого старта (ended_at < reconciledAt), не предлагается', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    // Прогон реально упал с ошибкой ДО текущего старта app.
    runs.create({ runId: 'old', projectPath: '/p', chatId: 1, title: 'Старый', agentMode: 'ask' })
    runs.finish('old', 'failed', { error: 'boom' })
    saveRunInput(db, { runId: 'old', projectPath: '/p', chatId: 1, timestamp: Date.now(), providerId: 'g', model: 'g', systemPrompt: 's', userMessage: 'старый запрос' })
    // Текущий старт реконсайлит ПОЗЖЕ — old.ended_at < reconciledAt.
    const reconciledAt = Date.now() + 1000
    const getUserReq = (runId: string) => {
      const r = db.prepare('SELECT user_message FROM run_inputs WHERE run_id = ?').get(runId) as { user_message: string | null } | undefined
      return r?.user_message || null
    }
    const list = runs.findResumable('/p', reconciledAt, getUserReq)
    expect(list.find(r => r.runId === 'old')).toBeUndefined()
    db.close()
  })

  // #2 per-session stats: агрегат по всем прогонам чата (cost-discipline).
  it('sessionStats: суммирует cost/tools/files по всем прогонам ОДНОГО чата', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 'a', projectPath: '/p', chatId: 7, title: 'A', providerId: 'x', model: 'm', sendId: 1 })
    runs.finish('a', 'done', { costCents: 30, toolCount: 5, filesCount: 2 })
    runs.create({ runId: 'b', projectPath: '/p', chatId: 7, title: 'B', providerId: 'x', model: 'm', sendId: 2 })
    runs.finish('b', 'done', { costCents: 20, toolCount: 3, filesCount: 1 })
    // прогон ДРУГОГО чата — не попадает в агрегат чата 7
    runs.create({ runId: 'c', projectPath: '/p', chatId: 8, title: 'C', providerId: 'x', model: 'm', sendId: 3 })
    runs.finish('c', 'done', { costCents: 999, toolCount: 99, filesCount: 99 })

    const s = runs.sessionStats(7)
    expect(s.runs).toBe(2)
    expect(s.costCents).toBe(50)  // 30+20, без чужого чата
    expect(s.toolCount).toBe(8)   // 5+3
    expect(s.filesCount).toBe(3)  // 2+1
    expect(s.durationMs).toBeGreaterThanOrEqual(0)
    db.close()
  })

  it('sessionStats: пустой чат → нули', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    expect(runs.sessionStats(999)).toEqual({ runs: 0, costCents: 0, toolCount: 0, filesCount: 0, agentsCount: 0, durationMs: 0 })
    db.close()
  })

  // #4 suspend: статус 'suspended' персистится (для ↻ Продолжить) + чекпойнт жив.
  it('finish(suspended) round-trip + чекпойнт не тронут', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.create({ runId: 's1', projectPath: '/p', chatId: 3, title: 'S', providerId: 'x', model: 'm', sendId: 9 })
    runs.saveCheckpoint('s1', 2, JSON.stringify([{ role: 'user', content: 'q' }]))
    runs.finish('s1', 'suspended', { costCents: 12 })
    const row = runs.get('s1')
    expect(row!.status).toBe('suspended')
    expect(runs.latestCheckpoint('s1')?.messagesJson).toContain('q') // чекпойнт для resume цел
    db.close()
  })
})
