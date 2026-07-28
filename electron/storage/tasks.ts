import type { Database } from 'better-sqlite3'

/** Кто завёл пункт: человек руками или Verstak по ходу работы. */
export type TaskSource = 'manual' | 'system'

export interface Task {
  id: number
  text: string
  done: boolean
  createdAt: number
  doneAt: number | null
  source: TaskSource
  /** Связь с планом НЕОБЯЗАТЕЛЬНА: личный пункт живёт без неё, а у системного
   *  она обнуляется при удалении плана — пункт остаётся. */
  planId: number | null
  planStepId: number | null
  /** Доказательство выполнения. Системный пункт закрывается только по нему,
   *  а не по совпадению текста. */
  evidence: string | null
}

export interface AddTaskOptions {
  source?: TaskSource
  planId?: number | null
  planStepId?: number | null
}

export interface Tasks {
  list: (projectPath: string) => Task[]
  add: (projectPath: string, text: string, opts?: AddTaskOptions) => Task
  toggle: (id: number, done: boolean) => void
  /** §9 ТЗ: системный пункт закрывается ТОЛЬКО с доказательством. Пустое
   *  evidence — не закрытие: возвращает false и ничего не меняет. */
  complete: (id: number, evidence: string) => boolean
  remove: (id: number) => void
  clearDone: (projectPath: string) => number
}

interface Row {
  id: number
  text: string
  done: number
  createdAt: number
  doneAt: number | null
  source: string | null
  planId: number | null
  planStepId: number | null
  evidence: string | null
}

function rowToTask(r: Row): Task {
  return {
    id: r.id, text: r.text, done: !!r.done, createdAt: r.createdAt, doneAt: r.doneAt,
    // Внешняя запись могла не проставить source — считаем такой пункт ручным.
    source: r.source === 'system' ? 'system' : 'manual',
    planId: r.planId, planStepId: r.planStepId, evidence: r.evidence,
  }
}

export function createTasks(db: Database): Tasks {
  return {
    list(projectPath) {
      const rows = db.prepare(`
        SELECT id, text, done, created_at as createdAt, done_at as doneAt,
               source, plan_id as planId, plan_step_id as planStepId, evidence
        FROM tasks WHERE project_path = ?
        ORDER BY done ASC, id DESC
      `).all(projectPath) as Row[]
      return rows.map(rowToTask)
    },
    add(projectPath, text, opts = {}) {
      const now = Date.now()
      const source: TaskSource = opts.source === 'system' ? 'system' : 'manual'
      const planId = opts.planId ?? null
      const planStepId = opts.planStepId ?? null
      const info = db.prepare(
        `INSERT INTO tasks (project_path, text, done, created_at, source, plan_id, plan_step_id)
         VALUES (?, ?, 0, ?, ?, ?, ?)`
      ).run(projectPath, text, now, source, planId, planStepId)
      return {
        id: Number(info.lastInsertRowid), text, done: false, createdAt: now, doneAt: null,
        source, planId, planStepId, evidence: null,
      }
    },
    toggle(id, done) {
      const doneAt = done ? Date.now() : null
      db.prepare('UPDATE tasks SET done = ?, done_at = ? WHERE id = ?').run(done ? 1 : 0, doneAt, id)
    },
    complete(id, evidence) {
      // «Закрыто по совпадению текста» — ровно то, что ТЗ запрещает: закрытие
      // системного пункта обязано опираться на доказательство. Нет его — нет и
      // закрытия, причём молча ничего не меняем.
      const proof = (evidence ?? '').trim()
      if (!proof) return false
      const info = db.prepare('UPDATE tasks SET done = 1, done_at = ?, evidence = ? WHERE id = ?')
        .run(Date.now(), proof, id)
      return info.changes > 0
    },
    remove(id) {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    },
    clearDone(projectPath) {
      const info = db.prepare('DELETE FROM tasks WHERE project_path = ? AND done = 1').run(projectPath)
      return info.changes
    }
  }
}
