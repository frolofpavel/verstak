import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * IPC Pipeline Brief→Proof (спек D2). Мокаем electron.ipcMain.handle в Map,
 * дёргаем хендлеры против реального in-memory DB. Падают по ABI вместе с
 * остальными sqlite-тестами — известный шум.
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
  },
}))

const { openDb } = await import('../../electron/storage/db')
const { createPipelineRuns } = await import('../../electron/storage/pipeline-runs')
const { registerPipelineIpc } = await import('../../electron/ipc/pipeline')
import type { PipelineRun } from '../../electron/storage/pipeline-runs'

function invoke<T>(channel: string, ...args: unknown[]): T {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn({} as unknown, ...args) as T
}

describe('pipeline ipc (D2)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let projectRoot: string | null
  const brief = { goal: 'fix tsc', constraints: '—', dod: 'npm run type' }

  beforeEach(() => {
    handlers.clear()
    dir = mkdtempSync(join(tmpdir(), 'gg-pipeline-ipc-'))
    db = openDb(join(dir, 'test.db'))
    projectRoot = dir
    registerPipelineIpc({ pipeline: createPipelineRuns(db), getProjectRoot: () => projectRoot })
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('start создаёт прогон для активного проекта (step=plan)', () => {
    const run = invoke<PipelineRun | null>('pipeline:start', { mode: 'dev', brief, chatId: 3 })
    expect(run).not.toBeNull()
    expect(run!.step).toBe('plan')
    expect(run!.mode).toBe('dev')
    expect(run!.projectPath).toBe(dir)
    expect(run!.brief).toEqual(brief)
  })

  it('start без открытого проекта → null', () => {
    projectRoot = null
    expect(invoke('pipeline:start', { mode: 'dev', brief })).toBeNull()
  })

  it('advance двигает шаг + planId, getActive отражает', () => {
    const run = invoke<PipelineRun>('pipeline:start', { mode: 'dev', brief })
    invoke('pipeline:advance', run.id, { step: 'execute', planId: 9 })
    const active = invoke<PipelineRun | null>('pipeline:getActive', dir)
    expect(active!.step).toBe('execute')
    expect(active!.planId).toBe(9)
  })

  it('cancel убирает прогон из getActive', () => {
    const run = invoke<PipelineRun>('pipeline:start', { mode: 'dev', brief })
    invoke('pipeline:cancel', run.id)
    expect(invoke('pipeline:getActive', dir)).toBeNull()
  })

  it('полный цикл: start → plan→execute→verify→proof→completed, бриф/planId/runId выживают', () => {
    const run = invoke<PipelineRun>('pipeline:start', { mode: 'dev', brief, chatId: 2 })
    expect(run.step).toBe('plan')

    // План создан во время Plan-шага → привязка planId (шаг остаётся plan).
    invoke('pipeline:advance', run.id, { planId: 31 })
    expect(invoke<PipelineRun | null>('pipeline:getActive', dir)?.step).toBe('plan')

    // Прогон шагов до конца.
    const steps = ['execute', 'verify', 'proof', 'completed'] as const
    for (const step of steps) invoke('pipeline:advance', run.id, { step })

    // На completed (терминальный) getActive больше не возвращает прогон.
    expect(invoke('pipeline:getActive', dir)).toBeNull()

    // Но сам прогон цел: бриф + planId сохранились через все переходы.
    const final = invoke<PipelineRun>('pipeline:advance', run.id, {})
    expect(final.step).toBe('completed')
    expect(final.planId).toBe(31)
    expect(final.brief).toEqual(brief)
    expect(final.chatId).toBe(2)
  })
})
