// VSK-TASK-FLOW-A1, блок A — characterization ДО правок.
//
// Пакет добавляет в plans/tasks новые связи (chat_id, source_message_id,
// agent_run_id, source, plan_id, plan_step_id, evidence). Прежде чем трогать
// схему, здесь зафиксировано то, что есть СЕЙЧАС: состав колонок, поведение
// каскада, порядок выдачи, статусы. Если миграция или новые связи поедут молча —
// эти пины покраснеют.
//
// Пины пишутся так, чтобы пережить добавление НОВЫХ колонок: проверяется
// присутствие обязательного набора, а не точное равенство списка. Иначе
// characterization сама бы требовала правки при первом же ALTER — а её смысл в
// обратном.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createPlans } from '../../electron/storage/plans'
import { createTasks } from '../../electron/storage/tasks'

let dir: string
let db: Database

const cols = (name: string): string[] =>
  (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map(c => c.name)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-taskflow-'))
  db = openDb(join(dir, 'verstak.db'))
})
afterEach(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('блок A — состав таблиц до правок', () => {
  it('plans держит базовый набор колонок', () => {
    for (const c of ['id', 'project_path', 'title', 'status', 'created_at', 'completed_at',
      'contract_revision', 'plan_revision', 'quality_json']) {
      expect(cols('plans'), `plans.${c}`).toContain(c)
    }
  })

  it('plan_steps держит базовый набор колонок', () => {
    for (const c of ['id', 'plan_id', 'idx', 'title', 'detail', 'status', 'result',
      'run_id', 'verification_status', 'changed_files_count', 'spec_json']) {
      expect(cols('plan_steps'), `plan_steps.${c}`).toContain(c)
    }
  })

  it('tasks держит базовый набор колонок', () => {
    for (const c of ['id', 'project_path', 'text', 'done', 'created_at', 'done_at']) {
      expect(cols('tasks'), `tasks.${c}`).toContain(c)
    }
  })
})

describe('блок A — поведение планов до правок', () => {
  it('создание плана возвращает шаги в порядке idx, статус draft, ревизия 1', () => {
    const plans = createPlans(db)
    const p = plans.create('/p', 'План', [{ title: 'шаг 1' }, { title: 'шаг 2' }])
    expect(p.status).toBe('draft')
    expect(p.planRevision).toBe(1)
    expect(p.steps.map(s => s.title)).toEqual(['шаг 1', 'шаг 2'])
    expect(p.steps.map(s => s.idx)).toEqual([0, 1])
    expect(p.steps.every(s => s.status === 'pending')).toBe(true)
  })

  it('статусы плана переключаются и переживают перечитывание', () => {
    const plans = createPlans(db)
    const p = plans.create('/p', 'План', [{ title: 'шаг' }])
    for (const st of ['running', 'done', 'cancelled'] as const) {
      plans.updatePlanStatus(p.id, st)
      expect(plans.get(p.id)!.status).toBe(st)
    }
  })

  it('удаление плана уносит его шаги каскадом', () => {
    const plans = createPlans(db)
    const p = plans.create('/p', 'План', [{ title: 'шаг' }])
    expect((db.prepare('SELECT COUNT(*) AS n FROM plan_steps WHERE plan_id = ?').get(p.id) as { n: number }).n).toBe(1)
    plans.remove(p.id)
    expect(plans.get(p.id)).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS n FROM plan_steps WHERE plan_id = ?').get(p.id) as { n: number }).n).toBe(0)
  })

  it('план виден в списке своего проекта и не виден в чужом', () => {
    const plans = createPlans(db)
    const p = plans.create('/p', 'План', [{ title: 'шаг' }])
    expect(plans.list('/p').map(x => x.id)).toContain(p.id)
    expect(plans.list('/другой').map(x => x.id)).not.toContain(p.id)
  })
})

describe('блок A — поведение чек-листа до правок', () => {
  it('пункт добавляется открытым и закрывается с отметкой времени', () => {
    const tasks = createTasks(db)
    const t = tasks.add('/p', 'проверить счёт')
    expect(t.done).toBe(false)
    expect(t.doneAt).toBeNull()
    tasks.toggle(t.id, true)
    const after = tasks.list('/p').find(x => x.id === t.id)!
    expect(after.done).toBe(true)
    expect(after.doneAt).toBeGreaterThan(0)
  })

  it('список плоский: сначала открытые, новые выше', () => {
    const tasks = createTasks(db)
    const a = tasks.add('/p', 'первый')
    const b = tasks.add('/p', 'второй')
    tasks.toggle(a.id, true)
    expect(tasks.list('/p').map(x => x.id)).toEqual([b.id, a.id])
  })

  it('clearDone убирает только закрытые', () => {
    const tasks = createTasks(db)
    const a = tasks.add('/p', 'закрытый')
    tasks.add('/p', 'открытый')
    tasks.toggle(a.id, true)
    expect(tasks.clearDone('/p')).toBe(1)
    expect(tasks.list('/p').map(x => x.text)).toEqual(['открытый'])
  })
})

describe('блок A — внешняя запись в plans до правок', () => {
  // Регламент проекта: планы обновляются внешним скриптом через node:sqlite,
  // мимо create_plan. Такая строка обязана читаться приложением.
  it('строка, вставленная сырым INSERT, читается через createPlans', () => {
    const now = Date.now()
    db.prepare(
      "INSERT INTO plans (project_path, title, status, created_at) VALUES (?, ?, 'draft', ?)"
    ).run('/p', 'Внешний план', now)
    const plans = createPlans(db)
    const found = plans.list('/p').find(p => p.title === 'Внешний план')
    expect(found, 'внешний план не виден приложению').toBeTruthy()
    expect(found!.steps).toEqual([])
  })
})
