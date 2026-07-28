// Хвост §10, дефект 1: кнопка «Доработать» вела в мёртвый инструмент.
//
// ДЕФЕКТ. `plan-await.ts` велит модели править план через `replan_plan`, а
// `replanPlanHandler` начинался с требования `ctx.outcome.phase === 'replan'`.
// Продолжение из карточки согласования никакого outcome не несёт — это обычная
// отправка в чат с якорем на чекпойнт. Значит на чат-пути «Доработать»
// ошибалось ВСЕГДА: пользователь писал замечание, модель звала названный ей же
// инструмент и получала OUTCOME_REPLAN_CONTEXT_REQUIRED.
//
// ЧТО ЗАКРЕПЛЕНО ЗДЕСЬ. Доработка на чат-пути правит ТОТ ЖЕ план: planRevision
// растёт, дубликата не появляется, а карточка возвращается на новую ревизию —
// иначе доработанный план некому утвердить и цикл снова упирается в тупик.
//
// Целевой план приходит РАНТАЙМОМ (`ctx.revisePlanId`), а не из аргументов
// модели: id считается из чекпойнта, по которому идёт продолжение. Модель может
// проигнорировать текст, реестр — нет (та же логика, что у идемпотентности §9).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createPlans } from '../../electron/storage/plans'
import { createAgentRuns } from '../../electron/storage/agent-runs'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'
import { replanPlanHandler } from '../../electron/ipc/tool-handlers/outcome'
import {
  __resetPlanForRunForTests,
  __resetAwaitingPlansForTests,
  getPlanAwaitingApproval,
} from '../../electron/ai/runner-shared'

const RUN_ONE = 'run-plan-first'
const RUN_TWO = 'run-plan-continuation'

let dir: string
let db: Database | undefined

function openStores() {
  db = openDb(join(dir, 'verstak.db'))
  return { plans: createPlans(db), agentRuns: createAgentRuns(db) }
}

type Plans = ReturnType<typeof createPlans>
type Runs = ReturnType<typeof createAgentRuns>

/** Прогон с чекпойнтом — тот, что показал первую карточку. */
function seedRun(agentRuns: Runs) {
  agentRuns.create({
    runId: RUN_ONE, projectPath: '/p', chatId: 7, owner: 'main',
    title: 'Лендинг', providerId: 'claude', model: 'sonnet',
    requestedProviderId: null, requestedModel: null, sendId: 1, agentMode: 'ask', accountId: null,
  })
  agentRuns.saveCheckpoint(RUN_ONE, 3, JSON.stringify([{ role: 'user', content: 'Сделай лендинг' }]))
}

/** ToolContext ПЕРВОГО прогона: тот, что показал карточку. */
function planCtx(plans: Plans) {
  const sender = { send: vi.fn() }
  return {
    ctx: {
      projectPath: '/p', sendId: 1, runId: RUN_ONE, parentChatId: 7,
      agentMode: 'ask', setAgentMode: vi.fn(),
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
  }
}

/** ToolContext ПРОДОЛЖЕНИЯ: обычная отправка в чат, outcome нет — только якорь. */
function continuationCtx(plans: Plans, revisePlanId: number | null, agentRuns?: Runs) {
  const sender = { send: vi.fn() }
  const setAgentMode = vi.fn()
  return {
    ctx: {
      projectPath: '/p', sendId: 2, runId: RUN_TWO, parentChatId: 7,
      agentMode: 'ask', setAgentMode,
      getSecretForDelegate: (k: string) => (k === 'plan_approval_gate' ? 'true' : null),
      getPlan: (id: number) => plans.get(id),
      recordJournal: () => {},
      plans,
      ...(agentRuns ? { clearRunCheckpoint: (id: string) => agentRuns.clearCheckpoint(id) } : {}),
      ...(revisePlanId != null ? { revisePlanId } : {}),
      pendingPlans: new Map(),
      scopedKey: (s: number, c: string) => `${s}::${c}`,
      sender,
    } as never,
    sender,
    setAgentMode,
  }
}

const createCall = {
  id: 'c1', name: 'create_plan',
  args: {
    title: 'Лендинг',
    steps: [{
      title: 'Собрать страницу',
      detail: 'Записать src/index.html с блоками про натяжные потолки. Критерий готовности: файл открывается.',
    }],
  },
} as never

const reviseCall = {
  id: 'c2', name: 'replan_plan',
  args: {
    reason: 'Пользователь просит добавить проверку вёрстки',
    steps: [
      {
        title: 'Собрать страницу',
        detail: 'Записать src/index.html с блоками про натяжные потолки. Критерий готовности: файл открывается.',
      },
      {
        title: 'Проверить вёрстку',
        detail: 'Открыть src/index.html в предпросмотре. Критерий готовности: блоки не разъезжаются на 375px.',
      },
    ],
  },
} as never

async function seedPlanAwaitingApproval(plans: Plans) {
  const { ctx } = planCtx(plans)
  await createPlanHandler.handle(createCall, ctx)
  return plans.list('/p')[0]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-plan-revise-'))
  __resetPlanForRunForTests()
  __resetAwaitingPlansForTests()
})
afterEach(() => {
  db?.close(); db = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('§10 хвост: «Доработать» на чат-пути правит тот же план', () => {
  it('replan_plan без outcome обновляет план: ревизия растёт, дубликата нет', async () => {
    const { plans } = openStores()
    const plan = await seedPlanAwaitingApproval(plans)
    expect(plan.planRevision).toBe(1)

    const { ctx } = continuationCtx(plans, plan.id)
    const res = await replanPlanHandler.handle(reviseCall, ctx) as { result: string; error?: string }

    expect(res.error, 'на чат-пути инструмент обязан работать, а не отвечать ошибкой').toBeUndefined()
    const after = plans.get(plan.id)!
    expect(after.planRevision).toBe(2)
    expect(after.steps.map(s => s.title)).toEqual(['Собрать страницу', 'Проверить вёрстку'])
    expect(plans.list('/p'), 'доработка не создаёт второй план').toHaveLength(1)
    expect(after.id, 'planId постоянный').toBe(plan.id)
  })

  it('доработанная ревизия снова уходит на согласование, а не выполняется молча', async () => {
    const { plans } = openStores()
    const plan = await seedPlanAwaitingApproval(plans)
    __resetAwaitingPlansForTests() // первый прогон закрыт, его ожидание снято решением

    const { ctx, sender, setAgentMode } = continuationCtx(plans, plan.id)
    await replanPlanHandler.handle(reviseCall, ctx)

    const kinds = sender.send.mock.calls.map(c => (c[1] as { event: { type: string } }).event.type)
    expect(kinds).toContain('plan-replanned')
    expect(kinds, 'без карточки доработанный план некому утвердить').toContain('plan-approval')
    expect(plans.get(plan.id)!.status, 'до нового решения план не выполняется').toBe('draft')
    expect(setAgentMode, 'права на запись доработка не выдаёт').toHaveBeenCalledWith('plan')
  })

  it('чекпойнт ПРОДОЛЖЕНИЯ удержан — с него поедет работа после нового approve', async () => {
    const { plans } = openStores()
    const plan = await seedPlanAwaitingApproval(plans)
    __resetAwaitingPlansForTests()

    const { ctx } = continuationCtx(plans, plan.id)
    await replanPlanHandler.handle(reviseCall, ctx)

    expect(getPlanAwaitingApproval(RUN_TWO)).toBe(plan.id)
    expect(plans.get(plan.id)!.agentRunId, 'продолжение реплеит СВЕЖИЙ прогон').toBe(RUN_TWO)
  })

  // ДОРАБОТКА ПОСЛЕ РЕВЬЮ 28.07: у переезда якоря есть обратная сторона. После
  // rebind'а чекпойнт ПЕРВОГО прогона не связан ни с одним планом, а
  // releasePlanApproval ищет прогон только через план — значит освободить его
  // больше нечем. Каждая доработка оставляла осиротевший снапшот истории
  // навсегда: та же утечка, которую закрывает дефект 5.
  it('чекпойнт ПРЕЖНЕГО прогона освобождён — осиротевший снапшот не копится', async () => {
    const { agentRuns, plans } = openStores()
    seedRun(agentRuns)
    const plan = await seedPlanAwaitingApproval(plans)
    expect(agentRuns.latestCheckpoint(RUN_ONE), 'заготовка сломана').not.toBeNull()

    const { ctx } = continuationCtx(plans, plan.id, agentRuns)
    await replanPlanHandler.handle(reviseCall, ctx)

    expect(agentRuns.latestCheckpoint(RUN_ONE), 'снимок первого прогона осиротел').toBeNull()
    expect(getPlanAwaitingApproval(RUN_ONE), 'реестр ожиданий тоже течёт').toBeNull()
  })

  it('нет цели доработки → честная ошибка, а не тихая правка чужого плана', async () => {
    const { plans } = openStores()
    await seedPlanAwaitingApproval(plans)

    const { ctx } = continuationCtx(plans, null)
    const res = await replanPlanHandler.handle(reviseCall, ctx) as { result: string; error?: string }

    expect(res.error).toBe('REPLAN_TARGET_REQUIRED')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // ДОРАБОТКА ПОСЛЕ РЕВЬЮ 28.07. План, рождённый Outcome-пайплайном, чат-ветка
  // трогать НЕ ИМЕЕТ ПРАВА: у него есть Task Contract, quality gate и запрет на
  // расширение writeScope high-risk шагами — на чат-пути всего этого нет.
  // Вдобавок на plan-шаге пайплайна режим прогона принудительно 'plan', а в нём
  // матрица §5 карточку не показывает: доработка проходила БЕЗ гейта качества и
  // БЕЗ нового согласования, то есть молча. Это регрессия, внесённая фиксом
  // дефекта 1 (до него ветки не было и инструмент честно отказывал).
  // ─────────────────────────────────────────────────────────────────────────
  it('план Outcome-пайплайна чат-ветка не переписывает — отказ, а не тихая правка', async () => {
    const { plans } = openStores()
    // Признак происхождения: contractRevision/quality проставляет ТОЛЬКО
    // outcome-ветка create_plan (там есть Task Contract, который их считает).
    const pipelinePlan = plans.create('/p', 'План пайплайна', [{ title: 'Шаг', detail: 'детали' }], {
      contractRevision: 1,
      planRevision: 1,
      quality: { score: 90, status: 'pass', warnings: [], hardErrors: [] } as never,
      agentRunId: RUN_ONE,
    })

    const { ctx } = continuationCtx(plans, pipelinePlan.id)
    const res = await replanPlanHandler.handle(reviseCall, ctx) as { result: string; error?: string }

    expect(res.error).toMatch(/^REPLAN_PIPELINE_OWNED/)
    const after = plans.get(pipelinePlan.id)!
    expect(after.planRevision, 'ревизия выросла в обход quality gate пайплайна').toBe(1)
    expect(after.steps.map(s => s.title), 'шаги подменены мимо гейта').toEqual(['Шаг'])
  })

  // ДОРАБОТКА ПОСЛЕ РЕВЬЮ 28.07: два текста продолжения противоречили друг
  // другу — plan-gate.ts велел «обнови через create_plan», plan-await.ts тут же
  // «правь через replan_plan, новый не создавай». «Дубликата нет» держалось на
  // послушании модели: create_plan о ctx.revisePlanId не знал, а его
  // идемпотентность ключуется по sendId, который у продолжения ДРУГОЙ.
  it('create_plan в прогоне доработки не плодит второй план, а возвращает тот же', async () => {
    const { plans } = openStores()
    const plan = await seedPlanAwaitingApproval(plans)

    const { ctx } = continuationCtx(plans, plan.id)
    const res = await createPlanHandler.handle(createCall, ctx) as { result: string; error?: string }

    expect(res.error).toBeUndefined()
    expect(plans.list('/p'), 'модель послушалась текста — но полагаться на это нельзя').toHaveLength(1)
    expect(res.result).toContain(`planId=${plan.id}`)
    expect(res.result).toContain('replan_plan')
    expect(plans.get(plan.id)!.planRevision, 'create_plan ревизию не двигает').toBe(1)
  })

  it('outcome-путь не задет: без фазы replan инструмент по-прежнему отказывает', async () => {
    const { plans } = openStores()
    const plan = await seedPlanAwaitingApproval(plans)
    const { ctx } = continuationCtx(plans, plan.id)
    const withOutcome = { ...(ctx as object), outcome: { pipelineId: 1, phase: 'execute-step' } } as never

    const res = await replanPlanHandler.handle(reviseCall, withOutcome) as { error?: string }
    expect(res.error).toBe('OUTCOME_REPLAN_CONTEXT_REQUIRED')
  })
})
