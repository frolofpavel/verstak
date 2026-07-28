// Блок C, §9 ТЗ: чек-лист проекта как инструменты агента.
//
// Ключевое правило, ради которого инструменты и заводились отдельно от session
// todos: СИСТЕМНЫЙ пункт закрывается только по ДОКАЗАТЕЛЬСТВУ, а не по
// совпадению текста и не по «кажется сделано». Ручной пункт человека при этом
// живёт своей жизнью: без плана, без evidence, закрывается руками.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createTasks } from '../../electron/storage/tasks'
import { createPlans } from '../../electron/storage/plans'
import {
  checklistAddHandler,
  checklistCompleteHandler,
  checklistListHandler,
} from '../../electron/ipc/tool-handlers/checklist'

let dir: string
let db: Database | undefined
type Tasks = ReturnType<typeof createTasks>

function openStores() {
  db = openDb(join(dir, 'verstak.db'))
  return { tasks: createTasks(db), plans: createPlans(db) }
}

const ctxOf = (tasks: Tasks) => ({
  projectPath: '/p', sendId: 1, runId: 'run-1',
  tasks, recordJournal: () => {}, sender: { send: vi.fn() },
}) as never

const call = (name: string, args: Record<string, unknown>) => ({ id: 'c1', name, args }) as never

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-checklist-')) })
afterEach(() => { db?.close(); db = undefined; rmSync(dir, { recursive: true, force: true }) })

describe('блок C §9: инструменты чек-листа', () => {
  it('checklist_add заводит СИСТЕМНЫЙ пункт — источник не берётся у модели', async () => {
    const { tasks } = openStores()
    const res = await checklistAddHandler.handle(
      call('checklist_add', { text: 'Проверить счётчик Метрики на проде', source: 'manual' }),
      ctxOf(tasks),
    ) as { result: string; error?: string }

    expect(res.error).toBeUndefined()
    const [item] = tasks.list('/p')
    expect(item.text).toBe('Проверить счётчик Метрики на проде')
    expect(item.source, 'источник — факт происхождения, а не аргумент модели').toBe('system')
    expect(item.done).toBe(false)
  })

  it('связь с планом необязательна и сохраняется, когда передана', async () => {
    const { tasks, plans } = openStores()
    const plan = plans.create('/p', 'План', [{ title: 'Шаг' }])
    await checklistAddHandler.handle(call('checklist_add', { text: 'С планом', planId: plan.id }), ctxOf(tasks))
    await checklistAddHandler.handle(call('checklist_add', { text: 'Без плана' }), ctxOf(tasks))

    const items = tasks.list('/p')
    expect(items.find(i => i.text === 'С планом')?.planId).toBe(plan.id)
    expect(items.find(i => i.text === 'Без плана')?.planId).toBeNull()
  })

  // ГЛАВНЫЙ ПИН БЛОКА C.
  it('checklist_complete БЕЗ доказательства не закрывает пункт', async () => {
    const { tasks } = openStores()
    const item = tasks.add('/p', 'Отправить отчёт клиенту', { source: 'system' })

    const res = await checklistCompleteHandler.handle(
      call('checklist_complete', { id: item.id, evidence: '   ' }),
      ctxOf(tasks),
    ) as { error?: string }

    expect(res.error).toContain('CHECKLIST_EVIDENCE_REQUIRED')
    expect(tasks.list('/p')[0].done, 'пункт закрылся без доказательства').toBe(false)
  })

  it('checklist_complete с доказательством закрывает и сохраняет его', async () => {
    const { tasks } = openStores()
    const item = tasks.add('/p', 'Собрать отчёт', { source: 'system' })

    // Фикстура сменена после ревью 28.07: доказательство теперь проверяется тем
    // же способом, что на пайплайн-оси (существующий файл проекта ЛИБО ссылка
    // run:/event:/artifact:/command:). Утверждения теста не изменились —
    // «закрылось и доказательство сохранено»; изменилось только само
    // доказательство, потому что прежняя строка была вымышленным путём.
    await checklistCompleteHandler.handle(
      call('checklist_complete', { id: item.id, evidence: 'artifact:reports/2026-07.csv' }),
      ctxOf(tasks),
    )

    const [done] = tasks.list('/p')
    expect(done.done).toBe(true)
    expect(done.evidence).toBe('artifact:reports/2026-07.csv')
    expect(done.doneAt).not.toBeNull()
  })

  it('несуществующий пункт — честная ошибка, а не тихий успех', async () => {
    const { tasks } = openStores()
    const res = await checklistCompleteHandler.handle(
      call('checklist_complete', { id: 999, evidence: 'файл' }),
      ctxOf(tasks),
    ) as { error?: string }
    expect(res.error).toContain('не найден')
  })

  it('checklist_list показывает источник, связь и доказательство', async () => {
    const { tasks, plans } = openStores()
    const plan = plans.create('/p', 'План', [{ title: 'Шаг' }])
    tasks.add('/p', 'Личный пункт')
    const sys = tasks.add('/p', 'Системный пункт', { source: 'system', planId: plan.id })
    tasks.complete(sys.id, 'src/index.html')

    const res = await checklistListHandler.handle(call('checklist_list', {}), ctxOf(tasks)) as { result: string }

    expect(res.result).toContain('Личный пункт')
    expect(res.result).toContain('пользователь')
    expect(res.result).toContain('Verstak')
    expect(res.result).toContain(`план #${plan.id}`)
    expect(res.result).toContain('src/index.html')
  })

  it('пустой чек-лист — понятный ответ, а не пустая строка', async () => {
    const { tasks } = openStores()
    const res = await checklistListHandler.handle(call('checklist_list', {}), ctxOf(tasks)) as { result: string }
    expect(res.result).toBe('Чек-лист пуст.')
  })

  it('ручной пункт человека не трогается инструментами агента', async () => {
    const { tasks } = openStores()
    const manual = tasks.add('/p', 'Мой личный пункт')
    await checklistAddHandler.handle(call('checklist_add', { text: 'Пункт агента' }), ctxOf(tasks))

    const items = tasks.list('/p')
    expect(items).toHaveLength(2)
    expect(items.find(i => i.id === manual.id)?.source).toBe('manual')
    expect(items.find(i => i.id === manual.id)?.done).toBe(false)
  })
})
