// Позиция 1 ревью: дыра `accept-edits`.
//
// ДЕФЕКТ. Карточка согласования понижает права прогона до `plan`, а
// АВТОутверждение не понижало ничего. В режиме «Принимать правки» это значило:
// модель объявила план читающим (ошиблась или соврала), карточки нет, режим
// прежний — и первая же запись файла проходит АВТОМАТИЧЕСКИ, без единого клика.
// ТЗ §4.2 обещает обратное: «неверная самооценка модели даёт лишний вопрос
// пользователю, а не тихую запись».
//
// ПОЧЕМУ ТЕСТ ИМЕННО ТАКОЙ. Правило постановщика после трёх разборов: если
// механизм должен ЧТО-ТО ЗАПРЕТИТЬ, тест обязан доказать, что ВЫЗОВ НЕ ПРОШЁЛ, а
// не что в тексте есть предупреждение. Поэтому здесь работает НАСТОЯЩИЙ
// `writeFileHandler` с настоящим `resolveDecision`, а проверяется факт на диске:
// файл создан или нет. Сигнал прогона оборван заранее — значит ветка
// подтверждения гарантированно завершается отказом, а ветка auto-accept пишет.
// Разница между ними видна по файловой системе, а не по строкам.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createPlans } from '../../electron/storage/plans'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'
import { writeFileHandler } from '../../electron/ipc/tool-handlers/file-ops'
import { createFileTools } from '../../electron/ai/tools'
import { __resetPlanForRunForTests, __resetAwaitingPlansForTests } from '../../electron/ai/runner-shared'
import type { AgentMode } from '../../electron/ai/mode-policy'

let dir: string
let db: Database | undefined

/** ТОТ ЖЕ ctx, что проходит через оба инструмента подряд: так работает ход
 *  агента — create_plan и write_file получают один объект контекста. */
function makeCtx(agentMode: AgentMode) {
  db = openDb(join(dir, 'verstak.db'))
  const plans = createPlans(db)
  // Сигнал уже оборван: ветка 'confirm' завершится отказом мгновенно, без
  // ожидания человека. Ветка 'auto-accept' сигнал не спрашивает и пишет файл.
  const aborted = new AbortController()
  aborted.abort()
  const ctx = {
    projectPath: dir, sendId: 1, runId: 'run-1', parentChatId: 7,
    agentMode, setAgentMode: (m: AgentMode) => { ctx.agentMode = m },
    getSecretForDelegate: (k: string) => (k === 'plan_approval_gate' ? 'true' : null),
    recordPlan: (p: string, title: string, steps: never[], meta: never) => plans.create(p, title, steps, meta),
    getPlan: (id: number) => plans.get(id),
    recordJournal: () => {},
    recordWrite: () => {},
    plans,
    tools: createFileTools(dir),
    signal: aborted.signal,
    pendingWrites: new Map(),
    pendingPlans: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    sender: { send: vi.fn() },
  } as unknown as Parameters<typeof writeFileHandler.handle>[1] & { agentMode: AgentMode }
  return { ctx, plans }
}

const READ_ONLY_PLAN = {
  id: 'c1', name: 'create_plan',
  args: {
    title: 'Разобраться в проекте',
    steps: [
      { title: 'Прочитать файлы проекта', detail: 'Просмотреть src/components и собрать список модулей. Критерий готовности: список составлен.' },
      { title: 'Ответить в чате', detail: 'Сформулировать вывод по файлам src/lib: что устарело. Критерий готовности: вывод готов.' },
    ],
  },
} as never

const WRITE_CALL = {
  id: 'w1', name: 'write_file',
  args: { path: 'landing.html', content: '<h1>натяжные потолки</h1>' },
} as never

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-autoapprove-gate-'))
  __resetPlanForRunForTests()
  __resetAwaitingPlansForTests()
})
afterEach(() => { db?.close(); db = undefined; rmSync(dir, { recursive: true, force: true }) })

describe('автоутверждение не выдаёт прав на запись (позиция 1)', () => {
  // КОНТРОЛЬ. Без него главный кейс был бы зелёным просто оттого, что запись не
  // работает в тестовой среде вообще. Здесь она обязана ПРОЙТИ.
  it('контроль: в accept-edits БЕЗ плана запись проходит автоматически', async () => {
    const { ctx } = makeCtx('accept-edits')

    const res = await writeFileHandler.handle(WRITE_CALL, ctx) as { error?: string }

    expect(res.error).toBeUndefined()
    expect(existsSync(join(dir, 'landing.html')), 'заготовка сломана: запись не дошла до диска').toBe(true)
  })

  // ГЛАВНЫЙ КЕЙС ПОЗИЦИИ.
  it('после АВТОутверждённого плана та же запись НЕ проходит без подтверждения', async () => {
    const { ctx } = makeCtx('accept-edits')

    const plan = await createPlanHandler.handle(READ_ONLY_PLAN, ctx) as { result: string; error?: string }
    expect(plan.error).toBeUndefined()
    expect(plan.result, 'заготовка сломана: план должен был автоутвердиться').toContain('автоутверждён')

    const res = await writeFileHandler.handle(WRITE_CALL, ctx) as { error?: string }

    expect(res.error, 'запись прошла молча по НЕутверждённому плану').toBeTruthy()
    expect(existsSync(join(dir, 'landing.html')), 'файл записан без единого клика').toBe(false)
  })

  it('понижение действует и в ТОМ ЖЕ ходе, а не только со следующего', async () => {
    const { ctx } = makeCtx('accept-edits')
    await createPlanHandler.handle(READ_ONLY_PLAN, ctx)

    // ctx.agentMode — снимок для текущего хода. Если бы понижение шло только
    // через setAgentMode-замыкание, вызовы ЭТОГО хода писали бы по-старому.
    expect(ctx.agentMode).toBe('ask')
  })

  it('план с картой карточки понижает права до plan — прежнее поведение цело', async () => {
    const { ctx } = makeCtx('accept-edits')
    const writing = {
      id: 'c2', name: 'create_plan',
      args: {
        title: 'Лендинг',
        steps: [{ title: 'Записать лендинг', detail: 'Создать src/index.html с блоками про потолки. Критерий готовности: файл открывается.' }],
      },
    } as never

    await createPlanHandler.handle(writing, ctx)

    expect(ctx.agentMode).toBe('plan')
    const res = await writeFileHandler.handle(WRITE_CALL, ctx) as { error?: string }
    expect(res.error, 'в plan-режиме запись обязана блокироваться').toBeTruthy()
    expect(existsSync(join(dir, 'landing.html'))).toBe(false)
  })

  it('чтение после автоутверждения по-прежнему свободно — план должен работать', async () => {
    const { ctx } = makeCtx('accept-edits')
    await createPlanHandler.handle(READ_ONLY_PLAN, ctx)

    const { decide } = await import('../../electron/ai/mode-policy')
    expect(decide('read_file', ctx.agentMode)).toBe('auto-accept')
    expect(decide('search_project', ctx.agentMode)).toBe('auto-accept')
  })
})
