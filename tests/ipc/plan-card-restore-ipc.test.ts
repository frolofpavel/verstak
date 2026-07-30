// §2.3 A3 · сквозной путь восстановления: настоящая БД, настоящий IPC.
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ ЧИСТЫХ ПИНОВ. Чистая функция отбора (plan-restore.ts)
// проверяется рядом, но сама по себе она НЕ доказывает, что дефект исправлен:
// правильная функция, которую никто не зовёт, оставляет карточку потерянной
// ровно как раньше. Это тот же класс ложной закрытости, что ловили сегодня
// трижды (SEC-CMD-04, 05, 07). Поэтому здесь путь целиком: план кладётся в
// РЕАЛЬНУЮ базу, чекпойнт — в реальную таблицу, и карточка запрашивается через
// зарегистрированный IPC-хендлер, как её запросит renderer при входе в чат.
//
// «Перезапуск» воспроизводится честно: БД закрывается и открывается заново,
// хендлеры регистрируются с нуля — в памяти не остаётся ничего.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } }
}))

const { openDb } = await import('../../electron/storage/db')
const { createPlans } = await import('../../electron/storage/plans')
const { createAgentRuns } = await import('../../electron/storage/agent-runs')
const { registerPlansIpc } = await import('../../electron/ipc/plans')

const PROJECT = 'C:/proj'

let dir: string
let dbPath: string
let db: DB

interface Card { planId: number; chatId: number; stepCount: number; resumable: boolean }

/** Открыть БД и зарегистрировать IPC — как при старте приложения. */
function boot() {
  db = openDb(dbPath)
  const plans = createPlans(db)
  const agentRuns = createAgentRuns(db)
  handlers.clear()
  registerPlansIpc(plans, agentRuns)
  return { plans, agentRuns }
}

/** Закрыть всё — как при выходе из приложения. */
function shutdown() {
  db.close()
  handlers.clear()
}

const pendingCards = (chatId?: number) =>
  handlers.get('plans:pending-cards')!(null, PROJECT, chatId) as Card[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vst-plan-restore-'))
  dbPath = join(dir, 'test.db')
})
afterEach(() => {
  try { db.close() } catch { /* уже закрыта */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('§2.3 сквозной · карточка переживает перезапуск', () => {
  // ОБЯЗАТЕЛЬНЫЙ ПИН ЗАДАЧИ: до фикса восстанавливать было нечем — канала нет.
  it('план draft с прогоном и чекпойнтом → после перезапуска карточка снова доступна', () => {
    const first = boot()
    const plan = first.plans.create(PROJECT, 'Починить экспорт', [{ title: 'шаг 1' }, { title: 'шаг 2' }], {
      chatId: 7,
      agentRunId: 'run-1',
    })
    first.agentRuns.create({ runId: 'run-1', projectPath: PROJECT, chatId: 7, title: 'прогон' })
    first.agentRuns.saveCheckpoint('run-1', 1, '[]')
    shutdown()

    boot() // перезапуск: в памяти не осталось ничего

    const cards = pendingCards()
    expect(cards, 'после перезапуска карточку не вернуть — одобрить план нечем').toHaveLength(1)
    expect(cards[0]).toMatchObject({ planId: plan.id, chatId: 7, stepCount: 2, resumable: true })
  })

  it('чекпойнт освобождён → карточка есть, но без продолжения', () => {
    const first = boot()
    first.plans.create(PROJECT, 'План', [{ title: 'ш' }], { chatId: 7, agentRunId: 'run-2' })
    first.agentRuns.create({ runId: 'run-2', projectPath: PROJECT, chatId: 7, title: 'прогон' })
    // чекпойнт не сохраняли — эквивалент вычищенного
    shutdown()

    boot()

    const [card] = pendingCards()
    expect(card, 'план пропал с экрана вместе с чекпойнтом').toBeTruthy()
    expect(card.resumable, 'предложена кнопка, которая ничего не сделает').toBe(false)
  })

  // ЗАЩИТА ОТ ВОЗВРАТА ДЕФЕКТА 4 §10 — на ДВУХ чатах, иначе пин не измеряет.
  it('два чата: каждый получает СВОЮ карточку, чужую не получает', () => {
    const first = boot()
    const a = first.plans.create(PROJECT, 'План A', [{ title: 'a' }], { chatId: 10, agentRunId: 'run-a' })
    const b = first.plans.create(PROJECT, 'План B', [{ title: 'b' }], { chatId: 20, agentRunId: 'run-b' })
    for (const r of ['run-a', 'run-b']) {
      first.agentRuns.create({ runId: r, projectPath: PROJECT, chatId: r === 'run-a' ? 10 : 20, title: 'прогон' })
      first.agentRuns.saveCheckpoint(r, 1, '[]')
    }
    shutdown()

    boot()

    expect(pendingCards(10).map(c => c.planId), 'в чат A уехала чужая карточка').toEqual([a.id])
    expect(pendingCards(20).map(c => c.planId), 'в чат B уехала чужая карточка').toEqual([b.id])
    expect(pendingCards()).toHaveLength(2)
  })

  it('решённый план карточку не возвращает', () => {
    const first = boot()
    const p = first.plans.create(PROJECT, 'П', [{ title: 'ш' }], { chatId: 7, agentRunId: 'run-3' })
    first.agentRuns.create({ runId: 'run-3', projectPath: PROJECT, chatId: 7, title: 'прогон' })
    first.agentRuns.saveCheckpoint('run-3', 1, '[]')
    first.plans.updatePlanStatus(p.id, 'running')
    shutdown()

    boot()

    expect(pendingCards()).toEqual([])
  })

  // КОНТРОЛЬ: одобрение после восстановления реально продолжает работу, иначе
  // «карточка вернулась» ничего не стоит.
  it('контроль: approve по восстановленной карточке отдаёт продолжение', () => {
    const first = boot()
    const p = first.plans.create(PROJECT, 'П', [{ title: 'ш' }], { chatId: 7, agentRunId: 'run-4' })
    first.agentRuns.create({ runId: 'run-4', projectPath: PROJECT, chatId: 7, title: 'прогон' })
    first.agentRuns.saveCheckpoint('run-4', 1, '[]')
    shutdown()

    boot()
    const [card] = pendingCards()
    const res = handlers.get('plans:resolve-approval')!(null, card.planId, 'approve') as {
      planStatus: string | null
      continuation: { resumeFromRunId?: string | null } | null
    }

    expect(res.planStatus, 'план не перешёл в работу').toBe('running')
    expect(res.continuation?.resumeFromRunId, 'продолжение не привязано к чекпойнту').toBe('run-4')
    expect(p.id).toBe(card.planId)
  })
})
