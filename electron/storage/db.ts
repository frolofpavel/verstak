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
  },
  {
    version: 2,
    description: 'Chat sessions → typed (main/review) с привязкой review-чатов к родительскому через parent_chat_id',
    run: (db) => {
      const cols = (db.prepare("PRAGMA table_info(chat_sessions)").all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('kind')) {
        // Используем DEFAULT 'main' чтобы все существующие чаты автоматически
        // получили правильный kind без бэкфилла. NOT NULL гарантирует, что
        // забыть kind при создании нового чата нельзя.
        db.exec("ALTER TABLE chat_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'main'")
      }
      if (!cols.includes('parent_chat_id')) {
        // NULL для main-чатов (у них нет родителя). Заполняется только для
        // review sub-chats — указывает, какой чат они ревьюят.
        db.exec("ALTER TABLE chat_sessions ADD COLUMN parent_chat_id INTEGER")
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent ON chat_sessions(parent_chat_id) WHERE parent_chat_id IS NOT NULL')
    }
  },
  {
    version: 3,
    description: 'User profiles — multi-user поддержка для команды агентства (14 человек). + onboarding state.',
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          role TEXT,
          default_provider TEXT,
          default_model TEXT,
          skills_enabled TEXT,
          created_at INTEGER NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_active ON user_profiles(is_active) WHERE is_active = 1;
      `)
      // Onboarding completed flag хранится отдельно — простой key в settings,
      // не нужна новая таблица. Когда wizard завершён → settings.setSecret(
      // 'onboarding_completed', '1') + создаётся первый user_profile.
    }
  },
  {
    version: 4,
    description: 'agent memories with FTS5',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id          TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          type        TEXT NOT NULL CHECK(type IN ('fact','decision','bug','preference','pattern')),
          content     TEXT NOT NULL,
          tags        TEXT NOT NULL DEFAULT '[]',
          created_at  INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_path);
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          tags,
          content=memories,
          content_rowid=rowid
        );
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
        END;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
        END;
        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
          INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
        END;
      `)
    }
  },
  {
    version: 5,
    description: 'memories: UNIQUE constraint on (project_path, content) to prevent duplicate saves',
    run: (db: DB) => {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_content ON memories(project_path, content);
      `)
    }
  },
  {
    version: 6,
    description: 'FTS5 index for chat message search (conversation_search tool)',
    run: (db: DB) => {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
          content,
          content=chats,
          content_rowid=rowid
        );

        -- Populate from existing data
        INSERT INTO chats_fts(chats_fts) VALUES('rebuild');

        -- Keep in sync with inserts and deletes
        CREATE TRIGGER IF NOT EXISTS chats_fts_ai AFTER INSERT ON chats BEGIN
          INSERT INTO chats_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS chats_fts_ad AFTER DELETE ON chats BEGIN
          INSERT INTO chats_fts(chats_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        END;
      `)
    }
  },
  {
    version: 7,
    description: 'memories: add decay_score column for Ebbinghaus forgetting curve',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('decay_score')) {
        db.exec('ALTER TABLE memories ADD COLUMN decay_score REAL NOT NULL DEFAULT 1.0')
      }
    }
  },
  {
    version: 8,
    description: 'audit_log — полный журнал всех агентских действий для отладки и enterprise-использования',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          project_path TEXT NOT NULL,
          chat_id INTEGER,
          action TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '{}',
          provider_id TEXT,
          model TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_path);
      `)
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
