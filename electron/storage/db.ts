import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'

export function openDb(path: string): DB {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_path, created_at);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL,
      provider_id TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_project ON chat_sessions(project_path, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_path, done, created_at);

    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_journal_project ON journal(project_path, created_at);

    CREATE TABLE IF NOT EXISTS projects (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      last_opened_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_undo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      before_content TEXT,
      after_content TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_undo_project ON file_undo(project_path, id);

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project_path, id);

    CREATE TABLE IF NOT EXISTS plan_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, idx);

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT,
      provider_id TEXT,
      rating INTEGER,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)

  runMigrations(db)

  return db
}

/**
 * Versioned migrations. Each entry runs ONCE per database — tracked via
 * `schema_version` table. Adding a new migration: append to MIGRATIONS array
 * with a NEW (higher) `version` number. Never edit/reorder old entries
 * (they may have already run on user databases).
 *
 * Before this lived in openDb() — ALTER TABLE / SELECT scans ran on EVERY
 * app start. Fine while tiny but noticeable as chats table grows. Now
 * migrations only fire on version bump.
 */
const MIGRATIONS: Array<{ version: number; description: string; run: (db: DB) => void }> = [
  {
    version: 1,
    description: 'Chats → session-aware: add session_id column, backfill orphans with "Основной чат" session',
    run: (db) => {
      const chatCols = (db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map(c => c.name)
      if (!chatCols.includes('session_id')) {
        db.exec('ALTER TABLE chats ADD COLUMN session_id INTEGER')
      }
      const orphans = db.prepare(
        `SELECT DISTINCT project_path FROM chats WHERE session_id IS NULL`
      ).all() as Array<{ project_path: string }>
      for (const { project_path } of orphans) {
        const now = Date.now()
        const info = db.prepare(
          'INSERT INTO chat_sessions (project_path, title, created_at, last_message_at) VALUES (?, ?, ?, ?)'
        ).run(project_path, 'Основной чат', now, now)
        db.prepare('UPDATE chats SET session_id = ? WHERE project_path = ? AND session_id IS NULL').run(
          info.lastInsertRowid, project_path
        )
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_chats_session ON chats(session_id, created_at)')
    }
  }
]

function runMigrations(db: DB): void {
  // schema_version: tracks which migrations have been applied. Single-row
  // table — we just keep the highest applied version number.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number } | undefined
  const current = row?.version ?? 0
  const targets = MIGRATIONS.filter(m => m.version > current).sort((a, b) => a.version - b.version)
  if (targets.length === 0) return

  // Apply each pending migration in a transaction. If any throws, the
  // schema_version doesn't advance — user can retry on next start.
  for (const m of targets) {
    const tx = db.transaction(() => {
      m.run(db)
      db.prepare(
        'INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at'
      ).run(m.version, Date.now())
    })
    try {
      tx()
    } catch (err) {
      console.error(`[db] migration v${m.version} (${m.description}) failed:`, err)
      throw err  // abort startup — corrupt schema is worse than crash
    }
  }
}
