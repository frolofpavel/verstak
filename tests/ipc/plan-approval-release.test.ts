// Хвост §10, дефект 5: удержанный чекпойнт не освобождался НИКОГДА.
//
// ДЕФЕКТ. Прогон, показавший карточку, помечает себя «план ждёт решения» —
// и финализация не удаляет его чекпойнт: с него поедет работа после approve.
// Снимала пометку ровно одна дорога — `plans:resolve-approval`, то есть кнопка.
// Карточка, убранная Stop'ом, Shift+Esc или закрытием проекта, чистила только
// слот в интерфейсе: снапшот всей истории прогона оставался в БД навсегда, и
// освободить его было нечем.
//
// ЧТО ЗАКРЕПЛЕНО. У удержания есть путь освобождения, не завязанный на кнопку:
// снятие карточки без решения и удаление самого плана освобождают чекпойнт.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createAgentRuns } from '../../electron/storage/agent-runs'
import { createPlans } from '../../electron/storage/plans'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'
import { finalizeApiRun } from '../../electron/ai/runner-finalize'
import { releasePlanApproval } from '../../electron/ipc/plans'
import {
  __resetPlanForRunForTests,
  __resetAwaitingPlansForTests,
  getPlanAwaitingApproval,
} from '../../electron/ai/runner-shared'

const RUN_ID = 'run-plan-hold'
const HISTORY = JSON.stringify([{ role: 'user', content: 'Сделай лендинг' }])

let dir: string
let db: Database | undefined

function openStores() {
  db = openDb(join(dir, 'verstak.db'))
  return { agentRuns: createAgentRuns(db), plans: createPlans(db) }
}

type Plans = ReturnType<typeof createPlans>
type Runs = ReturnType<typeof createAgentRuns>

function seedRun(agentRuns: Runs) {
  agentRuns.create({
    runId: RUN_ID, projectPath: '/p', chatId: 7, owner: 'main',
    title: 'Сделай лендинг', providerId: 'claude', model: 'sonnet',
    requestedProviderId: null, requestedModel: null, sendId: 1, agentMode: 'ask', accountId: null,
  })
  agentRuns.saveCheckpoint(RUN_ID, 3, HISTORY)
}

function makeCtx(plans: Plans) {
  return {
    projectPath: '/p', sendId: 1, runId: RUN_ID, parentChatId: 7,
    agentMode: 'ask', setAgentMode: vi.fn(),
    getSecretForDelegate: (k: string) => (k === 'plan_approval_gate' ? 'true' : null),
    recordPlan: (p: string, title: string, steps: never[], meta: never) => plans.create(p, title, steps, meta),
    getPlan: (id: number) => plans.get(id),
    recordJournal: () => {},
    plans,
    pendingPlans: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    sender: { send: vi.fn() },
  } as never
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

function finalizeCompleted(agentRuns: Runs) {
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

/** Прогон показал карточку и завершился: чекпойнт удержан ожиданием. */
async function holdCheckpoint() {
  const { agentRuns, plans } = openStores()
  seedRun(agentRuns)
  await createPlanHandler.handle(call, makeCtx(plans))
  finalizeCompleted(agentRuns)
  const plan = plans.list('/p')[0]
  expect(agentRuns.latestCheckpoint(RUN_ID), 'заготовка сломана: чекпойнт не удержан').not.toBeNull()
  expect(getPlanAwaitingApproval(RUN_ID)).toBe(plan.id)
  return { agentRuns, plans, plan }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-plan-release-'))
  __resetPlanForRunForTests()
  __resetAwaitingPlansForTests()
})
afterEach(() => {
  db?.close(); db = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('§10 хвост: у удержанного чекпойнта есть путь освобождения', () => {
  it('карточка снята без решения → чекпойнт освобождён, план остался в «Планах»', async () => {
    const { agentRuns, plans, plan } = await holdCheckpoint()

    releasePlanApproval(plans, agentRuns, plan.id)

    expect(agentRuns.latestCheckpoint(RUN_ID), 'снапшот истории висел бы вечно').toBeNull()
    expect(getPlanAwaitingApproval(RUN_ID), 'реестр ожиданий тоже течёт').toBeNull()
    expect(plans.get(plan.id), 'план — не мусор: он остаётся виден человеку').not.toBeNull()
    expect(plans.get(plan.id)!.status, 'решения не было — статус не выдумываем').toBe('draft')
  })

  it('освобождение идемпотентно и не падает на удалённом плане', async () => {
    const { agentRuns, plans, plan } = await holdCheckpoint()
    releasePlanApproval(plans, agentRuns, plan.id)
    plans.remove(plan.id)
    expect(() => releasePlanApproval(plans, agentRuns, plan.id)).not.toThrow()
  })

  it('удаление плана с висящей карточкой тоже освобождает чекпойнт', async () => {
    const { agentRuns, plans, plan } = await holdCheckpoint()

    releasePlanApproval(plans, agentRuns, plan.id)
    plans.remove(plan.id)

    expect(agentRuns.latestCheckpoint(RUN_ID)).toBeNull()
    expect(plans.get(plan.id)).toBeNull()
  })
})
