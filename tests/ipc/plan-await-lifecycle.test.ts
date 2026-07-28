// VSK-TASK-FLOW-A1 §10 — ожидание согласования живёт СНАРУЖИ прогона.
//
// Дефект, который лечим: гейт ждал решения человека внутри прогона, а рядом
// тикал сторож времени (`agent_run_timeout_ms`). Пользователь, ушедший от
// карточки на обед, возвращался к мёртвому прогону — «Прогон остановлен по
// таймауту», — и утверждать было уже нечего.
//
// Главный кейс файла — «провисел дольше таймаута → после approve выполняется».
// Он написан на РЕАЛЬНОМ стороже (`startRunTimeout`) с подкрученным временем, а
// не на его пересказе. Контрольный кейс рядом показывает, что сторож в тех же
// условиях действительно срабатывает, если прогон остался открытым: без него
// главный кейс был бы зелёным просто потому, что ничего не проверяет.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createAgentRuns } from '../../electron/storage/agent-runs'
import { createPlans } from '../../electron/storage/plans'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'
import { planDecisionOutsideRun } from '../../electron/ai/plan-await'
import { parseResumeCheckpoint } from '../../electron/ai/resume-checkpoint'
import { finalizeApiRun } from '../../electron/ai/runner-finalize'
import { startRunTimeout } from '../../electron/ipc/ai-send/run-bookkeeping'
import {
  __resetPlanForRunForTests,
  __resetAwaitingPlansForTests,
  getPlanAwaitingApproval,
} from '../../electron/ai/runner-shared'

const RUN_ID = 'run-plan-1'
const TIMEOUT_MS = 30_000 // MIN_AGENT_RUN_TIMEOUT_MS — короче сторож не бывает
const HISTORY = JSON.stringify([
  { role: 'user', content: 'Сделай лендинг про натяжные потолки' },
  { role: 'assistant', content: 'Составляю план' },
])

let dir: string
let db: Database | undefined
const dbPath = () => join(dir, 'verstak.db')

function openStores() {
  db = openDb(dbPath())
  return { agentRuns: createAgentRuns(db), plans: createPlans(db) }
}

/** Прогон, который уже поработал и успел записать чекпойнт. */
function seedRun(agentRuns: ReturnType<typeof createAgentRuns>) {
  agentRuns.create({
    runId: RUN_ID, projectPath: '/p', chatId: 7, owner: 'main',
    title: 'Сделай лендинг про натяжные потолки', providerId: 'claude', model: 'sonnet',
    requestedProviderId: null, requestedModel: null, sendId: 1, agentMode: 'ask', accountId: null,
  })
  agentRuns.saveCheckpoint(RUN_ID, 3, HISTORY)
}

/** ToolContext с живым хранилищем планов и включённым гейтом. */
function makeCtx(plans: ReturnType<typeof createPlans>) {
  const sender = { send: vi.fn() }
  return {
    ctx: {
      projectPath: '/p', sendId: 1, runId: RUN_ID, parentChatId: 7,
      agentMode: 'plan', setAgentMode: vi.fn(),
      getSecretForDelegate: (k: string) => (k === 'plan_approval_gate' ? 'true' : null),
      recordPlan: (p: string, title: string, steps: never[], meta: never) => plans.create(p, title, steps, meta),
      getPlan: (id: number) => plans.get(id),
      recordJournal: () => {},
      pendingPlans: new Map(),
      scopedKey: (s: number, c: string) => `${s}::${c}`,
      sender,
    } as never,
    sender,
  }
}

const call = {
  id: 'c1', name: 'create_plan',
  args: {
    title: 'Лендинг',
    steps: [{
      title: 'Собрать страницу',
      detail: 'Записать src/index.html с блоками про натяжные потолки. Критерий готовности: файл открывается.',
    }],
  },
} as never

/** Финал прогона ровно так, как его завершает API-runner на чистом выходе. */
function finalizeCompleted(agentRuns: ReturnType<typeof createAgentRuns>) {
  finalizeApiRun({
    sendId: 1, projectPath: '/p', exitReason: 'completed',
    lastAssistantText: 'План готов, жду подтверждения.', lastSummary: '',
    filesTouched: new Set(), commandsRun: [],
    sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, inputAccounting: undefined },
    recordJournal: () => {}, saveMemory: () => undefined,
    agentRuns, runId: RUN_ID, providerId: 'claude', model: 'sonnet',
    initialMessages: [], toolsSignature: null, attestedThisRun: false,
    toolCallCount: 1, agentsCount: 1, costCents: 0,
    clearCheckpointThrottle: () => {},
  })
}

/** Сторож времени прогона — тот самый, что тикает в проде. */
function armWatchdog(agentRuns: ReturnType<typeof createAgentRuns>, emit: (e: unknown) => void) {
  return startRunTimeout({
    getSecret: (k: string) => (k === 'agent_run_timeout_ms' ? String(TIMEOUT_MS) : null),
    agentRuns, controller: new AbortController(), runId: RUN_ID, sendId: 1,
    projectPath: '/p', chatIdRaw: '7', providerId: 'claude', model: 'sonnet', emit,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-plan-await-'))
  __resetPlanForRunForTests()
  __resetAwaitingPlansForTests()
})
afterEach(() => {
  vi.useRealTimers()
  db?.close(); db = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('§10: прогон не ждёт человека', () => {
  it('create_plan показывает карточку и возвращается, не заводя ожидания внутри прогона', async () => {
    const { plans } = openStores()
    const { ctx, sender } = makeCtx(plans)
    const res = await createPlanHandler.handle(call, ctx) as { result: string; error?: string }

    expect(res.error).toBeUndefined()
    const kinds = sender.send.mock.calls.map(c => (c[1] as { event: { type: string } }).event.type)
    expect(kinds).toContain('plan-approval')
    expect((ctx as unknown as { pendingPlans: Map<string, unknown> }).pendingPlans.size).toBe(0)
  })

  it('план привязан к прогону и чату — по этой связи пойдёт продолжение', async () => {
    const { plans } = openStores()
    const { ctx } = makeCtx(plans)
    await createPlanHandler.handle(call, ctx)
    const plan = plans.list('/p')[0]
    expect(plan.agentRunId).toBe(RUN_ID)
    expect(plan.chatId).toBe(7)
    expect(plan.status, 'до решения человека план не выполняется').toBe('draft')
  })

  it('чистое завершение НЕ уносит чекпойнт, пока по прогону висит план', async () => {
    const { agentRuns, plans } = openStores()
    seedRun(agentRuns)
    const { ctx } = makeCtx(plans)
    await createPlanHandler.handle(call, ctx)
    expect(getPlanAwaitingApproval(RUN_ID)).not.toBeNull()

    finalizeCompleted(agentRuns)

    expect(agentRuns.latestCheckpoint(RUN_ID), 'продолжать после approve стало бы неоткуда').not.toBeNull()
    expect(agentRuns.get(RUN_ID)!.status).toBe('done')
  })

  it('прогон без висящего плана чекпойнт по-прежнему убирает', () => {
    const { agentRuns } = openStores()
    seedRun(agentRuns)
    finalizeCompleted(agentRuns)
    expect(agentRuns.latestCheckpoint(RUN_ID), 'прежнее поведение не должно измениться').toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ГЛАВНЫЙ КЕЙС ПОЗИЦИИ.
// ─────────────────────────────────────────────────────────────────────────────
describe('§10: план, провисевший дольше таймаута, после approve выполняется', () => {
  it('сторож молчит: прогон завершён, ждёт БД, а не живой цикл', async () => {
    vi.useFakeTimers()
    const { agentRuns, plans } = openStores()
    seedRun(agentRuns)
    const { ctx } = makeCtx(plans)

    await createPlanHandler.handle(call, ctx)
    finalizeCompleted(agentRuns)          // прогон завершился штатно, карточка висит
    const emit = vi.fn()
    armWatchdog(agentRuns, emit)          // сторож взведён и НЕ снят
    vi.advanceTimersByTime(TIMEOUT_MS * 3) // человек ушёл надолго

    expect(emit, 'таймаут не имеет права сработать по завершённому прогону').not.toHaveBeenCalled()
    const run = agentRuns.get(RUN_ID)!
    expect(run.status).toBe('done')
    expect(run.error).toBeNull()

    // …и после approve работа продолжается с сохранённого места.
    const plan = plans.list('/p')[0]
    const outcome = planDecisionOutsideRun('approve', undefined, {
      id: plan.id, title: plan.title, agentRunId: plan.agentRunId,
    })
    plans.updatePlanStatus(plan.id, outcome.planStatus)

    expect(outcome.continuation!.resumeFromRunId).toBe(RUN_ID)
    expect(outcome.continuation!.agentMode).toBe('accept-edits')
    expect(plans.get(plan.id)!.status).toBe('running')
    const replay = parseResumeCheckpoint(agentRuns.latestCheckpoint(RUN_ID)!.messagesJson)
    expect(replay, 'история должна реплеиться, а не собираться заново').toHaveLength(2)
    expect(replay![0].content).toContain('натяжные потолки')
  })

  // Контроль: тот же сторож, то же время — но прогон остался открытым (это и был
  // старый путь с ожиданием внутри). Он обязан убить прогон.
  it('контроль: у ОТКРЫТОГО прогона тот же сторож срабатывает и валит его', () => {
    vi.useFakeTimers()
    const { agentRuns } = openStores()
    seedRun(agentRuns)
    const emit = vi.fn()
    armWatchdog(agentRuns, emit)
    vi.advanceTimersByTime(TIMEOUT_MS * 3)

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('остановлен по таймауту'),
    }))
    expect(agentRuns.get(RUN_ID)!.status).toBe('timed_out')
  })
})

describe('§10: решения reject и revise', () => {
  it('reject: план отменён, продолжения нет, чекпойнт освобождается', async () => {
    const { agentRuns, plans } = openStores()
    seedRun(agentRuns)
    const { ctx } = makeCtx(plans)
    await createPlanHandler.handle(call, ctx)
    finalizeCompleted(agentRuns)

    const plan = plans.list('/p')[0]
    const outcome = planDecisionOutsideRun('reject', 'не тот подход', {
      id: plan.id, title: plan.title, agentRunId: plan.agentRunId,
    })
    expect(outcome.planStatus).toBe('cancelled')
    expect(outcome.continuation, 'отклонённый план не выполняется вообще').toBeNull()
    expect(outcome.releaseCheckpoint).toBe(true)
  })

  it('revise: тот же план, продолжение зовёт replan_plan, а не новый create_plan', async () => {
    const { plans } = openStores()
    const { ctx } = makeCtx(plans)
    await createPlanHandler.handle(call, ctx)
    const plan = plans.list('/p')[0]

    const outcome = planDecisionOutsideRun('revise', 'добавь проверку', {
      id: plan.id, title: plan.title, agentRunId: plan.agentRunId,
    })
    expect(outcome.planStatus).toBe('draft')
    expect(outcome.continuation!.text).toContain('добавь проверку')
    expect(outcome.continuation!.text).toContain('replan_plan')
    expect(outcome.continuation!.text).toContain(`#${plan.id}`)
    expect(outcome.continuation!.agentMode, 'доработка прав на запись не даёт').toBeNull()
  })
})

// Сценарий 8 ТЗ: приложение закрыто во время ожидания.
describe('§10 / сценарий 8: ожидание переживает перезапуск', () => {
  it('после перезапуска видно тот же план, то же место и ни одного автодействия', async () => {
    const first = openStores()
    seedRun(first.agentRuns)
    const { ctx } = makeCtx(first.plans)
    await createPlanHandler.handle(call, ctx)
    finalizeCompleted(first.agentRuns)
    db!.close(); db = undefined
    __resetAwaitingPlansForTests() // рестарт: внутрипроцессный реестр пуст

    const after = openStores()
    const plan = after.plans.list('/p')[0]
    expect(plan.status, 'план ждёт человека, а не выполняется сам').toBe('draft')
    expect(plan.agentRunId).toBe(RUN_ID)
    expect(plan.steps.every(s => s.status === 'pending'), 'ответственный шаг не должен повториться сам').toBe(true)
    expect(after.agentRuns.latestCheckpoint(RUN_ID), 'место остановки должно пережить перезапуск').not.toBeNull()

    // Прогон завершился чисто — баннер «сессия прервана» его НЕ предлагает.
    const reconciledAt = Date.now()
    after.agentRuns.reconcileStale('/p')
    expect(after.agentRuns.findResumable('/p', reconciledAt, () => 'запрос')).toHaveLength(0)

    // Решение принимается уже в новом сеансе — и продолжение находит своё место.
    const outcome = planDecisionOutsideRun('approve', undefined, {
      id: plan.id, title: plan.title, agentRunId: plan.agentRunId,
    })
    expect(outcome.continuation!.resumeFromRunId).toBe(RUN_ID)
    expect(parseResumeCheckpoint(after.agentRuns.latestCheckpoint(RUN_ID)!.messagesJson)).not.toBeNull()
  })
})
