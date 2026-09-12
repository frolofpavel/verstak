// lineage.test.ts — stable browserTaskId + run lineage (BR-015).
//
// Главные свойства:
//   • новый ai:send → тот же browserTaskId, новый runId в lineage
//   • provider handoff сохраняет задачу
//   • isActiveRun отличает текущий run от устаревшего

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'
import type { BrowserTasks } from '../../../electron/storage/browser-tasks'
import {
  ensureTask,
  attachRun,
  handoffToProvider,
  getLineage,
  getCurrentRun,
  isActiveRun,
} from '../../../electron/ai/browser/lineage'

let dir: string
let db: Database
let bt: BrowserTasks

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'v54-lineage-'))
  db = openDb(join(dir, 'test.db'))
  bt = createBrowserTasks(db)
})

afterEach(() => {
  try { db?.close() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('ensureTask — идемпотентное создание', () => {
  it('первый вызов создаёт task', () => {
    const t = ensureTask(bt, { browserTaskId: 'bt-1', projectPath: '/p', runId: 'r1', providerId: 'kimi' })
    expect(t.browserTaskId).toBe('bt-1')
    expect(t.currentRunId).toBe('r1')
  })
  it('повторный вызов с тем же id — no-op (возвращает существующий)', () => {
    ensureTask(bt, { browserTaskId: 'bt-1', projectPath: '/p', runId: 'r1' })
    const t2 = ensureTask(bt, { browserTaskId: 'bt-1', projectPath: '/p', runId: 'r2' })
    // task не пересоздан; lineage untouched (ensureTask не трогает lineage если task есть)
    expect(t2.browserTaskId).toBe('bt-1')
    // currentRunId остался r1 — ensureTask не делает handoff автоматически.
    expect(t2.currentRunId).toBe('r1')
  })
})

describe('attachRun — lineage append (BR-015)', () => {
  it('новый ai:send → тот же task, новый run в lineage', () => {
    ensureTask(bt, { browserTaskId: 'bt-1', projectPath: '/p', runId: 'r1', providerId: 'kimi' })
    attachRun(bt, { browserTaskId: 'bt-1', runId: 'r2', providerId: 'codex', handoffReason: 'new_send' })
    const lin = getLineage(bt, 'bt-1')
    expect(lin.map(r => r.runId)).toEqual(['r1', 'r2'])
    expect(getCurrentRun(bt, 'bt-1')!.runId).toBe('r2')
  })
  it('повторный attach того же run — no-op (идемпотентность)', () => {
    ensureTask(bt, { browserTaskId: 'bt-1', projectPath: '/p', runId: 'r1' })
    attachRun(bt, { browserTaskId: 'bt-1', runId: 'r2', handoffReason: 'new_send' })
    attachRun(bt, { browserTaskId: 'bt-1', runId: 'r2', handoffReason: 'new_send' })
    expect(getLineage(bt, 'bt-1').length).toBe(2)
  })
})

describe('handoffToProvider — provider switch без потери задачи (§6)', () => {
  it('forced fallback: r1 (kimi) → r2 (glm), задача та же', () => {
    ensureTask(bt, { browserTaskId: 'bt-1', projectPath: '/p', runId: 'r1', providerId: 'kimi' })
    // Симулируем: kimi упал с 429, handoff на glm.
    handoffToProvider(bt, {
      browserTaskId: 'bt-1',
      newRunId: 'r2',
      newProviderId: 'glm',
      reason: 'provider_switch',
    })
    const lin = getLineage(bt, 'bt-1')
    expect(lin.map(r => r.runId)).toEqual(['r1', 'r2'])
    expect(lin[1].handoffReason).toBe('provider_switch')
    expect(lin[1].providerId).toBe('glm')
    // Старый run закрыт.
    expect(lin[0].endedAt).not.toBeNull()
    expect(lin[1].endedAt).toBeNull()
    // task current указывает на r2.
    expect(getCurrentRun(bt, 'bt-1')!.runId).toBe('r2')
    // но task остаётся тем же
    expect(bt.get('bt-1')!.browserTaskId).toBe('bt-1')
  })

  it('cascading handoff: r1 → r2 → r3 (без потери и без duplicate)', () => {
    ensureTask(bt, { browserTaskId: 'bt-1', projectPath: '/p', runId: 'r1', providerId: 'kimi' })
    handoffToProvider(bt, { browserTaskId: 'bt-1', newRunId: 'r2', newProviderId: 'glm' })
    handoffToProvider(bt, { browserTaskId: 'bt-1', newRunId: 'r3', newProviderId: 'codex' })
    const lin = getLineage(bt, 'bt-1')
    expect(lin.map(r => r.runId)).toEqual(['r1', 'r2', 'r3'])
    expect(lin.map(r => r.ord)).toEqual([0, 1, 2])
    expect(getCurrentRun(bt, 'bt-1')!.runId).toBe('r3')
  })
})

describe('isActiveRun — защита от устаревших events', () => {
  it('после handoff старый run — не active', () => {
    ensureTask(bt, { browserTaskId: 'bt-1', projectPath: '/p', runId: 'r1' })
    handoffToProvider(bt, { browserTaskId: 'bt-1', newRunId: 'r2', newProviderId: 'glm' })
    expect(isActiveRun(bt, 'bt-1', 'r1')).toBe(false)
    expect(isActiveRun(bt, 'bt-1', 'r2')).toBe(true)
  })
  it('несуществующий task → false', () => {
    expect(isActiveRun(bt, 'bt-missing', 'r1')).toBe(false)
  })
})

describe('RED: новый ai:send / Pause-Resume / provider switch сохраняют browserTaskId', () => {
  it('3 разных события — один browserTaskId, 3 run в lineage', () => {
    ensureTask(bt, { browserTaskId: 'bt-fixed', projectPath: '/p', runId: 'r1', providerId: 'kimi' })
    attachRun(bt, { browserTaskId: 'bt-fixed', runId: 'r2', handoffReason: 'pause_resume' })
    handoffToProvider(bt, { browserTaskId: 'bt-fixed', newRunId: 'r3', newProviderId: 'glm', reason: 'provider_switch' })
    const lin = getLineage(bt, 'bt-fixed')
    expect(lin).toHaveLength(3)
    expect(lin.map(r => r.handoffReason)).toEqual(['new_send', 'pause_resume', 'provider_switch'])
    // Все 3 run привязаны к одному durable id
    expect(lin.every(r => r.browserTaskId === 'bt-fixed')).toBe(true)
    expect(bt.get('bt-fixed')!.browserTaskId).toBe('bt-fixed')
  })
})
