// VSK-TASK-FLOW-A1 §6 и пункт 12 из §12 — headless и scheduled план-гейта не получают.
//
// Почему проверка появилась именно сейчас. До §10 ожидание согласования жило
// внутри прогона: у путей без человека оно в худшем случае привело бы к зависанию
// одного прогона. После §10 ожидание живёт в БД и ПЕРЕЖИВАЕТ прогон — план
// остаётся в `draft`, а чекпойнт прогона намеренно не удаляется. Значит цена
// ошибки выросла: unattended-путь, случайно получивший гейт, копил бы за собой
// висящие планы и снапшоты, которых никто никогда не утвердит.
//
// Ответ по итогам проверки: оба пути НЕ ЗАТРОНУТЫ, и причины у них разные —
// поэтому и проверок две, а не одна общая.
//   · scheduled идёт через общий ToolContext, но `create_plan` нет в его наборе
//     инструментов, а условие гейта на его контексте ложно;
//   · scripts/verstak-cli.mjs — отдельная программа со своими инструментами,
//     которая ничего из electron/ не импортирует вовсе.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { SCHEDULED_READONLY_TOOLS } from '../../electron/ipc/ai'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'
import { openDb } from '../../electron/storage/db'
import { createAgentRuns } from '../../electron/storage/agent-runs'
import { createPlans } from '../../electron/storage/plans'
import { finalizeApiRun } from '../../electron/ai/runner-finalize'
import {
  __resetPlanForRunForTests,
  __resetAwaitingPlansForTests,
  getPlanAwaitingApproval,
} from '../../electron/ai/runner-shared'

const RUN_ID = 'run-scheduled-1'
let dir: string
let db: Database | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-headless-gate-'))
  __resetPlanForRunForTests()
  __resetAwaitingPlansForTests()
})
afterEach(() => {
  db?.close(); db = undefined
  rmSync(dir, { recursive: true, force: true })
})

const call = {
  id: 'c1', name: 'create_plan',
  args: {
    title: 'Ночная сводка',
    steps: [{
      title: 'Исправить auth',
      detail: 'В src/auth/login.ts исправить создание сессии. Критерий готовности: npm test -- auth проходит.',
    }],
  },
} as never

describe('scheduled-прогон: план-гейт недостижим', () => {
  it('в разрешённом наборе scheduled нет ни create_plan, ни replan_plan', () => {
    expect(SCHEDULED_READONLY_TOOLS).not.toContain('create_plan')
    expect(SCHEDULED_READONLY_TOOLS).not.toContain('replan_plan')
  })

  // Главная проверка блока: контекст собран ровно как в runScheduledHeadless
  // (agentMode 'auto', outcome отсутствует), а настройка гейта ВКЛЮЧЕНА — то есть
  // худший из возможных случаев. Карточки быть не должно и ожидания тоже.
  it('даже при включённой настройке гейта scheduled не заводит согласования', async () => {
    db = openDb(join(dir, 'verstak.db'))
    const plans = createPlans(db)
    const sender = { send: vi.fn() }
    const ctx = {
      projectPath: '/p', sendId: -1, runId: RUN_ID,
      agentMode: 'auto',                       // как в runScheduledHeadless
      readOnlyConnectors: true,
      getSecretForDelegate: () => 'true',      // настройка гейта включена глобально
      recordPlan: (p: string, t: string, s: never[], m: never) => plans.create(p, t, s, m),
      getPlan: (id: number) => plans.get(id),
      recordJournal: () => {},
      pendingPlans: new Map(),
      scopedKey: (s: number, c: string) => `${s}::${c}`,
      sender,
    } as never

    const res = await createPlanHandler.handle(call, ctx) as { result: string }

    const kinds = sender.send.mock.calls.map(c => (c[1] as { event: { type: string } }).event.type)
    expect(kinds, 'unattended-пути некому показывать карточку').not.toContain('plan-approval')
    expect(getPlanAwaitingApproval(RUN_ID), 'ожидание согласования не должно заводиться').toBeNull()
    expect(res.result).toContain('Plan #')
  })

  // Прямое следствие §10, ради которого проверка и написана: unattended-прогон не
  // копит за собой снапшоты. Чекпойнт удерживает только план, ждущий человека.
  it('scheduled не оставляет за собой удержанный чекпойнт', async () => {
    db = openDb(join(dir, 'verstak.db'))
    const plans = createPlans(db)
    const agentRuns = createAgentRuns(db)
    agentRuns.create({
      runId: RUN_ID, projectPath: '/p', chatId: null, owner: 'main',
      title: 'Ночная сводка', providerId: 'claude', model: 'sonnet',
      requestedProviderId: null, requestedModel: null, sendId: -1, agentMode: 'auto', accountId: null,
    })
    agentRuns.saveCheckpoint(RUN_ID, 1, JSON.stringify([{ role: 'user', content: 'сводка' }]))

    await createPlanHandler.handle(call, {
      projectPath: '/p', sendId: -1, runId: RUN_ID, agentMode: 'auto',
      getSecretForDelegate: () => 'true',
      recordPlan: (p: string, t: string, s: never[], m: never) => plans.create(p, t, s, m),
      getPlan: (id: number) => plans.get(id),
      recordJournal: () => {}, pendingPlans: new Map(),
      scopedKey: (s: number, c: string) => `${s}::${c}`,
      sender: { send: vi.fn() },
    } as never)

    finalizeApiRun({
      sendId: -1, projectPath: '/p', exitReason: 'completed',
      lastAssistantText: 'готово', lastSummary: '',
      filesTouched: new Set(), commandsRun: [],
      sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, inputAccounting: undefined },
      recordJournal: () => {}, saveMemory: () => undefined,
      agentRuns, runId: RUN_ID, providerId: 'claude', model: 'sonnet',
      initialMessages: [], toolsSignature: null, attestedThisRun: false,
      toolCallCount: 1, agentsCount: 1, costCents: 0,
      clearCheckpointThrottle: () => {},
    })

    expect(agentRuns.latestCheckpoint(RUN_ID), 'снапшот держать не за чем — никто ничего не ждёт').toBeNull()
    expect(agentRuns.get(RUN_ID)!.status).toBe('done')
  })
})

describe('headless scripts/verstak-cli.mjs: отдельная программа со своим набором', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/verstak-cli.mjs'), 'utf8')

  it('инструмента create_plan у headless нет — гейту не за что зацепиться', () => {
    expect(src).not.toContain('create_plan')
    expect(src).not.toContain('replan_plan')
  })

  it('о согласовании планов headless не знает ничего', () => {
    for (const marker of ['plan-approval', 'plan_approval_gate', 'plans:resolve-approval', 'pendingPlans']) {
      expect(src, `headless не должен знать про ${marker}`).not.toContain(marker)
    }
  })

  // Причина неуязвимости структурная, а не случайная: скрипт не тянет код
  // приложения вообще. Если однажды потянет — эта проверка покраснеет раньше,
  // чем гейт доедет до unattended-пути.
  it('headless не импортирует код приложения — общий гейт до него не дотягивается', () => {
    const appImports = src.match(/from\s+['"][^'"]*(electron|\.\.\/electron|src)\//g) ?? []
    expect(appImports, 'headless обязан оставаться самостоятельным').toEqual([])
  })
})
