import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Интеграционный тест Agency Workflows: workflows:start собирает промпт +
 * детерминированно создаёт План из шагов (видим в WorkflowView). Мокаем
 * electron.ipcMain, реальные plans в in-memory БД — проверяем, что план
 * действительно создан и достаётся.
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) } }
}))

const { openDb } = await import('../../electron/storage/db')
const { createPlans } = await import('../../electron/storage/plans')
const { createUserWorkflows } = await import('../../electron/storage/user-workflows')
const { registerWorkflowsIpc } = await import('../../electron/ipc/workflows')

function invoke<T>(channel: string, ...args: unknown[]): T {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn({} as unknown, ...args) as T
}

describe('workflows IPC (Agency Workflows end-to-end)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let plans: ReturnType<typeof createPlans>
  let userWorkflows: ReturnType<typeof createUserWorkflows>
  const runTitles = new Map<string, string | null>()

  beforeEach(() => {
    handlers.clear()
    runTitles.clear()
    dir = mkdtempSync(join(tmpdir(), 'gg-wf-'))
    db = openDb(join(dir, 'test.db'))
    plans = createPlans(db)
    userWorkflows = createUserWorkflows(db)
    registerWorkflowsIpc({
      createPlan: (p, t, steps) => plans.create(p, t, steps),
      getRun: (runId) => (runTitles.has(runId) ? { title: runTitles.get(runId)! } : null),
      getPlanSteps: (projectPath, runId) =>
        (plans.list(projectPath).find(pl => pl.agentRunId === runId)?.steps ?? []).map(s => ({ title: s.title, detail: s.detail })),
      userWorkflows,
      getProjectRoot: () => dir,
    })
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('list: каталог содержит marketing-audit + RU-пак, у всех непустые шаги', () => {
    const list = invoke<Array<{ id: string; stepCount: number }>>('workflows:list')
    const ids = list.map(w => w.id)
    expect(ids).toContain('marketing-audit')
    expect(ids).toContain('ydirect-metrika-audit')
    expect(ids).toContain('bitrix-stale-deals')
    expect(ids).toContain('onec-sheets-reconcile')
    expect(list.every(w => w.stepCount > 0)).toBe(true)
  })

  it('start: вшивает бриф, создаёт реальный План из шагов, возвращает runState', () => {
    const res = invoke<{ prompt: string; planId: number; runState: { workflowId: string; status: string; planId?: number } }>(
      'workflows:start', 'ydirect-metrika-audit', dir, 'аккаунт ACME, период 30д'
    )
    // промпт содержит заголовок первого шага и сам бриф
    expect(res.prompt).toContain('Разбор брифа')
    expect(res.prompt).toContain('аккаунт ACME')
    // runState
    expect(res.runState.workflowId).toBe('ydirect-metrika-audit')
    expect(res.runState.status).toBe('pending')
    expect(res.runState.planId).toBe(res.planId)
    // план реально создан в БД, шаги = шаги workflow, заголовок = имя сценария
    const plan = plans.get(res.planId)
    expect(plan).not.toBeNull()
    expect(plan!.title).toBe('Реклама: Директ + Метрика')
    expect(plan!.steps.length).toBeGreaterThan(0)
    expect(plan!.steps[0].title).toBe('Разбор брифа')
  })

  it('start: неизвестный workflow → error unknown-workflow (план не создаётся)', () => {
    const res = invoke<{ error?: string; planId?: number }>('workflows:start', 'nope', dir, '')
    expect(res.error).toBe('unknown-workflow')
    expect(res.planId).toBeUndefined()
  })

  // Задача 7A: workflow = сохранённый повторяемый прогон.
  it('save-from-run: прогон с планом → user workflow с его шагами; list+start его видят', () => {
    // Прогон run-1 с заголовком + план, связанный по agent_run_id.
    runTitles.set('run-1', 'Аудит клиента ACME')
    plans.create(dir, 'План прогона', [
      { title: 'Собрать метрики', detail: 'Открой Метрику' },
      { title: 'Свести', detail: null },
    ], { agentRunId: 'run-1' })

    const saved = invoke<{ ok?: boolean; id?: number; name?: string; stepCount?: number; error?: string }>('workflows:save-from-run', 'run-1')
    expect(saved.ok).toBe(true)
    expect(saved.name).toBe('Аудит клиента ACME')
    expect(saved.stepCount).toBe(2)

    // list содержит user workflow сверху с source=user
    const list = invoke<Array<{ id: string; source: string; userId: number | null; name: string }>>('workflows:list')
    const mine = list.find(w => w.source === 'user')
    expect(mine).toBeTruthy()
    expect(mine!.name).toBe('Аудит клиента ACME')
    expect(mine!.id).toBe(`user:${saved.id}`)

    // start пользовательского workflow строит промпт + план из его шагов
    const started = invoke<{ prompt: string; planId: number; runState: { workflowId: string } }>('workflows:start', `user:${saved.id}`, dir, 'бриф')
    expect(started.prompt).toContain('Собрать метрики')
    const plan = plans.get(started.planId)
    expect(plan!.steps[0].title).toBe('Собрать метрики')
  })

  it('save-from-run: у прогона нет плана → честный отказ no-steps (пустышку не сохраняем)', () => {
    runTitles.set('run-empty', 'Прогон без плана')
    const res = invoke<{ error?: string; ok?: boolean }>('workflows:save-from-run', 'run-empty')
    expect(res.error).toBe('no-steps')
    expect(res.ok).toBeUndefined()
    expect(userWorkflows.listByProject(dir)).toHaveLength(0)
  })

  it('save-from-run: неизвестный прогон → no-run', () => {
    const res = invoke<{ error?: string }>('workflows:save-from-run', 'ghost')
    expect(res.error).toBe('no-run')
  })

  it('remove-user удаляет пользовательский workflow', () => {
    runTitles.set('run-2', 'Прогон')
    plans.create(dir, 'П', [{ title: 'Шаг', detail: 'd' }], { agentRunId: 'run-2' })
    const saved = invoke<{ id: number }>('workflows:save-from-run', 'run-2')
    expect(userWorkflows.listByProject(dir)).toHaveLength(1)
    invoke('workflows:remove-user', saved.id)
    expect(userWorkflows.listByProject(dir)).toHaveLength(0)
  })
})
