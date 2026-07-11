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
    // 2.0.1 + ре-ревью: «удалить данные проекта» оставляло данные в ~15 таблицах с
    // project_path. Осиротевшая автоматизация (scheduled_tasks/reminders вечно
    // исполнялись), утечка приватности (project_brain/file_summary/context_pack/
    // decision_record — контент-несущие), и активный вред: оставшийся project_brain
    // (UNIQUE project_path, INSERT ON CONFLICT DO NOTHING) ВОСКРЕШАЛ старый «мозг»
    // при повторном добавлении проекта по тому же пути. Чистим всё в одной tx.
    // Дети без своего project_path — по FK родителя ДО удаления родителя.
    db.prepare('DELETE FROM dev_task_runs WHERE dev_task_id IN (SELECT id FROM dev_tasks WHERE project_path = ?)').run(projectPath)
    db.prepare('DELETE FROM dev_task_checks WHERE dev_task_id IN (SELECT id FROM dev_tasks WHERE project_path = ?)').run(projectPath)
    db.prepare('DELETE FROM agent_run_events WHERE run_id IN (SELECT run_id FROM agent_runs WHERE project_path = ?)').run(projectPath)
    // Ре-ревью 2: agent_run_checkpoints (run_id PK, БЕЗ project_path) хранит messages_json —
    // полную историю диалога прерванных прогонов. Без чистки — контент-сирота навсегда.
    db.prepare('DELETE FROM agent_run_checkpoints WHERE run_id IN (SELECT run_id FROM agent_runs WHERE project_path = ?)').run(projectPath)
    for (const t of [
      'scheduled_tasks', 'reminders', 'session_todos', 'agent_runs',
      'verifications', 'dev_tasks', 'pipeline_runs', 'project_brain', 'file_summary',
      'context_pack', 'decision_record', 'model_scoreboard', 'undo_floors', 'worktree_sessions',
    ]) {
      db.prepare(`DELETE FROM ${t} WHERE project_path = ?`).run(projectPath)  // имена таблиц — литералы, не user-input
    }
    db.prepare('DELETE FROM agency_hive_mind WHERE source_project_path = ?').run(projectPath)
    db.prepare('DELETE FROM settings WHERE key = ?').run(`system_prompt_${projectPath}`)
  })
  tx()
}

export function deleteProjectDirectory(projectPath: string): void {
  if (!existsSync(projectPath)) return
  rmSync(projectPath, { recursive: true, force: true })
}