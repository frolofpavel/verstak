/**
 * NL-cron storage — расписанные unattended-прогоны. Каждая запись: NL-промпт +
 * cron + проект + опц. провайдер/модель. Планировщик в main опрашивает enabled-задачи
 * раз в минуту (cronMatches) и запускает headless, пушит итог наружу (Telegram).
 */

import type { Database } from 'better-sqlite3'

export interface ScheduledTask {
  id: number
  project_path: string
  prompt: string
  cron: string
  human: string
  enabled: boolean
  provider_id: string | null
  model: string | null
  created_at: number
  last_run_at: number | null
  last_status: 'ok' | 'error' | null
  last_result: string | null
  last_run_minute: number | null
}

interface Row extends Omit<ScheduledTask, 'enabled'> { enabled: number }

function toTask(r: Row): ScheduledTask {
  return { ...r, enabled: r.enabled === 1 }
}

export function createScheduledTask(
  db: Database,
  input: { projectPath: string; prompt: string; cron: string; human: string; providerId?: string | null; model?: string | null }
): ScheduledTask {
  const now = Date.now()
  const info = db.prepare(
    `INSERT INTO scheduled_tasks (project_path, prompt, cron, human, enabled, provider_id, model, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(input.projectPath, input.prompt, input.cron, input.human, input.providerId ?? null, input.model ?? null, now)
  return getScheduledTask(db, Number(info.lastInsertRowid))!
}

export function getScheduledTask(db: Database, id: number): ScheduledTask | null {
  const r = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as Row | undefined
  return r ? toTask(r) : null
}

/** Все задачи проекта (или всех проектов, если projectPath не задан). */
export function listScheduledTasks(db: Database, projectPath?: string): ScheduledTask[] {
  const rows = projectPath
    ? db.prepare('SELECT * FROM scheduled_tasks WHERE project_path = ? ORDER BY created_at DESC').all(projectPath)
    : db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all()
  return (rows as Row[]).map(toTask)
}

/** Только включённые — для опроса планировщиком. */
export function listEnabledScheduledTasks(db: Database): ScheduledTask[] {
  const rows = db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1').all() as Row[]
  return rows.map(toTask)
}

export function setScheduledTaskEnabled(db: Database, id: number, enabled: boolean): void {
  db.prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function deleteScheduledTask(db: Database, id: number): boolean {
  return db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0
}

/** Записать результат прогона. minute — порядковый номер минуты (анти-двойное срабатывание). */
export function recordScheduledRun(
  db: Database,
  id: number,
  result: { status: 'ok' | 'error'; summary: string; minute: number; at: number }
): void {
  db.prepare(
    'UPDATE scheduled_tasks SET last_run_at = ?, last_status = ?, last_result = ?, last_run_minute = ? WHERE id = ?'
  ).run(result.at, result.status, result.summary.slice(0, 2000), result.minute, id)
}
