// Блок D, §4.4/§4.5 ТЗ: связанные пункты чек-листа закрываются вместе с шагом —
// но ТОЛЬКО по подтверждённому результату и только с доказательством.
//
// Разница, ради которой пин и написан: «шаг больше не выполняется» и «дело
// сделано» — разные вещи. Провалившийся или заблокированный шаг обязан оставить
// пункт открытым, иначе чек-лист начнёт врать ровно там, где он нужен.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createPlans } from '../../electron/storage/plans'
import { createTasks } from '../../electron/storage/tasks'
import { createPlanOutcomes } from '../../electron/storage/plan-outcomes'
import { reportStepOutcomeHandler } from '../../electron/ipc/tool-handlers/outcome'

let dir: string
let db: Database | undefined

const SPEC = {
  key: 's1', title: 'Собрать отчёт', intent: 'Сделать отчёт', files: [], symbols: [],
  actions: ['Записать файл'], dependsOn: [], readScope: ['data'], writeScope: ['out.csv'],
  acceptanceCriterionIds: [], verification: [], expectedEvidence: [], rollback: '',
  role: 'executor', execution: 'main', risk: 'low',
}

function seed() {
  db = openDb(join(dir, 'verstak.db'))
  const plans = createPlans(db)
  const tasks = createTasks(db)
  const planOutcomes = createPlanOutcomes(db)
  const plan = plans.create(dir, 'План', [{ title: 'Собрать отчёт', detail: null, spec: SPEC as never }])
  const step = plan.steps[0]
  const linked = tasks.add(dir, 'Отчёт собран', { source: 'system', planId: plan.id, planStepId: step.id })
  const own = tasks.add(dir, 'Мой личный пункт')
  return { plans, tasks, planOutcomes, plan, step, linked, own }
}

function ctxOf(s: ReturnType<typeof seed>, status: 'succeeded' | 'failed') {
  return {
    projectPath: dir, sendId: 1, runId: 'run-1',
    plans: s.plans, planOutcomes: s.planOutcomes, tasks: s.tasks,
    outcome: { pipelineId: 1, phase: 'execute-step', planStepId: s.step.id, attempt: 1 },
    pipelineRuns: {
      get: () => ({ id: 1, projectPath: dir, planId: s.plan.id, taskContract: { schemaVersion: 1 }, contractRevision: 1 }),
      advance: () => {},
    },
    runFilesTouched: () => ['out.csv'],
    runChecks: () => [],
    sender: { send: vi.fn() },
    recordJournal: () => {},
    void: status,
  } as never
}

const call = (status: 'succeeded' | 'failed') => ({
  id: 'c1', name: 'report_step_outcome',
  args: {
    status,
    summary: 'Отчёт собран',
    observations: [],
    changedFiles: ['out.csv'],
    checks: [],
    evidence: ['out.csv'],
    assumptionFailures: [],
    recommendedAction: status === 'succeeded' ? 'continue' : 'retry',
  },
}) as never

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-checklist-link-'))
  writeFileSync(join(dir, 'out.csv'), 'a,b\n1,2\n')
})
afterEach(() => { db?.close(); db = undefined; rmSync(dir, { recursive: true, force: true }) })

describe('блок D: чек-лист закрывается вместе с шагом — по доказательству', () => {
  it('успешный шаг закрывает связанный пункт и записывает доказательство', async () => {
    const s = seed()
    await reportStepOutcomeHandler.handle(call('succeeded'), ctxOf(s, 'succeeded'))

    const linked = s.tasks.list(dir).find(t => t.id === s.linked.id)!
    expect(linked.done, 'связанный пункт остался открытым при подтверждённом шаге').toBe(true)
    expect(linked.evidence, 'закрытие без доказательства запрещено ТЗ').toBeTruthy()
  })

  it('личный пункт человека не трогается вообще', async () => {
    const s = seed()
    await reportStepOutcomeHandler.handle(call('succeeded'), ctxOf(s, 'succeeded'))

    const own = s.tasks.list(dir).find(t => t.id === s.own.id)!
    expect(own.done).toBe(false)
    expect(own.source).toBe('manual')
  })

  // КОНТРОЛЬНЫЙ КЕЙС: без него первый тест был бы зелёным и от «закрываем всегда».
  it('провалившийся шаг НЕ закрывает связанный пункт', async () => {
    const s = seed()
    await reportStepOutcomeHandler.handle(call('failed'), ctxOf(s, 'failed'))

    const linked = s.tasks.list(dir).find(t => t.id === s.linked.id)!
    expect(linked.done, '«шаг не выполняется» и «дело сделано» — разные вещи').toBe(false)
    expect(linked.evidence).toBeNull()
  })
})

// Позиция 2, требование (в): отказ ПОМЕЧАЕТ шаг, а не только возвращает строку.
// До 29.07 статус 'skipped' не ставила ни одна строка кода в проекте — «отказ
// пропускает шаг» существовало только на словах.
describe('позиция 2 (в): заблокированный шаг помечается skipped, а не failed', () => {
  it('blocked-исход ставит шагу skipped и не закрывает чек-лист', async () => {
    const s = seed()
    const blocked = {
      id: 'c1', name: 'report_step_outcome',
      args: {
        status: 'blocked',
        summary: 'Пользователь отказал в подтверждении отправки',
        observations: [], changedFiles: [], checks: [], evidence: [],
        assumptionFailures: [], recommendedAction: 'ask-user',
      },
    } as never

    // Отказ = агент НИЧЕГО не писал. Если оставить 'тронутые файлы' из общей
    // фикстуры, исход пересчитается в diverged (скрытая запись) — и тест будет
    // проверять не то. Даём честный контекст отказа: файлов не тронуто.
    const ctx = { ...(ctxOf(s, 'failed') as object), runFilesTouched: () => [] } as never
    await reportStepOutcomeHandler.handle(blocked, ctx)

    const step = s.plans.get(s.plan.id)!.steps[0]
    expect(step.status, '«отказано» и «провалено» — разные вещи').toBe('skipped')
    expect(s.tasks.list(dir).find(t => t.id === s.linked.id)!.done).toBe(false)
  })

  it('контроль: настоящий провал по-прежнему failed', async () => {
    const s = seed()
    await reportStepOutcomeHandler.handle(call('failed'), ctxOf(s, 'failed'))
    expect(s.plans.get(s.plan.id)!.steps[0].status).toBe('failed')
  })
})
