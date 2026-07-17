import type { Database as DB } from 'better-sqlite3'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

export function openDb(path: string): DB {
  // Lazy require: даёт ensureBetterSqlite3Healthy() отработать до загрузки .node
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
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
      applied_skills TEXT NOT NULL DEFAULT '[]',
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
  repairSchema(db)

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
  },
  {
    version: 9,
    description: 'audit_log.run_id — явный ID агентного запуска (один ai:send = один run). Старые строки → null.',
    run: (db: DB) => {
      db.exec(`
        ALTER TABLE audit_log ADD COLUMN run_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log(run_id);
      `)
    }
  },
  {
    version: 10,
    description: 'run_inputs — снапшот реального входа агентного запуска (provider/model/system/user) для Debug Packet',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_inputs (
          run_id TEXT PRIMARY KEY,
          project_path TEXT,
          chat_id INTEGER,
          timestamp INTEGER,
          provider_id TEXT,
          model TEXT,
          system_prompt TEXT,
          user_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_run_inputs_project ON run_inputs(project_path);
      `)
    }
  },
  {
    version: 11,
    description: 'plan_steps execution-trace: run_id / verification_status / changed_files_count. Старые шаги → null.',
    run: (db: DB) => {
      // Три отдельных ADD COLUMN — превращают статичный план в трейс выполнения:
      // какой run выполнил шаг, прошла ли верификация, сколько файлов изменилось.
      db.exec('ALTER TABLE plan_steps ADD COLUMN run_id TEXT')
      db.exec('ALTER TABLE plan_steps ADD COLUMN verification_status TEXT')
      db.exec('ALTER TABLE plan_steps ADD COLUMN changed_files_count INTEGER')
    }
  },
  {
    version: 12,
    description: 'Persistent sub-agent sessions (Фаза 2): kind=subagent + метаданные суба (role/status/task/group_tag/tool_count/cost/call_id). provider_id/model пишутся в штатные колонки chat_sessions.',
    run: (db: DB) => {
      // kind уже TEXT с DEFAULT 'main' (миграция 2) — добавляем лишь новое
      // значение 'subagent', схему менять не нужно. Здесь только доп. колонки
      // с метаданными субагента. Все NULL для существующих main/review-сессий —
      // субовые поля заполняются только при kind='subagent'. provider_id и model
      // суб-сессии пишутся в уже существующие штатные колонки chat_sessions, поэтому
      // отдельные sub_provider_id/sub_model не нужны.
      const cols = (db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>).map(c => c.name)
      // sub_role — роль субагента (researcher / executor / critic / planner / verifier).
      if (!cols.includes('sub_role')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_role TEXT')
      // sub_status — running / done / error / cancelled. Переживает перезагрузку,
      // в отличие от эфемерной subagent-run карточки.
      if (!cols.includes('sub_status')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_status TEXT')
      // sub_task — краткий текст задачи (промпт суба), для панели Agents.
      if (!cols.includes('sub_task')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_task TEXT')
      // sub_group — тег/группа батча для массовой отмены по тегу (Идея 6).
      if (!cols.includes('sub_group')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_group TEXT')
      // sub_tool_count — сколько tool-вызовов сделал суб (счётчик из loop'а).
      if (!cols.includes('sub_tool_count')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_tool_count INTEGER')
      // sub_cost_cents — стоимость суба в центах (из cost-guard), для панели.
      if (!cols.includes('sub_cost_cents')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_cost_cents INTEGER')
      // sub_call_id — callId эфемерной subagent-run карточки → связь UI ↔ сессия.
      if (!cols.includes('sub_call_id')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_call_id TEXT')
      // sub_started_at / sub_ended_at — для подсчёта длительности в панели.
      if (!cols.includes('sub_started_at')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_started_at INTEGER')
      if (!cols.includes('sub_ended_at')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_ended_at INTEGER')
      db.exec("CREATE INDEX IF NOT EXISTS idx_chat_sessions_subagent ON chat_sessions(parent_chat_id, kind) WHERE kind = 'subagent'")
    }
  },
  {
    version: 13,
    description: 'TodoGate (Фаза 3): session_todos — оркестрационный todo-лист в рамках сессии/цели. Главный агент создаёт, субы берут/закрывают.',
    run: (db: DB) => {
      // Отдельная лёгкая таблица, НЕ переиспользуем tasks: tasks — плоские
      // persistent проектные задачи (id/text/done), а session_todos — эфемерный
      // оркестрационный лист одного прогона/цели с status-enum, assignee и order.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_todos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          session_id INTEGER,
          goal TEXT,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','blocked')),
          assignee_call_id TEXT,
          ord INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_todos_project ON session_todos(project_path, session_id, ord);
      `)
    }
  },
  {
    version: 14,
    description: 'Дерево делегирования (Фаза 4, Идея 3): sub_depth + sub_parent_call_id для иерархии main → суб → под-суб + пометка swarm-роя.',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>).map(c => c.name)
      // sub_depth — глубина узла в дереве (главный=0, его суб=1, …). NULL у
      // старых субов → визуализация трактует как 0/корень.
      if (!cols.includes('sub_depth')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_depth INTEGER')
      // sub_parent_call_id — callId агента-родителя. Связывает под-субов с их
      // субом-родителем для дерева в панели Agents (sub_call_id ← sub_parent_call_id).
      if (!cols.includes('sub_parent_call_id')) db.exec('ALTER TABLE chat_sessions ADD COLUMN sub_parent_call_id TEXT')
    }
  },
  {
    version: 15,
    description: 'projects.icon_path — пользовательская иконка проекта (PNG в userData)',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('icon_path')) {
        db.exec('ALTER TABLE projects ADD COLUMN icon_path TEXT')
      }
    }
  },
  {
    version: 16,
    description: 'Multi-agent Manager (Фаза 1): agent_runs (тонкий слой «задача» поверх run_id) + agent_run_events (Timeline). Keyed by существующий run_id из ai.ts.',
    run: (db: DB) => {
      // agent_runs — одна строка на один ai:send (run_id = randomUUID из ai.ts).
      // owner из SendOwner (main/review/delegate/background). status вычисляется
      // по ходу прогона. Счётчики (agents/tool/files/cost) агрегирует Manager.
      // ВАЖНО: эту таблицу позже дополнит Crash-resume (P1) через ALTER (миграция
      // 19) — не дублировать, добавлять колонки туда.
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_runs (
          run_id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          chat_id INTEGER,
          owner TEXT NOT NULL DEFAULT 'main' CHECK(owner IN ('main','review','delegate','background')),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('queued','running','waiting_review','done','failed','stopped')),
          provider_id TEXT, model TEXT, send_id INTEGER,
          agents_count INTEGER NOT NULL DEFAULT 0, tool_count INTEGER NOT NULL DEFAULT 0,
          files_count INTEGER NOT NULL DEFAULT 0, cost_cents INTEGER NOT NULL DEFAULT 0,
          error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_path, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(project_path, status);

        CREATE TABLE IF NOT EXISTS agent_run_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
          kind TEXT NOT NULL, label TEXT, detail TEXT, ref TEXT, status TEXT, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_events_run ON agent_run_events(run_id, id);
      `)
    }
  },
  {
    version: 17,
    description: 'Verification Artifact (Фаза 3): verifications — лёгкая строка истории DoD поверх файла-артефакта (.verification.json/.html). Нужна для verifications.latest(chatId) в Explicit Review.',
    run: (db: DB) => {
      // Источник истины — файл-артефакт в .verstak/artifacts/. Эта таблица —
      // лёгкий индекс для истории и выборки latest по чату (Review DoD).
      db.exec(`
        CREATE TABLE IF NOT EXISTS verifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL, chat_id INTEGER, run_id TEXT,
          overall TEXT NOT NULL,            -- passed/failed/partial/not_run
          checks_total INTEGER NOT NULL DEFAULT 0, checks_passed INTEGER NOT NULL DEFAULT 0,
          changed_files_count INTEGER NOT NULL DEFAULT 0,
          artifact_path TEXT NOT NULL, html_path TEXT, task_summary TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_verifications_project ON verifications(project_path, created_at);
        CREATE INDEX IF NOT EXISTS idx_verifications_chat ON verifications(chat_id);
      `)
    }
  },
  {
    version: 18,
    description: 'Dev Task Flow (Фаза 1): dev_tasks (тонкий оркестратор задача→ветка→проверки→пакет) + dev_task_runs (связь с run_id) + dev_task_checks. changed_files НЕ дублируем — источник истины git diff.',
    run: (db: DB) => {
      // dev_tasks — один объект агрегирует ветку / run_id'ы / чекпоинт / проверки
      // / итоговый пакет поверх готовых undo/checkpoint, plans, verify, git.
      // state — машина состояний draft → branching → in_progress → review_ready →
      // (paused) → packaged → committed/cancelled. package_json — замороженный
      // снимок пакета на момент packaged (JSON-текст).
      db.exec(`
        CREATE TABLE IF NOT EXISTS dev_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL, chat_id INTEGER, plan_id INTEGER,
          title TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'draft'
            CHECK(state IN ('draft','branching','in_progress','review_ready','paused','packaged','committed','cancelled')),
          base_branch TEXT, base_sha TEXT, work_branch TEXT, worktree_path TEXT,
          checkpoint_id INTEGER, risk TEXT, summary TEXT, package_json TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dev_tasks_project ON dev_tasks(project_path, id DESC);
        CREATE INDEX IF NOT EXISTS idx_dev_tasks_chat ON dev_tasks(chat_id);

        CREATE TABLE IF NOT EXISTS dev_task_runs (
          dev_task_id INTEGER NOT NULL, run_id TEXT NOT NULL,
          PRIMARY KEY (dev_task_id, run_id)
        );

        CREATE TABLE IF NOT EXISTS dev_task_checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT, dev_task_id INTEGER NOT NULL,
          label TEXT NOT NULL, command TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','running','pass','fail','skipped')),
          exit_code INTEGER, output_tail TEXT, ran_in_worktree INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dev_task_checks_task ON dev_task_checks(dev_task_id);
      `)
    }
  },
  {
    version: 19,
    description: 'Crash-resume (P1): ДОПОЛНЯЕТ agent_runs живым прогрессом — turn_index/last_tool_name/last_checkpoint_id/agent_mode/updated_at. Не новая таблица: agentRuns.tick() пишет прогресс на каждом turn, findResumable читает зависшие после краха для баннера «сессия прервана».',
    run: (db: DB) => {
      // ALTER под PRAGMA-guard — миграция идемпотентна, если частично применилась.
      // enum CHECK status НЕ трогаем (sqlite не умеет ALTER CHECK без перестройки
      // таблицы): зависшие прогоны остаются status='running' до reconcileStale,
      // findResumable ловит их по снапшоту до реконсайла (см. agent-runs.ts).
      const cols = (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(c => c.name)
      // turn_index — номер последнего завершённого хода агентного цикла (0 = ещё
      // ни одного). Питает баннер «прервано на ходу N».
      if (!cols.includes('turn_index')) db.exec('ALTER TABLE agent_runs ADD COLUMN turn_index INTEGER DEFAULT 0')
      // last_tool_name — имя последнего диспетчеризованного инструмента. КЛЮЧЕВОЕ
      // для гарда безопасности: write_file/apply_patch/run_command и т.п. →
      // деструктив, авто-возобновление запрещено.
      if (!cols.includes('last_tool_name')) db.exec('ALTER TABLE agent_runs ADD COLUMN last_tool_name TEXT')
      // last_checkpoint_id — undo-head на момент последнего тика (для «показать
      // что было сделано» / будущего checkpoint-resume V2).
      if (!cols.includes('last_checkpoint_id')) db.exec('ALTER TABLE agent_runs ADD COLUMN last_checkpoint_id INTEGER')
      // agent_mode — режим прогона (ask/accept-edits/plan/auto/bypass). auto/bypass
      // → авто-возобновление запрещено (мог быть незаметный деструктив).
      if (!cols.includes('agent_mode')) db.exec('ALTER TABLE agent_runs ADD COLUMN agent_mode TEXT')
      // updated_at — время последнего тика (живость прогона). NULL у старых строк.
      if (!cols.includes('updated_at')) db.exec('ALTER TABLE agent_runs ADD COLUMN updated_at INTEGER')
    }
  },
  {
    version: 20,
    description: 'project_groups (Rayner) — группы проектов в rail. Номер 20: у Ильи был v13 (коллизия с нашей v13), при объединении унифицировано в v20, чтобы пользователи на schema 19 (1.5.0) получили таблицы этой миграцией.',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          collapsed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_group_members (
          group_id INTEGER NOT NULL,
          project_path TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (group_id, project_path),
          FOREIGN KEY (group_id) REFERENCES project_groups(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_project_group_members_path ON project_group_members(project_path);
      `)
    }
  },
  {
    version: 21,
    description: 'projects.hidden — скрытые проекты в отдельной секции rail',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('hidden')) {
        db.exec('ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
      }
    }
  },
  {
    version: 22,
    description: 'pipeline_runs — сквозной сценарий Brief→Plan→Execute→Verify→Proof (Pipeline спек)',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          chat_id INTEGER,
          agent_run_id TEXT,
          mode TEXT NOT NULL,
          workflow_id TEXT,
          step TEXT NOT NULL,
          brief_json TEXT NOT NULL,
          plan_id INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project ON pipeline_runs(project_path);
      `)
    }
  },
  {
    version: 23,
    description: 'projects.kind + remote_json — удалённые проекты (git-клон / ssh-live)',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('kind')) {
        db.exec("ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'local'")
      }
      if (!cols.includes('remote_json')) {
        db.exec('ALTER TABLE projects ADD COLUMN remote_json TEXT')
      }
    }
  },
  {
    version: 24,
    description: 'pipeline_runs.verify_attempts — ядро надёжности v3 (verify-gate авто-починки)',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(pipeline_runs)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('verify_attempts')) {
        db.exec('ALTER TABLE pipeline_runs ADD COLUMN verify_attempts INTEGER NOT NULL DEFAULT 0')
      }
    }
  },
  {
    version: 25,
    description: 'Project Brain — мозг проекта: overview/summaries/context-packs/decisions (+ stubs scoreboard/hive)',
    run: (db: DB) => {
      // Ядро продукта: интеллект живёт в проекте (ключ — project_path), а не в
      // модели. JSON-поля хранятся как TEXT. Все таблицы идемпотентны (IF NOT EXISTS).
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_brain (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL UNIQUE,
          version INTEGER NOT NULL DEFAULT 1,
          overview TEXT,
          architecture_summary TEXT,
          important_files TEXT,        -- json string[]
          entities TEXT,               -- json string[]
          project_rules TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_warmup_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS file_summary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_hash TEXT,
          summary TEXT,
          key_exports TEXT,            -- json string[]
          key_dependencies TEXT,       -- json string[]
          risks TEXT,
          token_estimate INTEGER,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_path, file_path)
        );
        CREATE TABLE IF NOT EXISTS context_pack (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          type TEXT NOT NULL,          -- short | medium | long
          content TEXT NOT NULL,
          token_estimate INTEGER,
          source_files TEXT,           -- json string[]
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_path, type)
        );
        CREATE TABLE IF NOT EXISTS decision_record (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          source_message_id TEXT,
          title TEXT NOT NULL,
          user_request TEXT,
          final_decision TEXT,
          why TEXT,
          key_arguments TEXT,          -- json string[]
          objections TEXT,             -- json string[]
          risks TEXT,                  -- json string[]
          alternatives_rejected TEXT,  -- json string[]
          next_actions TEXT,           -- json string[]
          confidence TEXT,             -- low | medium | high
          revisit_date INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_brain_project ON project_brain(project_path);
        CREATE INDEX IF NOT EXISTS idx_filesum_project ON file_summary(project_path);
        CREATE INDEX IF NOT EXISTS idx_ctxpack_project ON context_pack(project_path);
        CREATE INDEX IF NOT EXISTS idx_decision_project ON decision_record(project_path);
        -- Stubs (Phase будущего): schema без логики. Заложены, чтобы место в
        -- архитектуре было, но MVP их не наполняет.
        CREATE TABLE IF NOT EXISTS model_scoreboard (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          model_id TEXT NOT NULL,
          task_type TEXT,
          success_score REAL,
          cost_score REAL,
          latency_score REAL,
          notes TEXT,
          updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS agency_hive_mind (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          organization_id TEXT,
          source_project_path TEXT,
          decision_record_id INTEGER,
          anonymized_pattern TEXT,
          problem_pattern TEXT,
          solution_pattern TEXT,
          risk_pattern TEXT,
          reuse_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER,
          updated_at INTEGER
        );
      `)
    }
  },
  {
    version: 26,
    description: 'Crash-resume Фаза 2: agent_run_checkpoints — снапшот истории сообщений loop\'а для возобновления с полным контекстом',
    run: (db: DB) => {
      // Один чекпойнт на прогон (run_id PRIMARY KEY) — UPSERT затирает прошлый
      // turn. Хранит сериализованный currentMessages, чтобы прерванная крахом
      // сессия возобновилась с накопленным контекстом, а не с turn 0. Пишется на
      // каждом turn, чистится на чистом завершении — остаётся только у прерванных.
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_run_checkpoints (
          run_id TEXT PRIMARY KEY,
          turn_index INTEGER NOT NULL,
          messages_json TEXT NOT NULL,
          undo_head INTEGER,
          created_at INTEGER NOT NULL
        );
      `)
    }
  },
  {
    version: 27,
    description: 'project reminders: scheduled notifications or chat messages (мёрдж ветки Ильи — перенумеровано после v26, т.к. v24 уже в проде)',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT,
          due_at INTEGER NOT NULL,
          target TEXT NOT NULL CHECK(target IN ('notification','chat')),
          chat_id INTEGER,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','dismissed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          delivered_at INTEGER,
          dismissed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_reminders_project ON reminders(project_path, due_at);
        CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(status, due_at);
      `)
    }
  },
  {
    version: 28,
    description: 'undo_floors: персист защищённых floor\'ов чекпоинтов. Раньше FloorTracker был in-memory → после краха защита терялась и prune съедал пост-чекпоинт записи (ревью Verstak 23.06, finding 1)',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS undo_floors (
          project_path TEXT NOT NULL,
          floor_id INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_undo_floors_project ON undo_floors(project_path);
      `)
    }
  },
  {
    version: 29,
    description: "agent_runs: + статус 'suspended' (#4 ⏸/↻). SQLite не меняет CHECK → пересоздание таблицы с копированием данных и индексов.",
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE agent_runs_new (
          run_id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          chat_id INTEGER,
          owner TEXT NOT NULL DEFAULT 'main' CHECK(owner IN ('main','review','delegate','background')),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('queued','running','waiting_review','done','failed','stopped','suspended')),
          provider_id TEXT, model TEXT, send_id INTEGER,
          agents_count INTEGER NOT NULL DEFAULT 0, tool_count INTEGER NOT NULL DEFAULT 0,
          files_count INTEGER NOT NULL DEFAULT 0, cost_cents INTEGER NOT NULL DEFAULT 0,
          error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
          turn_index INTEGER DEFAULT 0, last_tool_name TEXT, last_checkpoint_id INTEGER,
          agent_mode TEXT, updated_at INTEGER
        );
        INSERT INTO agent_runs_new
          SELECT run_id, project_path, chat_id, owner, title, status, provider_id, model, send_id,
                 agents_count, tool_count, files_count, cost_cents, error, started_at, ended_at,
                 turn_index, last_tool_name, last_checkpoint_id, agent_mode, updated_at
          FROM agent_runs;
        DROP TABLE agent_runs;
        ALTER TABLE agent_runs_new RENAME TO agent_runs;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_path, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(project_path, status);
      `)
    }
  },
  {
    version: 30,
    description: '#5 worktree-lifecycle: таблица worktree_sessions (персистентная изоляция чата в git-worktree, локальный merge/discard).',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS worktree_sessions (
          chat_id INTEGER NOT NULL,
          project_path TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','merged','dismissed')),
          created_at INTEGER NOT NULL,
          ended_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_worktree_sessions_chat ON worktree_sessions(chat_id, state);
        CREATE INDEX IF NOT EXISTS idx_worktree_sessions_project ON worktree_sessions(project_path, state);
      `)
    }
  },
  {
    version: 31,
    description: 'NL-cron: таблица scheduled_tasks (unattended-прогоны по расписанию, исходящий пуш).',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          prompt TEXT NOT NULL,
          cron TEXT NOT NULL,
          human TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          provider_id TEXT,
          model TEXT,
          created_at INTEGER NOT NULL,
          last_run_at INTEGER,
          last_status TEXT CHECK(last_status IN ('ok','error') OR last_status IS NULL),
          last_result TEXT,
          last_run_minute INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);
      `)
    }
  },
  {
    version: 32,
    description: 'Ось 4 #3: soft-invalidate памяти — invalidated_at/superseded_by (история «было X → стало Y», не физическое удаление при суперсессии).',
    run: (db: DB) => {
      // ADD COLUMN не идемпотентен (нет IF NOT EXISTS) — гейтим по table_info, чтобы
      // повторный прогон миграций (тесты / ручной rerun) не падал «duplicate column».
      const cols = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
      const has = (n: string) => cols.some(c => c.name === n)
      if (!has('invalidated_at')) db.exec('ALTER TABLE memories ADD COLUMN invalidated_at INTEGER')
      if (!has('superseded_by')) db.exec('ALTER TABLE memories ADD COLUMN superseded_by TEXT')
      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_invalidated ON memories(project_path, invalidated_at)')
    }
  },
  {
    version: 33,
    description: "agent_runs.status: + 'interrupted' (мёрдж ветки Ильи — runs, восстановленные после закрытия/перезапуска приложения). Перенумеровано после v32; CHECK сохраняет 'suspended'.",
    run: (db: DB) => {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'").get()
      if (!table) return
      const createSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_runs'").get() as { sql?: string } | undefined)?.sql ?? ''
      if (createSql.includes("'interrupted'")) return
      db.exec(`
        ALTER TABLE agent_runs RENAME TO agent_runs_old_33;

        CREATE TABLE agent_runs (
          run_id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          chat_id INTEGER,
          owner TEXT NOT NULL DEFAULT 'main' CHECK(owner IN ('main','review','delegate','background')),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('queued','running','waiting_review','done','failed','stopped','suspended','interrupted')),
          provider_id TEXT, model TEXT, send_id INTEGER,
          agents_count INTEGER NOT NULL DEFAULT 0, tool_count INTEGER NOT NULL DEFAULT 0,
          files_count INTEGER NOT NULL DEFAULT 0, cost_cents INTEGER NOT NULL DEFAULT 0,
          error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
          turn_index INTEGER DEFAULT 0, last_tool_name TEXT, last_checkpoint_id INTEGER,
          agent_mode TEXT, updated_at INTEGER
        );

        INSERT INTO agent_runs (
          run_id, project_path, chat_id, owner, title, status,
          provider_id, model, send_id,
          agents_count, tool_count, files_count, cost_cents,
          error, started_at, ended_at,
          turn_index, last_tool_name, last_checkpoint_id, agent_mode, updated_at
        )
        SELECT
          run_id, project_path, chat_id, owner, title, status,
          provider_id, model, send_id,
          agents_count, tool_count, files_count, cost_cents,
          error, started_at, ended_at,
          COALESCE(turn_index, 0), last_tool_name, last_checkpoint_id, agent_mode, updated_at
        FROM agent_runs_old_33
        ORDER BY rowid ASC;

        DROP TABLE agent_runs_old_33;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_path, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(project_path, status);
      `)
    }
  },
  {
    version: 34,
    description: 'chats_fts: держать индекс в синхроне при обновлении стримящихся assistant-сообщений (мёрдж ветки Ильи — триггер AFTER UPDATE).',
    run: (db: DB) => {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS chats_fts_au AFTER UPDATE OF content ON chats BEGIN
          INSERT INTO chats_fts(chats_fts, rowid, content) VALUES('delete', old.rowid, old.content);
          INSERT INTO chats_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `)
    }
  },
  {
    version: 35,
    description: 'chats.thinking: persist streamed reasoning for crash-resume banners (мёрдж ветки Ильи; на нашей линии колонка уже в базовой схеме — миграция идемпотентный no-op).',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('thinking')) {
        db.exec("ALTER TABLE chats ADD COLUMN thinking TEXT NOT NULL DEFAULT ''")
      }
    }
  },
  {
    version: 36,
    description: 'chats.thinking repair: добить колонку, если предыдущая миграция была помечена применённой без колонки (мёрдж ветки Ильи).',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('thinking')) {
        db.exec("ALTER TABLE chats ADD COLUMN thinking TEXT NOT NULL DEFAULT ''")
      }
    }
  },
  {
    version: 37,
    description: 'chats.applied_skills: metadata for per-message skill attachments shown in UI and used as hidden model context.',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('applied_skills')) {
        db.exec("ALTER TABLE chats ADD COLUMN applied_skills TEXT NOT NULL DEFAULT '[]'")
      }
    }
  },
  {
    version: 38,
    description: 'worktree_sessions lifecycle metadata: snapshot/base refs, activity timestamp, removed marker.',
    run: (db: DB) => {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_sessions'").get()
      if (!table) return

      const cols = (db.prepare('PRAGMA table_info(worktree_sessions)').all() as Array<{ name: string }>).map(c => c.name)
      const has = (name: string): boolean => cols.includes(name)
      if (!has('snapshot_ref')) db.exec('ALTER TABLE worktree_sessions ADD COLUMN snapshot_ref TEXT')
      if (!has('base_ref')) db.exec('ALTER TABLE worktree_sessions ADD COLUMN base_ref TEXT')
      if (!has('last_active_at')) db.exec('ALTER TABLE worktree_sessions ADD COLUMN last_active_at INTEGER')
      if (!has('removed_at')) db.exec('ALTER TABLE worktree_sessions ADD COLUMN removed_at INTEGER')
      db.exec('CREATE INDEX IF NOT EXISTS idx_worktree_sessions_removed ON worktree_sessions(project_path, removed_at)')
    }
  },
  {
    version: 39,
    description: 'agent_runs lifecycle generation for stale-event rejection.',
    run: (db: DB) => {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'").get()
      if (!table) return
      const cols = (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('generation')) {
        db.exec('ALTER TABLE agent_runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_lane_generation ON agent_runs(project_path, chat_id, owner, generation)')
    }
  },
  {
    version: 40,
    description: 'skill_usage governance counters.',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_usage (
          skill_id TEXT PRIMARY KEY,
          use_count INTEGER NOT NULL DEFAULT 0,
          view_count INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER,
          state TEXT NOT NULL DEFAULT 'active',
          pinned INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_skill_usage_state ON skill_usage(state, pinned, last_used_at);
      `)
    }
  },
  {
    version: 41,
    description: "agent_runs.status: + 'timed_out' для runtime watchdog таймаутов.",
    run: (db: DB) => {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'").get()
      if (!table) return
      const createSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_runs'").get() as { sql?: string } | undefined)?.sql ?? ''
      if (createSql.includes("'timed_out'")) return
      db.exec(`
        ALTER TABLE agent_runs RENAME TO agent_runs_old_41;

        CREATE TABLE agent_runs (
          run_id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          chat_id INTEGER,
          owner TEXT NOT NULL DEFAULT 'main' CHECK(owner IN ('main','review','delegate','background')),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('queued','running','waiting_review','done','failed','stopped','timed_out','suspended','interrupted')),
          provider_id TEXT, model TEXT, send_id INTEGER,
          generation INTEGER NOT NULL DEFAULT 0,
          agents_count INTEGER NOT NULL DEFAULT 0, tool_count INTEGER NOT NULL DEFAULT 0,
          files_count INTEGER NOT NULL DEFAULT 0, cost_cents INTEGER NOT NULL DEFAULT 0,
          error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
          turn_index INTEGER DEFAULT 0, last_tool_name TEXT, last_checkpoint_id INTEGER,
          agent_mode TEXT, updated_at INTEGER
        );

        INSERT INTO agent_runs (
          run_id, project_path, chat_id, owner, title, status,
          provider_id, model, send_id, generation,
          agents_count, tool_count, files_count, cost_cents,
          error, started_at, ended_at,
          turn_index, last_tool_name, last_checkpoint_id, agent_mode, updated_at
        )
        SELECT
          run_id, project_path, chat_id, owner, title, status,
          provider_id, model, send_id, COALESCE(generation, 0),
          agents_count, tool_count, files_count, cost_cents,
          error, started_at, ended_at,
          COALESCE(turn_index, 0), last_tool_name, last_checkpoint_id, agent_mode, updated_at
        FROM agent_runs_old_41
        ORDER BY rowid ASC;

        DROP TABLE agent_runs_old_41;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_path, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(project_path, status);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_lane_generation ON agent_runs(project_path, chat_id, owner, generation);
      `)
    }
  },
  {
    version: 42,
    description: 'NL-cron heartbeat and at-most-once claim metadata.',
    run: (db: DB) => {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'").get()
      if (!table) return
      const cols = (db.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>).map(c => c.name)
      const has = (name: string): boolean => cols.includes(name)
      if (!has('last_heartbeat_at')) db.exec('ALTER TABLE scheduled_tasks ADD COLUMN last_heartbeat_at INTEGER')
      if (!has('next_run_at')) db.exec('ALTER TABLE scheduled_tasks ADD COLUMN next_run_at INTEGER')
      db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(enabled, next_run_at)')
    }
  },
  {
    version: 43,
    description: 'scheduler_meta: single-row heartbeat store (M5) — не размазывать last_heartbeat_at по всем задачам; heartbeat виден даже при нуле задач.',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS scheduler_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_heartbeat_at INTEGER
        )
      `)
      db.exec('INSERT OR IGNORE INTO scheduler_meta (id, last_heartbeat_at) VALUES (1, NULL)')
    }
  },
  {
    version: 44,
    description: 'subscription_accounts: мультиаккаунт CLI/подписочных провайдеров (1.9.3). Секреты не в таблице — только cred_ref в SafeStorage.',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS subscription_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_id TEXT NOT NULL,
          label TEXT NOT NULL,
          cred_ref TEXT NOT NULL,
          config_dir TEXT,
          base_url TEXT,
          active INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'ready',
          created_at INTEGER NOT NULL,
          last_used_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_subscription_accounts_provider ON subscription_accounts(provider_id, active);
      `)
    }
  },
  {
    version: 45,
    description: 'subscription_accounts.cooling_until: ETA сброса лимита (1.9.4) — аккаунт «остывает» до этого времени.',
    run: (db: DB) => {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subscription_accounts'").get()
      if (!table) return
      const cols = (db.prepare('PRAGMA table_info(subscription_accounts)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('cooling_until')) db.exec('ALTER TABLE subscription_accounts ADD COLUMN cooling_until INTEGER')
    }
  },
  {
    version: 46,
    description: 'Project settings: notes, labels, accent color, notifications, status.',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('notes')) db.exec("ALTER TABLE projects ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
      if (!cols.includes('accent_color')) db.exec('ALTER TABLE projects ADD COLUMN accent_color TEXT')
      if (!cols.includes('notifications_muted')) db.exec('ALTER TABLE projects ADD COLUMN notifications_muted INTEGER NOT NULL DEFAULT 0')
      if (!cols.includes('status')) db.exec("ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_labels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          color TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_label_members (
          project_path TEXT NOT NULL,
          label_id INTEGER NOT NULL,
          PRIMARY KEY (project_path, label_id),
          FOREIGN KEY (label_id) REFERENCES project_labels(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_project_label_members_project ON project_label_members(project_path);
      `)
    }
  },
  {
    version: 47,
    description: 'projects.created_at: дата создания проекта для сведений в параметрах проекта.',
    run: (db: DB) => {
      const cols = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('created_at')) {
        db.exec('ALTER TABLE projects ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0')
        db.exec('UPDATE projects SET created_at = COALESCE(NULLIF(last_opened_at, 0), strftime(\'%s\', \'now\') * 1000) WHERE created_at = 0')
      }
    }
  },
  {
    version: 48,
    description: '2.0.7-F модель-на-prompt: agent_runs.requested_provider_id / requested_model — что пользователь ЗАПРОСИЛ (route override), отдельно от provider_id/model = что РЕАЛЬНО отработало после fallback. DoD: after-send можно сверить actual vs requested.',
    run: (db: DB) => {
      // agent_runs создаётся более ранней миграцией. В repair-сценарии (частичная БД с
      // высоким schema_version, но без таблицы) ALTER упал бы — гардим существование.
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_runs'").get()
      if (!hasTable) return
      const cols = (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('requested_provider_id')) db.exec('ALTER TABLE agent_runs ADD COLUMN requested_provider_id TEXT')
      if (!cols.includes('requested_model')) db.exec('ALTER TABLE agent_runs ADD COLUMN requested_model TEXT')
    }
  },
  {
    version: 49,
    description: '2.0.8-B подписки: subscription_accounts.cooldown_scope/reason/model (scoped cooldown поверх cooling_until 1.9.4) + chat_sessions.subscription_account_id (nullable binding) / subscription_mode (auto|pinned) — pin per-chat. Append-only, обе таблицы гардим на существование (repair-сценарий).',
    run: (db: DB) => {
      const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
      const colsOf = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name)
      if (has('subscription_accounts')) {
        const c = colsOf('subscription_accounts')
        if (!c.includes('cooldown_scope')) db.exec('ALTER TABLE subscription_accounts ADD COLUMN cooldown_scope TEXT')
        if (!c.includes('cooldown_reason')) db.exec('ALTER TABLE subscription_accounts ADD COLUMN cooldown_reason TEXT')
        if (!c.includes('cooldown_model')) db.exec('ALTER TABLE subscription_accounts ADD COLUMN cooldown_model TEXT')
      }
      if (has('chat_sessions')) {
        const c = colsOf('chat_sessions')
        if (!c.includes('subscription_account_id')) db.exec('ALTER TABLE chat_sessions ADD COLUMN subscription_account_id INTEGER')
        // auto — привязка выбирается автоматически (активный аккаунт); pinned — жёстко закреплён.
        if (!c.includes('subscription_mode')) db.exec("ALTER TABLE chat_sessions ADD COLUMN subscription_mode TEXT NOT NULL DEFAULT 'auto'")
      }
    }
  },
  {
    version: 50,
    description: '2.0.8-F persistence usage: agent_run_usage — по одной строке на терминальный прогон. run_id PRIMARY KEY → INSERT OR IGNORE идемпотентен (повторный finalize / crash-resume-переигровка не создаёт 2-ю строку). Токены nullable (null=«провайдер не сообщил», НЕ 0). pricing_known=0 → цена неизвестна (НЕ $0). cache_diagnostic_code — ТОЛЬКО reason-код (без текста промпта). Append-only.',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_run_usage (
          run_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          transport TEXT,
          account_id INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_write_tokens INTEGER,
          input_accounting TEXT,
          cost_amount REAL,
          currency TEXT,
          pricing_known INTEGER NOT NULL DEFAULT 0,
          cache_diagnostic_code TEXT,
          created_at INTEGER NOT NULL
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_agent_run_usage_created ON agent_run_usage(created_at)')
    }
  },
  {
    version: 51,
    description: '2.0.8-F cache-diagnostic: хеши system-prompt и tools прогона (ТОЛЬКО хеши — текст промпта в БД не попадает, каветат #3). Нужны, чтобы честно ответить «что изменилось против прошлого прогона этого чата» → cache_diagnostic_code (first-request / system-prompt-changed / tools-drift / unknown). Отдельная миграция: 50 уже выпущена, append-only.',
    run: (db: DB) => {
      // ALTER под IF NOT EXISTS в sqlite нет — гардим по факту наличия колонки.
      const cols = db.prepare("SELECT name FROM pragma_table_info('agent_run_usage')").all() as { name: string }[]
      const has = (c: string) => cols.some(x => x.name === c)
      if (!has('system_prompt_hash')) db.exec('ALTER TABLE agent_run_usage ADD COLUMN system_prompt_hash TEXT')
      if (!has('tools_hash')) db.exec('ALTER TABLE agent_run_usage ADD COLUMN tools_hash TEXT')
    }
  },
  {
    version: 52,
    description: '2.0.11-B persistent context snapshot: chat_context_snapshots — сжатый итог истории чата, переживающий рестарт. Append-only ЖУРНАЛ: новый снапшот логически ЗАМЕНЯЕТ активный, но старые строки остаются для аудита и отката (карточка B п.9). Видимые сообщения (chats) не трогаются вообще — компакция влияет только на то, что уходит модели. source_max_message_id — для optimistic concurrency: если чат изменился между чтением и записью, коммит отклоняется (п.5).',
    run: (db: DB) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_context_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          summary TEXT NOT NULL,
          -- До какого сообщения включительно summary покрывает историю.
          through_message_id INTEGER NOT NULL,
          -- Каким был максимальный id сообщений чата в момент ЧТЕНИЯ. Страж гонки:
          -- перед коммитом сверяем заново; разошлось — значит чат пополнился, отказ.
          source_max_message_id INTEGER NOT NULL,
          provider_id TEXT,
          model TEXT,
          estimated_tokens_before INTEGER,
          estimated_tokens_after INTEGER,
          created_at INTEGER NOT NULL
        )
      `)
      // Активный снапшот чата = самый свежий. Индекс под этот запрос.
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_ctx_snap_chat ON chat_context_snapshots(chat_id, id DESC)')
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

function repairSchema(db: DB): void {
  const tableExists = (name: string) => Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  )
  const columns = (table: string) => {
    if (!tableExists(table)) return []
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name)
  }

  const chatCols = columns('chats')
  if (chatCols.length > 0) {
    if (!chatCols.includes('thinking')) {
      db.exec("ALTER TABLE chats ADD COLUMN thinking TEXT NOT NULL DEFAULT ''")
    }
    if (!chatCols.includes('applied_skills')) {
      db.exec("ALTER TABLE chats ADD COLUMN applied_skills TEXT NOT NULL DEFAULT '[]'")
    }
  }

  if (!tableExists('undo_floors')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS undo_floors (
        project_path TEXT NOT NULL,
        floor_id INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_undo_floors_project ON undo_floors(project_path);
    `)
  }
}
