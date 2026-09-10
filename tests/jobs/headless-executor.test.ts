import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { ChatEvent, ChatMessage, ChatProvider } from '../../electron/ai/types'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))
const { providerFactory } = vi.hoisted(() => ({ providerFactory: vi.fn() }))
vi.mock('../../electron/ai/registry', async original => ({
  ...await original<typeof import('../../electron/ai/registry')>(), createProvider: providerFactory,
}))
// Изоляция домашних project/skill instructions. Executor, headless, sub-loop и БД настоящие.
vi.mock('../../electron/ai/compose-system', () => ({ prepareSystemContext: async () => ({ system: 'Test project' }) }))
import { runScheduledHeadless, type AiDeps } from '../../electron/ipc/ai'
import { createHeadlessJobExecutor } from '../../electron/jobs/headless-executor'
import { handleSignal } from '../../electron/jobs/wake-cycle'
import { createPersistentJobs } from '../../electron/storage/persistent-jobs'
import { openDb } from '../../electron/storage/db'

let dir: string
let db: Database
let prompts: string[]
let events: ChatEvent[]
let deps: AiDeps
const usage: ChatEvent = { type: 'usage', usage: { inputTokens: 1000, outputTokens: 1000 } }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-wake-runtime-'))
  db = openDb(join(dir, 'test.db'))
  prompts = []
  events = [usage, { type: 'text', text: 'Утренний обзор: 3 задачи, просрочена задача 42.' }, { type: 'done' }]
  providerFactory.mockImplementation((): ChatProvider => ({
    id: 'openai', name: 'Test OpenAI', models: ['gpt-4o-mini'],
    async *send(messages: ChatMessage[]) {
      prompts.push(String(messages.find(m => m.role === 'user')?.content))
      for (const event of events) yield event
    },
  }))
  deps = {
    getKnownRoots: () => [dir], getSecret: (key: string) => key === 'openai_api_key' ? 'test-only-placeholder' : null,
    recentWrites: () => [],
  } as unknown as AiDeps
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })
const execute = () => createHeadlessJobExecutor({
  runHeadless: opts => runScheduledHeadless(deps, opts), getProviderId: () => 'openai', getProviderModel: () => 'gpt-4o-mini',
})
function create() {
  return createPersistentJobs(db).create({
    id: 'morning', projectPath: dir, title: 'Утренний обзор', goal: 'Сравни задачи и подготовь обзор',
    triggerKind: 'schedule', triggerConfig: { everyMinutes: 1440 }, maxRuns: 5, budgetCents: 1,
    state: { lastSeenTaskId: 41 }, nextAction: 'Покажи только изменения', nextRunAt: 1000,
  })
}
const wake = (at: number) => handleSignal({ jobs: createPersistentJobs(db), execute: execute(), now: () => at }, { kind: 'tick', at })

describe('production persistent job -> headless -> sub-agent loop', () => {
  it('main использует проверенный executor', () => {
    expect(readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8')).toContain('execute: createHeadlessJobExecutor({')
  })
  it('два пробуждения через restart: контекст, checkpoint, дробный расход и бюджет', async () => {
    create()
    await wake(1000)
    const first = createPersistentJobs(db).get('morning')!
    expect(prompts[0]).toContain('lastSeenTaskId')
    expect(first.lastResult).toContain('задача 42')
    expect(first.state.lastWake).toEqual(expect.objectContaining({ result: first.lastResult }))
    expect(first.costUsedCents).toBeCloseTo(0.075)
    db.close(); db = openDb(join(dir, 'test.db'))
    events = [usage, { type: 'text', text: 'Задача 42 закрыта, новых просрочек нет.' }, { type: 'done' }]
    await wake(first.nextRunAt!)
    expect(prompts[1]).toContain('задача 42')
    expect(prompts[1]).toContain('Покажи только изменения')
    const second = createPersistentJobs(db).get('morning')!
    expect(second.runsDone).toBe(2)
    expect(second.costUsedCents).toBeCloseTo(0.15)
    expect(second.state.lastWake).toEqual(expect.objectContaining({ result: second.lastResult }))
    expect(JSON.stringify(second.state)).not.toContain('lastWake":{"lastWake')
    // Тот же исполнитель реально работал дважды; исчерпанный бюджет останавливает третий.
    db.prepare('UPDATE persistent_jobs SET budget_cents = ? WHERE id = ?').run(0.15, 'morning')
    expect((await wake(second.nextRunAt!)).woken).toEqual([])
    expect(prompts).toHaveLength(2)
  })
  it('ошибка после usage сохраняет расход и прежний checkpoint', async () => {
    const job = create()
    events = [usage, { type: 'error', message: 'provider unavailable' }]
    await wake(1000)
    const failed = createPersistentJobs(db).get(job.id)!
    expect(failed.status).toBe('failed')
    expect(failed.state).toEqual(job.state)
    expect(failed.costUsedCents).toBeCloseTo(0.075)
  })
  it('отсутствие usage обозначено как неизвестная стоимость, без выдуманной суммы', async () => {
    const job = create()
    events = [{ type: 'text', text: 'Обзор готов' }, { type: 'done' }]
    await wake(1000)
    expect(createPersistentJobs(db).get('morning')!.lastResult).toMatch(/стоимость.*неизвестна/i)
    expect(createPersistentJobs(db).get('morning')!.status).toBe('failed')
    expect(createPersistentJobs(db).get('morning')!.state).toEqual(job.state)
  })
  it('остаток бюджета останавливает текущий прогон после usage, расход не теряется', async () => {
    const job = create()
    db.prepare('UPDATE persistent_jobs SET budget_cents = ? WHERE id = ?').run(0.05, job.id)
    await wake(1000)
    const failed = createPersistentJobs(db).get(job.id)!
    expect(failed.status).toBe('failed')
    expect(failed.costUsedCents).toBeCloseTo(0.075)
    expect(failed.state).toEqual(job.state)
    expect(failed.lastResult).toMatch(/лимит/i)
  })
  it('ответ модели не меняет права/бюджет, секрет режется перед БД и следующим prompt', async () => {
    create()
    const synthetic = 'sk-' + 'x'.repeat(40)
    events = [usage, { type: 'text', text: JSON.stringify({ budgetCents: 99999, permissions: 'bypass', value: synthetic }) }, { type: 'done' }]
    await wake(1000)
    const first = createPersistentJobs(db).get('morning')!
    expect(first.budgetCents).toBe(1)
    expect(first.state).not.toHaveProperty('permissions')
    expect(JSON.stringify(first)).not.toContain(synthetic)
    await wake(first.nextRunAt!)
    expect(prompts[1]).not.toContain(synthetic)
    expect(prompts[1]).toContain('REDACTED')
  })
  it('неизвестный тариф не выдаёт conservative cap estimate за измеренный расход', async () => {
    const result = await runScheduledHeadless(deps, {
      projectPath: dir, prompt: 'Обзор', providerId: 'openai', model: 'unknown-model',
      signal: new AbortController().signal, budgetCents: 100,
    })
    expect(result.costCents).toBeNull()
  })
  it.each([true, false])('большой state сохраняется при ok=%s, prompt ограничен', async ok => {
    const job = create()
    const state = { huge: 'z'.repeat(13000), quoted: 'Строка "цитата"\nперенос', nested: { items: [1, null, 'обычный текст'] } }
    db.prepare('UPDATE persistent_jobs SET state_json = ? WHERE id = ?').run(JSON.stringify(state), job.id)
    if (!ok) events = [usage, { type: 'error', message: 'unavailable' }]
    await wake(1000)
    const saved = createPersistentJobs(db).get(job.id)!
    expect(saved.state).toEqual(ok ? { ...state, lastWake: expect.any(Object) } : state)
    expect(prompts[0].length).toBeLessThan(12000)
    expect(prompts[0]).toContain('Полное состояние сохранено')
  })
  it.each(['aborted', 'max-iterations'] as const)('%s не считается успешным headless', async reason => {
    const ac = new AbortController()
    if (reason === 'aborted') ac.abort()
    const result = await runScheduledHeadless(deps, {
      projectPath: dir, prompt: 'Обзор', providerId: 'openai', model: 'gpt-4o-mini', signal: ac.signal,
      ...(reason === 'max-iterations' ? { maxIterations: 0 } : {}),
    })
    expect(result.exitReason).toBe(reason)
    expect(result.ok).toBe(false)
  })
  it('отмена после usage сохраняет уже измеренный расход', async () => {
    const ac = new AbortController()
    providerFactory.mockImplementation((): ChatProvider => ({
      id: 'openai', name: 'Test OpenAI', models: ['gpt-4o-mini'],
      async *send() {
        yield usage
        ac.abort()
        yield { type: 'done' }
      },
    }))
    const result = await runScheduledHeadless(deps, {
      projectPath: dir, prompt: 'Обзор', providerId: 'openai', model: 'gpt-4o-mini', signal: ac.signal,
    })
    expect(result.ok).toBe(false)
    expect(result.exitReason).toBe('aborted')
    expect(result.costCents).toBeCloseTo(0.075)
  })
})
