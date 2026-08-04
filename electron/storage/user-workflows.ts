import type { Database } from 'better-sqlite3'
import type { WorkflowStep } from '../ai/workflows/types'

/**
 * Задача 7A: пользовательские workflow — сохранённые повторяемые прогоны.
 * Отдельная таблица `user_workflows` (built-in WORKFLOWS в коде не трогаем).
 * steps хранятся JSON-строкой (steps_json), парсятся на чтении.
 */
export interface UserWorkflow {
  id: number
  projectPath: string
  name: string
  description: string | null
  icon: string | null
  briefTemplate: string | null
  steps: WorkflowStep[]
  createdAt: number
}

export interface NewUserWorkflow {
  name: string
  description?: string | null
  icon?: string | null
  briefTemplate?: string | null
  steps: WorkflowStep[]
}

export interface UserWorkflows {
  listByProject: (projectPath: string) => UserWorkflow[]
  get: (id: number) => UserWorkflow | null
  save: (projectPath: string, wf: NewUserWorkflow) => UserWorkflow
  remove: (id: number) => void
}

interface Row {
  id: number
  project_path: string
  name: string
  description: string | null
  icon: string | null
  brief_template: string | null
  steps_json: string
  created_at: number
}

function toWorkflow(r: Row): UserWorkflow {
  let steps: WorkflowStep[] = []
  try {
    const parsed = JSON.parse(r.steps_json) as unknown
    if (Array.isArray(parsed)) steps = parsed as WorkflowStep[]
  } catch { /* битый JSON — пустые шаги, не роняем список */ }
  return {
    id: r.id,
    projectPath: r.project_path,
    name: r.name,
    description: r.description,
    icon: r.icon,
    briefTemplate: r.brief_template,
    steps,
    createdAt: r.created_at,
  }
}

export function createUserWorkflows(db: Database): UserWorkflows {
  return {
    listByProject(projectPath) {
      const rows = db.prepare(
        'SELECT * FROM user_workflows WHERE project_path = ? ORDER BY created_at DESC'
      ).all(projectPath) as Row[]
      return rows.map(toWorkflow)
    },
    get(id) {
      const row = db.prepare('SELECT * FROM user_workflows WHERE id = ?').get(id) as Row | undefined
      return row ? toWorkflow(row) : null
    },
    save(projectPath, wf) {
      const createdAt = Date.now()
      const info = db.prepare(
        `INSERT INTO user_workflows (project_path, name, description, icon, brief_template, steps_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        projectPath,
        wf.name,
        wf.description ?? null,
        wf.icon ?? null,
        wf.briefTemplate ?? null,
        JSON.stringify(wf.steps ?? []),
        createdAt,
      )
      return this.get(Number(info.lastInsertRowid))!
    },
    remove(id) {
      db.prepare('DELETE FROM user_workflows WHERE id = ?').run(id)
    },
  }
}
