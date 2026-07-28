// VSK-TASK-FLOW-A1, блок A — миграция 60, связи и обратная совместимость.
//
// Пины §12.2 и §12.3 ТЗ: миграция СТАРОЙ базы, связи plan/chat/checklist,
// внешний INSERT в plans без новых полей.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createPlans } from '../../electron/storage/plans'
import { createTasks } from '../../electron/storage/tasks'

const require_ = createRequire(import.meta.url)

let dir: string
let db: Database | undefined
const dbPath = () => join(dir, 'verstak.db')
const cols = (d: Database, t: string): string[] =>
  (d.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name)

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-a1-')) })
afterEach(() => {
  db?.close(); db = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('миграция 60: новые колонки', () => {
  it('plans получает происхождение, tasks — источник и связь', () => {
    db = openDb(dbPath())
    for (const c of ['chat_id', 'source_message_id', 'agent_run_id']) {
      expect(cols(db, 'plans'), `plans.${c}`).toContain(c)
    }
    for (const c of ['source', 'plan_id', 'plan_step_id', 'evidence']) {
      expect(cols(db, 'tasks'), `tasks.${c}`).toContain(c)
    }
  })

  it('сторож времени прогона получил отметку ожидания человека', () => {
    db = openDb(dbPath())
    expect(cols(db, 'agent_runs')).toContain('awaiting_human_since')
  })

  it('версия схемы поднялась до 60 и повторное открытие идемпотентно', () => {
    db = openDb(dbPath())
    const v = () => (db!.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }).version
    expect(v()).toBeGreaterThanOrEqual(60)
    db.close()
    db = openDb(dbPath())
    expect(v()).toBeGreaterThanOrEqual(60)
    expect(cols(db, 'tasks')).toContain('source')
  })
})

describe('миграция СТАРОЙ базы: данные не теряются', () => {
  it('план и пункт чек-листа, созданные до миграции, читаются после неё', () => {
    // Собираем базу «как было»: только старые колонки, без новых.
    const Database = require_('better-sqlite3') as typeof import('better-sqlite3')
    const old = new Database(dbPath())
    old.exec(`
      CREATE TABLE plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE TABLE plan_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, idx INTEGER NOT NULL,
        title TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'pending', result TEXT
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL, text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, done_at INTEGER
      );
    `)
    old.prepare("INSERT INTO plans (project_path, title, status, created_at) VALUES ('/p','Старый план','running',1000)").run()
    old.prepare("INSERT INTO plan_steps (plan_id, idx, title, status) VALUES (1, 0, 'старый шаг', 'done')").run()
    old.prepare("INSERT INTO tasks (project_path, text, done, created_at) VALUES ('/p','старый пункт',0,1000)").run()
    old.close()

    db = openDb(dbPath())
    const plan = createPlans(db).list('/p').find(p => p.title === 'Старый план')
    expect(plan, 'старый план потерялся').toBeTruthy()
    expect(plan!.status).toBe('running')
    expect(plan!.steps.map(s => s.title)).toEqual(['старый шаг'])
    // Новые поля у старой записи пустые — это норма, а не поломка.
    expect(plan!.chatId).toBeNull()
    expect(plan!.sourceMessageId).toBeNull()
    expect(plan!.agentRunId).toBeNull()

    const task = createTasks(db).list('/p').find(t => t.text === 'старый пункт')
    expect(task, 'старый пункт чек-листа потерялся').toBeTruthy()
    // Старые записи были ручными — такими и остаются.
    expect(task!.source).toBe('manual')
    expect(task!.planId).toBeNull()
    expect(task!.evidence).toBeNull()
  })
})

describe('связи plan / chat / чек-лист', () => {
  it('план запоминает чат, сообщение и прогон', () => {
    db = openDb(dbPath())
    const plans = createPlans(db)
    const p = plans.create('/p', 'План из диалога', [{ title: 'шаг' }], {
      chatId: 7, sourceMessageId: 42, agentRunId: 'run-abc',
    })
    expect(p.chatId).toBe(7)
    expect(plans.get(p.id)!.sourceMessageId).toBe(42)
    expect(plans.list('/p').find(x => x.id === p.id)!.agentRunId).toBe('run-abc')
  })

  it('ручной пункт живёт без плана', () => {
    db = openDb(dbPath())
    const t = createTasks(db).add('/p', 'позвонить клиенту')
    expect(t.source).toBe('manual')
    expect(t.planId).toBeNull()
    expect(t.planStepId).toBeNull()
  })

  it('системный пункт связывается с планом и шагом', () => {
    db = openDb(dbPath())
    const plan = createPlans(db).create('/p', 'План', [{ title: 'шаг' }])
    const t = createTasks(db).add('/p', 'проверить readback', {
      source: 'system', planId: plan.id, planStepId: plan.steps[0].id,
    })
    expect(t.source).toBe('system')
    expect(t.planId).toBe(plan.id)
    expect(t.planStepId).toBe(plan.steps[0].id)
  })

  // Ключевой инвариант §8: удаление плана НЕ каскадит в чек-лист.
  it('удаление плана не удаляет пункты — только обнуляет связь', () => {
    db = openDb(dbPath())
    const plans = createPlans(db)
    const tasks = createTasks(db)
    const plan = plans.create('/p', 'План', [{ title: 'шаг' }])
    const личный = tasks.add('/p', 'мой пункт')
    const связанный = tasks.add('/p', 'системный пункт', {
      source: 'system', planId: plan.id, planStepId: plan.steps[0].id,
    })

    plans.remove(plan.id)

    const after = tasks.list('/p')
    expect(after.map(t => t.id).sort()).toEqual([личный.id, связанный.id].sort())
    const было = after.find(t => t.id === связанный.id)!
    expect(было.planId, 'связь должна обнулиться, а не остаться битой').toBeNull()
    expect(было.planStepId).toBeNull()
    expect(было.source, 'источник пункта не меняется от удаления плана').toBe('system')
    expect(after.find(t => t.id === личный.id)!.text).toBe('мой пункт')
  })
})

describe('внешние записи мимо create_plan', () => {
  // Регламент проекта: планы пишет внешний скрипт через node:sqlite. Такая
  // строка не знает о новых колонках и обязана остаться читаемой.
  it('INSERT без chat_id и source_message_id читается и не ломает список', () => {
    db = openDb(dbPath())
    db.prepare(
      "INSERT INTO plans (project_path, title, status, created_at) VALUES (?, ?, 'draft', ?)"
    ).run('/p', 'Внешний план', Date.now())

    const list = createPlans(db).list('/p')
    const external = list.find(p => p.title === 'Внешний план')!
    expect(external).toBeTruthy()
    expect(external.chatId).toBeNull()
    expect(external.sourceMessageId).toBeNull()
    expect(external.agentRunId).toBeNull()
    expect(external.planRevision, 'ревизия должна иметь значение по умолчанию').toBe(1)
    expect(external.steps).toEqual([])
    // Список целиком сериализуется — ровно это делает IPC перед отдачей в UI.
    expect(() => JSON.stringify(list)).not.toThrow()
  })

  it('внешний INSERT в tasks без source читается как ручной пункт', () => {
    db = openDb(dbPath())
    db.prepare(
      'INSERT INTO tasks (project_path, text, done, created_at) VALUES (?, ?, 0, ?)'
    ).run('/p', 'внешний пункт', Date.now())
    const t = createTasks(db).list('/p').find(x => x.text === 'внешний пункт')!
    expect(t.source).toBe('manual')
    expect(t.planId).toBeNull()
  })

  it('внешний INSERT со ступенями читается вместе с шагами', () => {
    db = openDb(dbPath())
    const info = db.prepare(
      "INSERT INTO plans (project_path, title, status, created_at) VALUES (?, ?, 'running', ?)"
    ).run('/p', 'Внешний с шагами', Date.now())
    const planId = Number(info.lastInsertRowid)
    db.prepare("INSERT INTO plan_steps (plan_id, idx, title, status) VALUES (?, 0, 'внешний шаг', 'pending')").run(planId)
    const p = createPlans(db).get(planId)!
    expect(p.steps.map(s => s.title)).toEqual(['внешний шаг'])
  })
})
