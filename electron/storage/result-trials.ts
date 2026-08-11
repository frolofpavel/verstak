/**
 * P1 (волна 2.6.0): цена ПРИНЯТОГО результата.
 *
 * Одна постановка уходит к нескольким исполнителям (провайдер+модель), человек
 * видит таблицу «что получилось · ходов · минут · рублей» и принимает ОДИН
 * результат. Здесь — хранилище состязания; запуск прогонов и изоляция
 * workspace живут выше (ipc/result-trials.ts, ai/trial-workspace.ts).
 *
 * ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ — денег и ходов. Их не копируем: попытка хранит
 * `run_id`, а цифры читаются из `agent_runs` тем же путём, что кормит разбивку
 * расхода. Скопируй мы их сюда — таблица однажды разошлась бы с «Итого», и
 * человек получил бы два разных ответа на вопрос «сколько стоило». Правило
 * постановки «деньги только настоящие» держится структурой, а не аккуратностью.
 *
 * ПРИНЯТИЕ НЕ ТЕРЯЕТ РАБОТУ: принятая попытка помечается, остальные переходят в
 * 'archived' и остаются со своим workspace и run_id — их diff доступен.
 */
import type { Database } from 'better-sqlite3'

export type TrialStatus = 'running' | 'accepted' | 'cancelled'
export type AttemptStatus = 'pending' | 'running' | 'done' | 'failed' | 'accepted' | 'archived'

export interface NewTrialAttempt {
  providerId: string
  model?: string | null
  /** Изолированный каталог этой попытки. Два исполнителя не делят один. */
  workspace: string
}

export interface TrialAttempt {
  id: number
  trialId: number
  providerId: string
  model: string | null
  workspace: string
  chatId: number | null
  runId: string | null
  status: AttemptStatus
  outcome: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface ResultTrial {
  id: number
  projectPath: string
  parentChatId: number | null
  prompt: string
  status: TrialStatus
  acceptedAttemptId: number | null
  createdAt: number
  updatedAt: number
}

/** Строка таблицы для человека: факт прогона, а не слова модели. */
export interface TrialAttemptSummary extends TrialAttempt {
  /** Ходов модели. null — прогон ещё не начинался/не отчитался. */
  turns: number | null
  /** Вызовов инструментов. */
  toolCount: number | null
  /** Файлов затронуто. */
  filesCount: number | null
  /** Стоимость в центах. null — цена неизвестна (так и пишем, не оцениваем). */
  costCents: number | null
  /** Длительность прогона, мс. null — не завершён. */
  durationMs: number | null
  /** Статус самого прогона из agent_runs. */
  runStatus: string | null
}

export interface ResultTrials {
  create: (input: { projectPath: string; parentChatId?: number | null; prompt: string; attempts: NewTrialAttempt[] }) => ResultTrial
  get: (trialId: number) => ResultTrial | null
  list: (projectPath: string, limit?: number) => ResultTrial[]
  attempts: (trialId: number) => TrialAttempt[]
  /** Таблица для человека: попытки + факт прогона из agent_runs. */
  summary: (trialId: number) => TrialAttemptSummary[]
  bindRun: (attemptId: number, opts: { chatId?: number | null; runId?: string | null; status?: AttemptStatus }) => void
  /** Свежайший run_id чата попытки — из agent_runs (факт, не выдумка). ai:send
   *  генерит runId внутри себя; после старта попытки он снимается ЭТИМ запросом
   *  и привязывается через bindRun. null — прогон не стартовал. */
  latestRunIdForChat: (chatId: number) => string | null
  finishAttempt: (attemptId: number, opts: { status: AttemptStatus; outcome?: string | null; error?: string | null }) => void
  /**
   * Принять одну попытку. Остальные — в архив, НЕ удаляются: их workspace и
   * прогон остаются доступны (правило «принятие не теряет работу»).
   */
  accept: (trialId: number, attemptId: number) => void
}

interface TrialRow {
  id: number
  project_path: string
  parent_chat_id: number | null
  prompt: string
  status: TrialStatus
  accepted_attempt_id: number | null
  created_at: number
  updated_at: number
}

interface AttemptRow {
  id: number
  trial_id: number
  provider_id: string
  model: string | null
  workspace: string
  chat_id: number | null
  run_id: string | null
  status: AttemptStatus
  outcome: string | null
  error: string | null
  created_at: number
  updated_at: number
}

const toTrial = (r: TrialRow): ResultTrial => ({
  id: r.id, projectPath: r.project_path, parentChatId: r.parent_chat_id, prompt: r.prompt,
  status: r.status, acceptedAttemptId: r.accepted_attempt_id, createdAt: r.created_at, updatedAt: r.updated_at,
})

const toAttempt = (r: AttemptRow): TrialAttempt => ({
  id: r.id, trialId: r.trial_id, providerId: r.provider_id, model: r.model, workspace: r.workspace,
  chatId: r.chat_id, runId: r.run_id, status: r.status, outcome: r.outcome, error: r.error,
  createdAt: r.created_at, updatedAt: r.updated_at,
})

export function createResultTrials(db: Database): ResultTrials {
  const touch = (trialId: number, now: number) =>
    db.prepare('UPDATE result_trials SET updated_at = ? WHERE id = ?').run(now, trialId)

  return {
    create: ({ projectPath, parentChatId, prompt, attempts }) => {
      if (!prompt.trim()) throw new Error('состязание: постановка обязательна')
      if (attempts.length < 1) throw new Error('состязание: нужен хотя бы один исполнитель')
      // Изоляция проверяется ЗДЕСЬ, а не в вызывающем: общий каталог у двух
      // исполнителей — это молча перезаписанная работа, и увидеть её потерю
      // человек сможет только постфактум.
      const workspaces = new Set(attempts.map(a => a.workspace))
      if (workspaces.size !== attempts.length) {
        throw new Error('состязание: у каждого исполнителя должен быть СВОЙ workspace — иначе они затрут работу друг друга')
      }
      const now = Date.now()
      const info = db.prepare(
        'INSERT INTO result_trials (project_path, parent_chat_id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectPath, parentChatId ?? null, prompt, 'running', now, now)
      const trialId = Number(info.lastInsertRowid)
      const insert = db.prepare(
        'INSERT INTO result_trial_attempts (trial_id, provider_id, model, workspace, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      for (const a of attempts) insert.run(trialId, a.providerId, a.model ?? null, a.workspace, 'pending', now, now)
      return toTrial(db.prepare('SELECT * FROM result_trials WHERE id = ?').get(trialId) as TrialRow)
    },

    get: (trialId) => {
      const r = db.prepare('SELECT * FROM result_trials WHERE id = ?').get(trialId) as TrialRow | undefined
      return r ? toTrial(r) : null
    },

    list: (projectPath, limit = 20) =>
      (db.prepare('SELECT * FROM result_trials WHERE project_path = ? ORDER BY id DESC LIMIT ?')
        .all(projectPath, Math.max(1, Math.min(limit, 100))) as TrialRow[]).map(toTrial),

    attempts: (trialId) =>
      (db.prepare('SELECT * FROM result_trial_attempts WHERE trial_id = ? ORDER BY id').all(trialId) as AttemptRow[]).map(toAttempt),

    summary: (trialId) => {
      // LEFT JOIN: попытка без прогона (ещё не стартовала или упала до старта)
      // обязана остаться СТРОКОЙ таблицы с честными null, а не исчезнуть — иначе
      // человек не увидит, что исполнитель вообще был.
      const rows = db.prepare(`
        SELECT a.*,
               r.turn_index as turns, r.tool_count as toolCount, r.files_count as filesCount,
               r.cost_cents as costCents, r.status as runStatus,
               r.started_at as startedAt, r.ended_at as endedAt
        FROM result_trial_attempts a
        LEFT JOIN agent_runs r ON r.run_id = a.run_id
        WHERE a.trial_id = ?
        ORDER BY a.id
      `).all(trialId) as Array<AttemptRow & {
        turns: number | null; toolCount: number | null; filesCount: number | null
        costCents: number | null; runStatus: string | null; startedAt: number | null; endedAt: number | null
      }>
      return rows.map(r => ({
        ...toAttempt(r),
        turns: r.turns ?? null,
        toolCount: r.toolCount ?? null,
        filesCount: r.filesCount ?? null,
        costCents: r.costCents ?? null,
        runStatus: r.runStatus ?? null,
        durationMs: r.startedAt != null && r.endedAt != null ? r.endedAt - r.startedAt : null,
      }))
    },

    latestRunIdForChat: (chatId) => {
      const row = db.prepare('SELECT run_id as runId FROM agent_runs WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(chatId) as { runId: string } | undefined
      return row?.runId ?? null
    },

    bindRun: (attemptId, opts) => {
      const now = Date.now()
      const sets: string[] = []
      const vals: unknown[] = []
      if (opts.chatId !== undefined) { sets.push('chat_id = ?'); vals.push(opts.chatId) }
      if (opts.runId !== undefined) { sets.push('run_id = ?'); vals.push(opts.runId) }
      if (opts.status !== undefined) { sets.push('status = ?'); vals.push(opts.status) }
      if (sets.length === 0) return
      sets.push('updated_at = ?'); vals.push(now)
      db.prepare(`UPDATE result_trial_attempts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, attemptId)
      const row = db.prepare('SELECT trial_id FROM result_trial_attempts WHERE id = ?').get(attemptId) as { trial_id: number } | undefined
      if (row) touch(row.trial_id, now)
    },

    finishAttempt: (attemptId, opts) => {
      const now = Date.now()
      db.prepare('UPDATE result_trial_attempts SET status = ?, outcome = ?, error = ?, updated_at = ? WHERE id = ?')
        .run(opts.status, opts.outcome ?? null, opts.error ?? null, now, attemptId)
      const row = db.prepare('SELECT trial_id FROM result_trial_attempts WHERE id = ?').get(attemptId) as { trial_id: number } | undefined
      if (row) touch(row.trial_id, now)
    },

    accept: (trialId, attemptId) => {
      const attempt = db.prepare('SELECT * FROM result_trial_attempts WHERE id = ? AND trial_id = ?')
        .get(attemptId, trialId) as AttemptRow | undefined
      if (!attempt) throw new Error('состязание: попытка не найдена в этом состязании')
      const now = Date.now()
      // Остальные — В АРХИВ, не в удаление: workspace и run_id остаются на месте,
      // значит diff отклонённой работы по-прежнему можно посмотреть.
      db.prepare("UPDATE result_trial_attempts SET status = 'archived', updated_at = ? WHERE trial_id = ? AND id != ?")
        .run(now, trialId, attemptId)
      db.prepare("UPDATE result_trial_attempts SET status = 'accepted', updated_at = ? WHERE id = ?").run(now, attemptId)
      db.prepare("UPDATE result_trials SET status = 'accepted', accepted_attempt_id = ?, updated_at = ? WHERE id = ?")
        .run(attemptId, now, trialId)
    },
  }
}
