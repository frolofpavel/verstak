import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import type { RunUsageRow, UsageSummaryGroup } from '../../shared/contracts/usage'

/**
 * IPC read-side persistence usage (2.0.8-F). End-to-end через РЕАЛЬНУЮ БД:
 * persist → канал usage:list / usage:summary → DTO. Каналы обязаны совпадать с preload
 * (страж паритета имён — tests/contracts/preload-api-contract.test.ts).
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
  },
}))

const { registerUsageIpc } = await import('../../electron/ipc/usage')
const { openDb } = await import('../../electron/storage/db')
const { createRunUsage, persistRunUsage } = await import('../../electron/storage/agent-run-usage')
const { normalizedUsage } = await import('../../shared/contracts/usage')

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve(fn(null, ...args) as T)
}

describe('usage ipc (2.0.8-F read-side)', () => {
  let dir: string
  let db: Database

  beforeEach(() => {
    handlers.clear()
    dir = mkdtempSync(join(tmpdir(), 'usage-ipc-'))
    db = openDb(join(dir, 'test.db'))
    registerUsageIpc(createRunUsage(db))
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  const seed = (runId: string, over: Record<string, unknown> = {}, at = 1000) =>
    persistRunUsage(db, {
      runId, providerId: 'claude', model: 'claude-sonnet-4-6', transport: 'API', accountId: null,
      usage: normalizedUsage({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 300, inputAccounting: 'exclusive' }),
      ...over,
    }, at)

  it('регистрирует ровно каналы usage:summary и usage:list (совпадают с preload)', () => {
    expect(handlers.has('usage:summary')).toBe(true)
    expect(handlers.has('usage:list')).toBe(true)
  })

  it('usage:list отдаёт строки прогонов, новейшие первыми', async () => {
    seed('r1', {}, 1000)
    seed('r2', {}, 2000)
    const rows = await invoke<RunUsageRow[]>('usage:list', {})
    expect(rows.map(r => r.runId)).toEqual(['r2', 'r1']) // DESC по created_at
    expect(rows[0].providerId).toBe('claude')
    expect(rows[0].transport).toBe('API')
  })

  it('usage:list уважает sinceMs (граница периода принадлежит вызывающему)', async () => {
    seed('old', {}, 1000)
    seed('new', {}, 5000)
    const rows = await invoke<RunUsageRow[]>('usage:list', { sinceMs: 3000 })
    expect(rows.map(r => r.runId)).toEqual(['new'])
  })

  it('usage:list уважает limit', async () => {
    seed('a', {}, 1000); seed('b', {}, 2000); seed('c', {}, 3000)
    const rows = await invoke<RunUsageRow[]>('usage:list', { limit: 2 })
    expect(rows).toHaveLength(2)
  })

  it('usage:summary агрегирует по provider/model/transport + cache-hit доля', async () => {
    seed('a', {}, 1000)
    seed('b', {}, 2000)
    const groups = await invoke<UsageSummaryGroup[]>('usage:summary', 0)
    expect(groups).toHaveLength(1)
    expect(groups[0].runs).toBe(2)
    expect(groups[0].inputTokens).toBe(2000)
    // Claude = exclusive: весь промпт = input + cacheRead → 600/(2000+600), а не 600/2000.
    expect(groups[0].cacheHitShare).toBeCloseTo(600 / 2600, 4)
    expect(groups[0].cacheHitShare!).toBeLessThanOrEqual(1)
  })

  // Каветат #2 карточки: цена неизвестна → costAmount=null + unknownCostRuns, а НЕ «$0».
  it('usage:summary: неизвестная цена не подмешивается как $0 (три честных состояния)', async () => {
    seed('known', {}, 1000)
    seed('unknown', { providerId: 'openai', model: 'gpt-НЕИЗВЕСТНАЯ' }, 2000)
    const groups = await invoke<UsageSummaryGroup[]>('usage:summary', 0)
    const unknown = groups.find(g => g.model === 'gpt-НЕИЗВЕСТНАЯ')!
    expect(unknown.unknownCostRuns).toBe(1)
    expect(unknown.costAmount).toBe(0) // сумма ИЗВЕСТНЫХ = 0, но unknownCostRuns говорит «не ноль, а неизвестно»
    const known = groups.find(g => g.model === 'claude-sonnet-4-6')!
    expect(known.unknownCostRuns).toBe(0)
    expect(known.costAmount).toBeGreaterThan(0)
  })

  it('usage:summary за период (sinceMs) режет старое', async () => {
    seed('old', {}, 1000)
    seed('fresh', {}, 9000)
    const groups = await invoke<UsageSummaryGroup[]>('usage:summary', 5000)
    expect(groups[0].runs).toBe(1)
  })

  it('пустая БД → пустые списки, не падение', async () => {
    expect(await invoke<RunUsageRow[]>('usage:list', {})).toEqual([])
    expect(await invoke<UsageSummaryGroup[]>('usage:summary', 0)).toEqual([])
  })
})
