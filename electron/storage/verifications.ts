import type { Database } from 'better-sqlite3'

/**
 * Verification Artifact (Фаза 3) — лёгкая строка истории DoD поверх файла-
 * артефакта (.verification.json/.html). Источник истины — файл; эта таблица
 * нужна для истории прогонов и для verifications.latest(chatId) в Explicit
 * Review (ревьюер сверяет утверждения агента с доказательством).
 *
 * Пишет insert хендлер attest_verification (Фаза 2) после writeVerificationArtifact.
 * Читают: панель истории + Review (latest).
 */

export type VerificationOverall = 'passed' | 'failed' | 'partial' | 'not_run'

export interface VerificationRow {
  id: number
  projectPath: string
  chatId: number | null
  runId: string | null
  overall: VerificationOverall
  checksTotal: number
  checksPassed: number
  changedFilesCount: number
  artifactPath: string
  htmlPath: string | null
  taskSummary: string | null
  createdAt: number
}

export interface Verifications {
  /** Вставить строку истории. Возвращает id. Поля из VerificationArtifact + пути. */
  insert: (row: Omit<VerificationRow, 'id'>) => number
  /** История проекта, новейшие первыми. */
  list: (projectPath: string, limit?: number) => VerificationRow[]
  /** Свежайшая верификация проекта; если задан chatId — только этого чата. */
  latest: (projectPath: string, chatId?: number | null) => VerificationRow | null
  get: (id: number) => VerificationRow | null
}

const SELECT = `
  SELECT id, project_path as projectPath, chat_id as chatId, run_id as runId,
         overall, checks_total as checksTotal, checks_passed as checksPassed,
         changed_files_count as changedFilesCount, artifact_path as artifactPath,
         html_path as htmlPath, task_summary as taskSummary, created_at as createdAt
  FROM verifications
`

export function createVerifications(db: Database): Verifications {
  return {
    insert(row) {
      const info = db.prepare(
        `INSERT INTO verifications
          (project_path, chat_id, run_id, overall, checks_total, checks_passed,
           changed_files_count, artifact_path, html_path, task_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.projectPath,
        row.chatId ?? null,
        row.runId ?? null,
        row.overall,
        row.checksTotal,
        row.checksPassed,
        row.changedFilesCount,
        row.artifactPath,
        row.htmlPath ?? null,
        row.taskSummary ?? null,
        row.createdAt
      )
      return Number(info.lastInsertRowid)
    },
    list(projectPath, limit = 100) {
      // created_at DESC, id DESC — детерминированный тай-брейк при равных метках.
      return db.prepare(
        `${SELECT} WHERE project_path = ? ORDER BY created_at DESC, id DESC LIMIT ?`
      ).all(projectPath, limit) as VerificationRow[]
    },
    latest(projectPath, chatId) {
      if (chatId != null) {
        const row = db.prepare(
          `${SELECT} WHERE project_path = ? AND chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
        ).get(projectPath, chatId) as VerificationRow | undefined
        return row ?? null
      }
      const row = db.prepare(
        `${SELECT} WHERE project_path = ? ORDER BY created_at DESC, id DESC LIMIT 1`
      ).get(projectPath) as VerificationRow | undefined
      return row ?? null
    },
    get(id) {
      const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as VerificationRow | undefined
      return row ?? null
    }
  }
}
