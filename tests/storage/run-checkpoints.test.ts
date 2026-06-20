import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createAgentRuns } from '../../electron/storage/agent-runs'

/**
 * Crash-resume Фаза 2 (миграция 26): снапшот истории сообщений loop'а.
 * Один чекпойнт на прогон (UPSERT по run_id) — прерванная крахом сессия
 * возобновляется с накопленным контекстом, а не с turn 0.
 * Падает по ABI вместе с остальными sqlite-тестами — известный шум, не регрессия.
 */
describe('agent_run_checkpoints (migration 26)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-ckpt-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('миграция 26 создаёт таблицу agent_run_checkpoints', () => {
    const db = openDb(join(dir, 'test.db'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name)
    expect(tables).toContain('agent_run_checkpoints')
    db.close()
  })

  it('saveCheckpoint → latestCheckpoint: roundtrip полей', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    const msgs = JSON.stringify([{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'ответ' }])
    runs.saveCheckpoint('r1', 3, msgs, 42)
    const cp = runs.latestCheckpoint('r1')
    expect(cp).not.toBeNull()
    expect(cp!.turnIndex).toBe(3)
    expect(cp!.messagesJson).toBe(msgs)
    expect(cp!.undoHead).toBe(42)
    expect(JSON.parse(cp!.messagesJson)).toHaveLength(2)
    db.close()
  })

  it('UPSERT: повторный save того же run_id перетирает прошлый turn (одна строка)', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.saveCheckpoint('r1', 1, '[{"t":1}]', 10)
    runs.saveCheckpoint('r1', 2, '[{"t":2}]', 20)
    const cp = runs.latestCheckpoint('r1')
    expect(cp!.turnIndex).toBe(2)              // последний turn
    expect(cp!.messagesJson).toBe('[{"t":2}]')
    expect(cp!.undoHead).toBe(20)
    const count = (db.prepare('SELECT COUNT(*) as n FROM agent_run_checkpoints WHERE run_id = ?').get('r1') as { n: number }).n
    expect(count).toBe(1)                       // одна строка на прогон
    db.close()
  })

  it('latestCheckpoint неизвестного прогона → null', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    expect(runs.latestCheckpoint('нет-такого')).toBeNull()
    db.close()
  })

  it('undoHead опционален → null если не передан', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.saveCheckpoint('r1', 1, '[]')
    expect(runs.latestCheckpoint('r1')!.undoHead).toBeNull()
    db.close()
  })

  it('clearCheckpoint удаляет снапшот (на чистом завершении)', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.saveCheckpoint('r1', 5, '[]', 1)
    expect(runs.latestCheckpoint('r1')).not.toBeNull()
    runs.clearCheckpoint('r1')
    expect(runs.latestCheckpoint('r1')).toBeNull()
    db.close()
  })

  it('чекпойнты разных прогонов независимы', () => {
    const db = openDb(join(dir, 'test.db'))
    const runs = createAgentRuns(db)
    runs.saveCheckpoint('r1', 1, '[{"r":1}]')
    runs.saveCheckpoint('r2', 9, '[{"r":2}]')
    runs.clearCheckpoint('r1')
    expect(runs.latestCheckpoint('r1')).toBeNull()
    expect(runs.latestCheckpoint('r2')!.turnIndex).toBe(9)   // r2 не задет
    db.close()
  })
})
