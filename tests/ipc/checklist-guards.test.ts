// Ревью 28.07 нашло две дыры в чек-листе, живые при ЛЮБОМ положении тумблера:
// инструменты чек-листа гейтом согласования не закрыты.
//
// 1. `checklist_complete` не смотрел на `source` вообще — агент мог закрыть
//    пункт, который завёл ЧЕЛОВЕК. В отчёте при этом стояло «ваши личные пункты
//    не трогает», а одноимённый пин проверял только `checklist_add`: заголовок
//    пина стерёг больше, чем его тело. Здесь тело соответствует заголовку.
// 2. «Доказательством» считалась любая непустая строка: `evidence='.'` закрывал
//    пункт. При этом на пайплайн-оси тот же продукт требует, чтобы артефакт
//    ФИЗИЧЕСКИ существовал (`evidenceExists`). Два разных понятия доказательства
//    внутри одного продукта — теперь одно.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createTasks } from '../../electron/storage/tasks'
import { checklistCompleteHandler } from '../../electron/ipc/tool-handlers/checklist'

let dir: string
let db: Database | undefined
type Tasks = ReturnType<typeof createTasks>

function openStores() {
  db = openDb(join(dir, 'verstak.db'))
  return createTasks(db)
}

const ctxOf = (tasks: Tasks) => ({
  projectPath: dir, sendId: 1, runId: 'run-1',
  tasks, recordJournal: () => {}, sender: { send: vi.fn() },
}) as never

const complete = (id: number, evidence: string) =>
  checklistCompleteHandler.handle({ id: 'c1', name: 'checklist_complete', args: { id, evidence } } as never, ctxOf(tasksRef!))

let tasksRef: Tasks | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-checklist-guards-'))
  writeFileSync(join(dir, 'out.csv'), 'a,b\n')
  tasksRef = openStores()
})
afterEach(() => { db?.close(); db = undefined; tasksRef = null; rmSync(dir, { recursive: true, force: true }) })

describe('чек-лист: агент не закрывает пункты человека', () => {
  it('checklist_complete отказывается закрывать РУЧНОЙ пункт', async () => {
    const manual = tasksRef!.add(dir, 'Мой личный пункт')

    const res = await complete(manual.id, 'out.csv') as { error?: string }

    expect(res.error, 'агент закрыл пункт, который завёл человек').toContain('CHECKLIST_MANUAL_ITEM')
    expect(tasksRef!.list(dir)[0].done).toBe(false)
  })

  it('системный пункт тем же вызовом закрывается — отказ адресный, а не тотальный', async () => {
    const sys = tasksRef!.add(dir, 'Системный пункт', { source: 'system' })

    const res = await complete(sys.id, 'out.csv') as { error?: string }

    expect(res.error).toBeUndefined()
    expect(tasksRef!.list(dir)[0].done).toBe(true)
  })

  it('запрет живёт в хранилище, а не только в инструменте', () => {
    const manual = tasksRef!.add(dir, 'Ручной пункт')
    expect(tasksRef!.complete(manual.id, 'out.csv'), 'обход мимо инструмента').toBe(false)
    expect(tasksRef!.list(dir)[0].done).toBe(false)
  })
})

describe('чек-лист: доказательство одно на весь продукт', () => {
  it('строка-заглушка доказательством не считается', async () => {
    const sys = tasksRef!.add(dir, 'Системный пункт', { source: 'system' })

    const res = await complete(sys.id, '.') as { error?: string }

    expect(res.error, '«.» закрывало пункт — доказательство было формальностью').toContain('CHECKLIST_EVIDENCE_INVALID')
    expect(tasksRef!.list(dir)[0].done).toBe(false)
  })

  it('несуществующий файл доказательством не считается', async () => {
    const sys = tasksRef!.add(dir, 'Системный пункт', { source: 'system' })
    const res = await complete(sys.id, 'reports/never-created.csv') as { error?: string }
    expect(res.error).toContain('CHECKLIST_EVIDENCE_INVALID')
  })

  it('существующий файл проекта — доказательство', async () => {
    const sys = tasksRef!.add(dir, 'Системный пункт', { source: 'system' })
    const res = await complete(sys.id, 'out.csv') as { error?: string }
    expect(res.error).toBeUndefined()
    expect(tasksRef!.list(dir)[0].evidence).toBe('out.csv')
  })

  it('ссылка на прогон/артефакт/команду — доказательство того же вида, что на пайплайн-оси', async () => {
    const a = tasksRef!.add(dir, 'A', { source: 'system' })
    const b = tasksRef!.add(dir, 'B', { source: 'system' })
    expect((await complete(a.id, 'run:abc-123') as { error?: string }).error).toBeUndefined()
    expect((await complete(b.id, 'command:npm test') as { error?: string }).error).toBeUndefined()
  })

  it('путь наружу проекта доказательством не считается', async () => {
    const sys = tasksRef!.add(dir, 'Системный пункт', { source: 'system' })
    const res = await complete(sys.id, '../secrets.env') as { error?: string }
    expect(res.error).toContain('CHECKLIST_EVIDENCE_INVALID')
  })
})
