import type { Database } from 'better-sqlite3'
import { existsSync, rmSync } from 'fs'

/** Удаляет все записи приложения, привязанные к project_path. */
export function purgeProjectAppData(db: Database, projectPath: string): void {
  const tx = db.transaction(() => {
    const planIds = (db.prepare('SELECT id FROM plans WHERE project_path = ?').all(projectPath) as Array<{ id: number }>)
      .map(r => r.id)
    if (planIds.length > 0) {
      const ph = planIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM plan_steps WHERE plan_id IN (${ph})`).run(...planIds)
      db.prepare(`DELETE FROM plans WHERE id IN (${ph})`).run(...planIds)
    }

    const sessionIds = (db.prepare('SELECT id FROM chat_sessions WHERE project_path = ?').all(projectPath) as Array<{ id: number }>)
      .map(r => r.id)
    if (sessionIds.length > 0) {
      const ph = sessionIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM chats WHERE session_id IN (${ph})`).run(...sessionIds)
    }
    db.prepare('DELETE FROM chats WHERE project_path = ?').run(projectPath)
    db.prepare('DELETE FROM chat_sessions WHERE project_path = ?').run(projectPath)

    db.prepare('DELETE FROM tasks WHERE project_path = ?').run(projectPath)
    db.prepare('DELETE FROM journal WHERE project_path = ?').run(projectPath)
    db.prepare('DELETE FROM file_undo WHERE project_path = ?').run(projectPath)
    db.prepare('DELETE FROM feedback WHERE project_path = ?').run(projectPath)
    db.prepare('DELETE FROM memories WHERE project_path = ?').run(projectPath)
    db.prepare('DELETE FROM audit_log WHERE project_path = ?').run(projectPath)
    db.prepare('DELETE FROM run_inputs WHERE project_path = ?').run(projectPath)
    // 2.0.1 bug: раньше не чистились → фоновый планировщик вечно исполнял cron-прогоны
    // и слал напоминания против УДАЛЁННОГО проекта (осиротевшая автоматизация).
    db.prepare('DELETE FROM scheduled_tasks WHERE project_path = ?').run(projectPath)
    db.prepare('DELETE FROM reminders WHERE project_path = ?').run(projectPath)
    db.prepare('DELETE FROM settings WHERE key = ?').run(`system_prompt_${projectPath}`)
  })
  tx()
}

export function deleteProjectDirectory(projectPath: string): void {
  if (!existsSync(projectPath)) return
  rmSync(projectPath, { recursive: true, force: true })
}