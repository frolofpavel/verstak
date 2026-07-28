// §4.2 живьём: порог на ЧАТ-ПУТИ и контроль по ОСИ ПАЙПЛАЙНА.
//
// Чистая логика порога закреплена в tests/ai/plan-threshold-legacy.test.ts. Здесь
// доказывается проводка: тот же план, поданный НАСТОЯЩЕМУ createPlanHandler,
// действительно не показывает карточку — и что вторая причина дефекта закрыта:
// spec, присланный моделью, на чат-пути больше не выбрасывается (раньше
// `specs[index] ?? null` был null всегда, потому что `specs` заполняется только
// внутри `if (ctx.outcome)`).
//
// Проверяем на ОБЕИХ осях, как договорились после ревью: чат-контекст с тумблером
// и Outcome-пайплайн без него.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createPlans } from '../../electron/storage/plans'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'
import { __resetPlanForRunForTests, __resetAwaitingPlansForTests } from '../../electron/ai/runner-shared'

let dir: string
let db: Database | undefined
type Plans = ReturnType<typeof createPlans>

function openStores() {
  db = openDb(join(dir, 'verstak.db'))
  return createPlans(db)
}

/** Чат-путь с ВКЛЮЧЁННЫМ тумблером — там, где §4.2 и должен работать. */
function chatCtx(plans: Plans, agentMode: string = 'ask') {
  const sender = { send: vi.fn() }
  const setAgentMode = vi.fn()
  return {
    ctx: {
      projectPath: '/p', sendId: 1, runId: 'run-1', parentChatId: 7,
      agentMode, setAgentMode,
      getSecretForDelegate: (k: string) => (k === 'plan_approval_gate' ? 'true' : null),
      recordPlan: (p: string, title: string, steps: never[], meta: never) => plans.create(p, title, steps, meta),
      getPlan: (id: number) => plans.get(id),
      recordJournal: () => {},
      plans,
      pendingPlans: new Map(),
      scopedKey: (s: number, c: string) => `${s}::${c}`,
      sender,
    } as never,
    sender,
    setAgentMode,
  }
}

const eventsOf = (sender: { send: ReturnType<typeof vi.fn> }) =>
  sender.send.mock.calls.map(c => (c[1] as { event: { type: string } }).event.type)

// Описания шагов проходят ПРЕЖНЮЮ планку чат-пути (planSpecFeedback: путь +
// критерий готовности + детальность) — иначе handler отвергает план раньше
// порога, и проверялось бы не то. В читающем плане намеренно нет слова
// «отправлен»: 'отправ' — признак ответственного действия, и он дал бы карточку
// по другой причине, а тест выглядел бы зелёным «не за то».
const READING_STEPS = [
  { title: 'Прочитать файлы проекта', detail: 'Просмотреть src/components и собрать список модулей. Критерий готовности: список составлен.' },
  { title: 'Проанализировать зависимости', detail: 'Сравнить package.json с фактическими импортами в src/store. Критерий готовности: расхождения перечислены.' },
  { title: 'Ответить в чате', detail: 'Сформулировать вывод по файлам src/lib: что устарело. Критерий готовности: вывод сформулирован.' },
]

const WRITING_STEPS = [
  { title: 'Прочитать файлы проекта', detail: 'Просмотреть src/components и собрать список модулей. Критерий готовности: список составлен.' },
  { title: 'Записать лендинг', detail: 'Создать src/index.html с блоками про натяжные потолки. Критерий готовности: файл открывается.' },
]

const call = (steps: unknown[], id = 'c1') => ({ id, name: 'create_plan', args: { title: 'План', steps } }) as never

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-threshold-live-'))
  __resetPlanForRunForTests()
  __resetAwaitingPlansForTests()
})
afterEach(() => {
  db?.close(); db = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('§4.2 живьём: чат-путь без structured spec', () => {
  it('читающий план: карточки НЕТ, но план в БД есть (след остаётся)', async () => {
    const plans = openStores()
    const { ctx, sender, setAgentMode } = chatCtx(plans)

    const res = await createPlanHandler.handle(call(READING_STEPS), ctx) as { result: string; error?: string }

    expect(res.error).toBeUndefined()
    expect(eventsOf(sender), 'вопрос обязан отвечаться без единого клика').not.toContain('plan-approval')
    expect(eventsOf(sender)).toContain('plan-created')
    expect(plans.list('/p'), 'след в БД остаётся даже при автоутверждении').toHaveLength(1)
    expect(plans.list('/p')[0].status).toBe('draft')
    expect(setAgentMode, 'автоутверждение НЕ выдаёт прав на запись').not.toHaveBeenCalled()
  })

  it('пишущий план тем же путём: карточка ЕСТЬ', async () => {
    const plans = openStores()
    const { ctx, sender, setAgentMode } = chatCtx(plans)

    await createPlanHandler.handle(call(WRITING_STEPS), ctx)

    expect(eventsOf(sender)).toContain('plan-approval')
    expect(setAgentMode, 'на время ожидания права понижаются до plan').toHaveBeenCalledWith('plan')
  })

  it('spec, присланный моделью, на чат-пути больше не выбрасывается', async () => {
    const plans = openStores()
    const { ctx, sender } = chatCtx(plans)
    const steps = [{
      title: 'Собрать отчёт по данным',
      detail: 'Прочитать выгрузку data/sales.csv и посчитать итог. Критерий готовности: число получено.',
      spec: {
        key: 's1', title: 'Собрать отчёт', intent: 'Посчитать итог', files: [], symbols: [],
        actions: ['Прочитать выгрузку'], dependsOn: [], readScope: ['data'],
        writeScope: ['reports/out.csv'], acceptanceCriterionIds: [], verification: [],
        expectedEvidence: [], rollback: '', role: 'executor', execution: 'main', risk: 'low',
      },
    }]

    await createPlanHandler.handle(call(steps), ctx)

    // Текст шага читающий — без разбора spec план проехал бы как чтение.
    expect(eventsOf(sender), 'объявленный writeScope обязан перевесить читающий текст').toContain('plan-approval')
  })

  it('fail-safe жив: неопределимый шаг по-прежнему даёт карточку', async () => {
    const plans = openStores()
    const { ctx, sender } = chatCtx(plans)
    const steps = [
      ...READING_STEPS,
      // Ни признака чтения, ни признака записи — по такому шагу решить нельзя.
      { title: 'Прочее по задаче', detail: 'Остальное в src/components по обстоятельствам. Критерий готовности: задача закрыта.' },
    ]

    await createPlanHandler.handle(call(steps), ctx)

    expect(eventsOf(sender)).toContain('plan-approval')
  })
})

describe('§4.2: ось пайплайна не задета', () => {
  it('outcome-путь по-прежнему требует ПОЛНЫЙ spec — партиальность туда не течёт', async () => {
    const plans = openStores()
    const { ctx } = chatCtx(plans)
    const outcomeCtx = {
      ...(ctx as object),
      outcome: { pipelineId: 1, phase: 'plan' },
      pipelineRuns: { get: () => ({ id: 1, projectPath: '/p', taskContract: { schemaVersion: 1 }, contractRevision: 1, planId: null }) },
    } as never

    // Тот же обрезанный spec, который на чат-пути читается частично.
    const steps = [{ title: 'Шаг', detail: 'Записать src/a.ts. Критерий готовности: файл есть.', spec: { writeScope: ['src/a.ts'] } }]
    const res = await createPlanHandler.handle(call(steps), outcomeCtx) as { result: string; error?: string }

    expect(res.result, 'quality-гейт пайплайна обязан требовать полноты').toContain('structured spec невалиден')
    expect(plans.list('/p'), 'невалидный план в пайплайне не сохраняется').toHaveLength(0)
  })

  it('в режиме планирования карточки нет вовсе — матрица §5 не изменилась', async () => {
    const plans = openStores()
    const { ctx, sender } = chatCtx(plans, 'plan')

    await createPlanHandler.handle(call(WRITING_STEPS), ctx)

    expect(eventsOf(sender)).not.toContain('plan-approval')
  })
})
