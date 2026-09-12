// browser-tasks.ts — durable Browser Employee state (EXT-B0, BR-013..BR-017).
//
// Источник истины для одного браузерного поручения: stable browserTaskId,
// ordered run lineage, durable action ledger, redacted Proof refs.
// Переживает restart, Pause/Resume, смену провайдера (BR-015, BR-016).
//
// Принципы (из BROWSER_EMPLOYEE_PLAN.md §4.1, §4.4, §9 Phase B0):
//   • Ни один browser action не повторяется автоматически после uncertain.
//   • Approval одноразовое, атомарно потребляется ДО executor (BR-017).
//   • Status executing после crash → uncertain при reconcileStaleActions() на
//     старте приложения. Автоповтор запрещён — только свежий observe решает, что
//     делать дальше.
//   • run lineage append-only: каждый запуск модели (run_id) получает свой ord.
//   • НИКАКИХ raw cookie/token/session — только redacted refs (BR-016).

import type { Database as DB } from 'better-sqlite3'

// ── Типы (mirror SQL-схемы миграции v54) ─────────────────────────────────────

export type BrowserMode = 'watch' | 'prepare' | 'execute'
export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4'
export type ActionStatus =
  | 'proposed'      // предложен (preconditions вычислены, digest готов)
  | 'approved'      // Pavодобрил, но approval ещё не потреблен
  | 'executing'     // выполняется (executor запущен)
  | 'verified'      // выполнено и readback подтвердил ожидаемый postcondition
  | 'uncertain'     // выполнялось, но результат неизвестен (crash, timeout)
  | 'failed'        // выполнено, но результат не соответствует ожиданию или ошибка
  | 'blocked'       // остановлен policy/circuit-breaker (403/429/CAPTCHA и т.п.)
  | 'rejected'      // approval отклонён пользователем
  | 'cancelled'     // остановлен Stop/Pause/abort

export type HandoffReason = 'new_send' | 'pause_resume' | 'provider_switch' | 'forced'

export interface BrowserTaskRow {
  browserTaskId: string
  projectPath: string
  chatId: number | null
  clientId: string | null
  currentRunId: string | null
  browserMode: BrowserMode
  observationVersion: number
  observationId: string | null
  taskTabRef: string | null
  allowedDomains: string[]
  caps: Record<string, unknown>
  dataPolicy: Record<string, unknown>
  lastResultStatus: string | null
  lastResultDetail: string | null
  createdAt: number
  updatedAt: number
  endedAt: number | null
}

export interface BrowserTaskRunRow {
  id: number
  browserTaskId: string
  runId: string
  providerId: string | null
  model: string | null
  ord: number
  handoffReason: HandoffReason
  startedAt: number
  endedAt: number | null
}

export interface BrowserActionRow {
  actionId: string
  browserTaskId: string
  runId: string
  attempt: number
  actionType: string
  riskLevel: RiskLevel
  scope: Record<string, unknown>
  payload: Record<string, unknown>
  preconditions: Record<string, unknown>
  expectedPostcondition: Record<string, unknown> | null
  approvalDigest: string | null
  approvalConsumedAt: number | null
  /** EXT-B0-R1: TTL approval. null = без TTL (legacy/нет approval). */
  approvalExpiresAt: number | null
  status: ActionStatus
  attemptId: string | null
  resultStatus: string | null
  resultDetail: string | null
  createdAt: number
  updatedAt: number
  finalizedAt: number | null
}

export interface BrowserActionEventRow {
  id: number
  actionId: string
  fromStatus: ActionStatus | null
  toStatus: ActionStatus
  reason: string | null
  detailJson: string | null
  createdAt: number
}

export interface BrowserProofRefRow {
  id: number
  actionId: string | null
  browserTaskId: string
  runId: string | null
  kind: 'before' | 'after' | 'observe' | 'action'
  artifactPath: string | null
  artifactDigest: string | null
  origin: string | null
  url: string | null
  redactedSummary: string | null
  omissions: string[]
  retentionUntil: number | null
  createdAt: number
}

export interface CreateTaskInput {
  browserTaskId: string
  projectPath: string
  chatId?: number | null
  clientId?: string | null
  runId?: string | null
  providerId?: string | null
  model?: string | null
  browserMode?: BrowserMode
  allowedDomains?: string[]
  caps?: Record<string, unknown>
  dataPolicy?: Record<string, unknown>
  taskTabRef?: string | null
}

export interface AppendRunInput {
  browserTaskId: string
  runId: string
  providerId?: string | null
  model?: string | null
  handoffReason?: HandoffReason
}

export interface ProposeActionInput {
  actionId: string
  browserTaskId: string
  runId: string
  actionType: string
  riskLevel: RiskLevel
  scope?: Record<string, unknown>
  payload?: Record<string, unknown>
  preconditions?: Record<string, unknown>
  expectedPostcondition?: Record<string, unknown> | null
  approvalDigest?: string | null
  /** EXT-B0-R1 (BR-017): момент истечения approval (ms epoch). После него
   *  consumeApproval отклоняет proposed/approved action. Controller ставит TTL
   *  только для R3 actions (требующих approval). */
  approvalExpiresAt?: number | null
}

export interface FinalizeActionInput {
  resultStatus: string
  resultDetail?: string | null
  attemptId?: string | null
}

const DETAIL_CAP = 1000

// ── Factory: createBrowserTasks(db) ──────────────────────────────────────────
// Pattern зеркалит agent-runs.ts: factory возвращает объект с методами; методы
// инкапсулируют prepared statements и гарантии идемпотентности.

export interface BrowserTasks {
  // task lifecycle
  create(input: CreateTaskInput): BrowserTaskRow
  get(browserTaskId: string): BrowserTaskRow | null
  listByProject(projectPath: string, opts?: { activeOnly?: boolean; limit?: number }): BrowserTaskRow[]
  listByChat(chatId: number): BrowserTaskRow[]
  updateBrowserMode(browserTaskId: string, mode: BrowserMode): void
  updateObservation(browserTaskId: string, observationId: string, newVersion: number): void
  updateLastResult(browserTaskId: string, status: string, detail?: string | null): void
  setTaskTab(browserTaskId: string, tabRef: string | null): void
  setAllowedDomains(browserTaskId: string, domains: string[]): void
  setCaps(browserTaskId: string, caps: Record<string, unknown>): void
  setDataPolicy(browserTaskId: string, policy: Record<string, unknown>): void
  endTask(browserTaskId: string): void

  // run lineage (BR-015)
  appendRun(input: AppendRunInput): BrowserTaskRunRow
  currentRun(browserTaskId: string): BrowserTaskRunRow | null
  lineage(browserTaskId: string): BrowserTaskRunRow[]
  handoffTo(input: AppendRunInput): BrowserTaskRunRow

  // action ledger (BR-013)
  proposeAction(input: ProposeActionInput): BrowserActionRow
  getAction(actionId: string): BrowserActionRow | null
  listActions(browserTaskId: string, opts?: { status?: ActionStatus }): BrowserActionRow[]
  approveAction(actionId: string, approvalDigest: string): boolean
  /** Атомарно потребляет approval: перевод proposed/approved → executing и
   *  фиксирует approval_consumed_at. Возвращает false если действие уже не в
   *  consumable состоянии (consumed/rejected/cancelled/выполняется). */
  consumeApproval(actionId: string, expectedApprovalDigest: string): boolean
  finalizeAction(actionId: string, status: 'verified' | 'uncertain' | 'failed' | 'blocked', input?: FinalizeActionInput): void
  rejectAction(actionId: string, reason?: string): void
  cancelAction(actionId: string, reason?: string): void
  startExecute(actionId: string, attemptId: string): void
  actionEvents(actionId: string): BrowserActionEventRow[]

  // proof refs (BR-016)
  appendProofRef(ref: Omit<BrowserProofRefRow, 'id' | 'createdAt'>): number
  listProofRefs(browserTaskId: string): BrowserProofRefRow[]

  // crash recovery (BR-013)
  /** На старте приложения: все action со status='executing' → 'uncertain'.
   *  Возвращает количество затронутых строк. Это ядро защиты от повторного
   *  submit после crash: action, который «выполнялся» когда процесс упал,
   *  считается uncertain — повторный dispatch запрещён, нужен свежий observe. */
  reconcileStaleActions(): number

  // purge (retention, best-effort)
  purgeExpiredProofRefs(now?: number): number
}

// ── serialization helpers ────────────────────────────────────────────────────

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch { return [] }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {}
  } catch { return {} }
}

function mapTaskRow(r: Record<string, unknown> | undefined): BrowserTaskRow | null {
  if (!r) return null
  return {
    browserTaskId: String(r.browser_task_id ?? ''),
    projectPath: String(r.project_path ?? ''),
    chatId: r.chat_id == null ? null : Number(r.chat_id),
    clientId: r.client_id == null ? null : String(r.client_id),
    currentRunId: r.current_run_id == null ? null : String(r.current_run_id),
    browserMode: (r.browser_mode === 'prepare' || r.browser_mode === 'execute') ? r.browser_mode : 'watch',
    observationVersion: Number(r.observation_version ?? 0),
    observationId: r.observation_id == null ? null : String(r.observation_id),
    taskTabRef: r.task_tab_ref == null ? null : String(r.task_tab_ref),
    allowedDomains: parseJsonArray(r.allowed_domains_json as string | null),
    caps: parseJsonObject(r.caps_json as string | null),
    dataPolicy: parseJsonObject(r.data_policy_json as string | null),
    lastResultStatus: r.last_result_status == null ? null : String(r.last_result_status),
    lastResultDetail: r.last_result_detail == null ? null : String(r.last_result_detail),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
  }
}

function mapRunRow(r: Record<string, unknown> | undefined): BrowserTaskRunRow | null {
  if (!r) return null
  return {
    id: Number(r.id ?? 0),
    browserTaskId: String(r.browser_task_id ?? ''),
    runId: String(r.run_id ?? ''),
    providerId: r.provider_id == null ? null : String(r.provider_id),
    model: r.model == null ? null : String(r.model),
    ord: Number(r.ord ?? 0),
    handoffReason: ((): HandoffReason => {
      const v = String(r.handoff_reason ?? 'new_send')
      return v === 'pause_resume' || v === 'provider_switch' || v === 'forced' ? v : 'new_send'
    })(),
    startedAt: Number(r.started_at ?? 0),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
  }
}

function mapActionRow(r: Record<string, unknown> | undefined): BrowserActionRow | null {
  if (!r) return null
  return {
    actionId: String(r.action_id ?? ''),
    browserTaskId: String(r.browser_task_id ?? ''),
    runId: String(r.run_id ?? ''),
    attempt: Number(r.attempt ?? 1),
    actionType: String(r.action_type ?? ''),
    riskLevel: ((): RiskLevel => {
      const v = String(r.risk_level ?? 'R3')
      return ['R0', 'R1', 'R2', 'R3', 'R4'].includes(v) ? v as RiskLevel : 'R3'
    })(),
    scope: parseJsonObject(r.scope_json as string | null),
    payload: parseJsonObject(r.payload_json as string | null),
    preconditions: parseJsonObject(r.preconditions_json as string | null),
    expectedPostcondition: r.expected_postcondition_json == null ? null : parseJsonObject(r.expected_postcondition_json as string | null),
    approvalDigest: r.approval_digest == null ? null : String(r.approval_digest),
    approvalConsumedAt: r.approval_consumed_at == null ? null : Number(r.approval_consumed_at),
    approvalExpiresAt: r.approval_expires_at == null ? null : Number(r.approval_expires_at),
    status: ((): ActionStatus => {
      const v = String(r.status ?? 'proposed')
      const allowed: ActionStatus[] = ['proposed', 'approved', 'executing', 'verified', 'uncertain', 'failed', 'blocked', 'rejected', 'cancelled']
      return allowed.includes(v as ActionStatus) ? v as ActionStatus : 'proposed'
    })(),
    attemptId: r.attempt_id == null ? null : String(r.attempt_id),
    resultStatus: r.result_status == null ? null : String(r.result_status),
    resultDetail: r.result_detail == null ? null : String(r.result_detail),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    finalizedAt: r.finalized_at == null ? null : Number(r.finalized_at),
  }
}

function mapProofRow(r: Record<string, unknown> | undefined): BrowserProofRefRow | null {
  if (!r) return null
  const kind = String(r.kind ?? 'observe')
  const allowed: BrowserProofRefRow['kind'][] = ['before', 'after', 'observe', 'action']
  return {
    id: Number(r.id ?? 0),
    actionId: r.action_id == null ? null : String(r.action_id),
    browserTaskId: String(r.browser_task_id ?? ''),
    runId: r.run_id == null ? null : String(r.run_id),
    kind: allowed.includes(kind as BrowserProofRefRow['kind']) ? kind as BrowserProofRefRow['kind'] : 'observe',
    artifactPath: r.artifact_path == null ? null : String(r.artifact_path),
    artifactDigest: r.artifact_digest == null ? null : String(r.artifact_digest),
    origin: r.origin == null ? null : String(r.origin),
    url: r.url == null ? null : String(r.url),
    redactedSummary: r.redacted_summary == null ? null : String(r.redacted_summary),
    omissions: parseJsonArray(r.omissions_json as string | null),
    retentionUntil: r.retention_until == null ? null : Number(r.retention_until),
    createdAt: Number(r.created_at ?? 0),
  }
}

function mapEventRow(r: Record<string, unknown>): BrowserActionEventRow {
  return {
    id: Number(r.id ?? 0),
    actionId: String(r.action_id ?? ''),
    fromStatus: r.from_status == null ? null : String(r.from_status) as ActionStatus,
    toStatus: String(r.to_status ?? 'proposed') as ActionStatus,
    reason: r.reason == null ? null : String(r.reason),
    detailJson: r.detail_json == null ? null : String(r.detail_json),
    createdAt: Number(r.created_at ?? 0),
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createBrowserTasks(db: DB): BrowserTasks {
  // ── Task lifecycle ──────────────────────────────────────────────────────
  function logActionEvent(actionId: string, fromStatus: ActionStatus | null, toStatus: ActionStatus, reason?: string | null, detail?: Record<string, unknown> | null): void {
    db.prepare(
      `INSERT INTO browser_action_events (action_id, from_status, to_status, reason, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      actionId,
      fromStatus,
      toStatus,
      reason ?? null,
      detail ? JSON.stringify(detail).slice(0, DETAIL_CAP) : null,
      Date.now()
    )
  }

  return {
    create(input) {
      const now = Date.now()
      db.prepare(
        `INSERT INTO browser_tasks
          (browser_task_id, project_path, chat_id, client_id, current_run_id, browser_mode,
           observation_version, observation_id, task_tab_ref,
           allowed_domains_json, caps_json, data_policy_json,
           last_result_status, last_result_detail, created_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`
      ).run(
        input.browserTaskId,
        input.projectPath,
        input.chatId ?? null,
        input.clientId ?? null,
        input.runId ?? null,
        input.browserMode ?? 'watch',
        0,
        null,
        input.taskTabRef ?? null,
        JSON.stringify(input.allowedDomains ?? []),
        JSON.stringify(input.caps ?? {}),
        JSON.stringify(input.dataPolicy ?? {}),
        now,
        now
      )
      // Первый run в lineage — если передан.
      if (input.runId) {
        db.prepare(
          `INSERT INTO browser_task_runs (browser_task_id, run_id, provider_id, model, ord, handoff_reason, started_at)
           VALUES (?, ?, ?, ?, 0, 'new_send', ?)`
        ).run(input.browserTaskId, input.runId, input.providerId ?? null, input.model ?? null, now)
      }
      const row = db.prepare(`SELECT * FROM browser_tasks WHERE browser_task_id = ?`).get(input.browserTaskId)
      return mapTaskRow(row as Record<string, unknown>)!
    },

    get(browserTaskId) {
      const row = db.prepare(`SELECT * FROM browser_tasks WHERE browser_task_id = ?`).get(browserTaskId)
      return mapTaskRow(row as Record<string, unknown> | undefined)
    },

    listByProject(projectPath, opts) {
      const limit = opts?.limit ?? 100
      if (opts?.activeOnly) {
        const rows = db.prepare(
          `SELECT * FROM browser_tasks WHERE project_path = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT ?`
        ).all(projectPath, limit) as Record<string, unknown>[]
        return rows.map(r => mapTaskRow(r)!)
      }
      const rows = db.prepare(
        `SELECT * FROM browser_tasks WHERE project_path = ? ORDER BY created_at DESC LIMIT ?`
      ).all(projectPath, limit) as Record<string, unknown>[]
      return rows.map(r => mapTaskRow(r)!)
    },

    listByChat(chatId) {
      const rows = db.prepare(
        `SELECT * FROM browser_tasks WHERE chat_id = ? ORDER BY created_at DESC`
      ).all(chatId) as Record<string, unknown>[]
      return rows.map(r => mapTaskRow(r)!)
    },

    updateBrowserMode(browserTaskId, mode) {
      db.prepare(`UPDATE browser_tasks SET browser_mode = ?, updated_at = ? WHERE browser_task_id = ?`)
        .run(mode, Date.now(), browserTaskId)
    },

    updateObservation(browserTaskId, observationId, newVersion) {
      db.prepare(
        `UPDATE browser_tasks SET observation_id = ?, observation_version = ?, updated_at = ? WHERE browser_task_id = ?`
      ).run(observationId, newVersion, Date.now(), browserTaskId)
    },

    updateLastResult(browserTaskId, status, detail) {
      db.prepare(
        `UPDATE browser_tasks SET last_result_status = ?, last_result_detail = ?, updated_at = ? WHERE browser_task_id = ?`
      ).run(status, detail ?? null, Date.now(), browserTaskId)
    },

    setTaskTab(browserTaskId, tabRef) {
      db.prepare(`UPDATE browser_tasks SET task_tab_ref = ?, updated_at = ? WHERE browser_task_id = ?`)
        .run(tabRef, Date.now(), browserTaskId)
    },

    setAllowedDomains(browserTaskId, domains) {
      db.prepare(`UPDATE browser_tasks SET allowed_domains_json = ?, updated_at = ? WHERE browser_task_id = ?`)
        .run(JSON.stringify(domains), Date.now(), browserTaskId)
    },

    setCaps(browserTaskId, caps) {
      db.prepare(`UPDATE browser_tasks SET caps_json = ?, updated_at = ? WHERE browser_task_id = ?`)
        .run(JSON.stringify(caps), Date.now(), browserTaskId)
    },

    setDataPolicy(browserTaskId, policy) {
      db.prepare(`UPDATE browser_tasks SET data_policy_json = ?, updated_at = ? WHERE browser_task_id = ?`)
        .run(JSON.stringify(policy), Date.now(), browserTaskId)
    },

    endTask(browserTaskId) {
      db.prepare(`UPDATE browser_tasks SET ended_at = ?, updated_at = ? WHERE browser_task_id = ? AND ended_at IS NULL`)
        .run(Date.now(), Date.now(), browserTaskId)
    },

    // ── Run lineage ──────────────────────────────────────────────────────
    appendRun(input) {
      const now = Date.now()
      // Atomic: 3 операции (close prev run, INSERT new run, flip current_run_id)
      // в одной транзакции. Если процесс упал между ними — состояние не рассин-
      // хронизировано (current_run_id не указывает на «зомби» run).
      // ВАЖНО: повторный append того же run_id не должен закрывать активный run
      // (см. R1 контракт «повторный runId не закрывает активный run»).
      // Поэтому: сначала проверяем, есть ли уже такой run_id в lineage.
      const existing = db.prepare(
        `SELECT run_id FROM browser_task_runs WHERE browser_task_id = ? AND run_id = ?`
      ).get(input.browserTaskId, input.runId) as { run_id: string } | undefined

      const tx = db.transaction(() => {
        if (existing) {
          // Идемпотентный append: run уже в lineage. НЕ закрываем активный run,
          // НЕ добавляем новый — просто обновляем current_run_id (он уже должен
          // указывать на этот run, но для надёжности обновим).
          db.prepare(`UPDATE browser_tasks SET current_run_id = ?, updated_at = ? WHERE browser_task_id = ?`)
            .run(input.runId, now, input.browserTaskId)
          return
        }
        const maxOrdRow = db.prepare(
          `SELECT MAX(ord) as maxOrd FROM browser_task_runs WHERE browser_task_id = ?`
        ).get(input.browserTaskId) as { maxOrd: number | null } | undefined
        const nextOrd = (maxOrdRow?.maxOrd == null ? -1 : maxOrdRow.maxOrd) + 1
        // Завершаем предыдущий run — добавление нового логически означает
        // что старый закончил свою работу.
        db.prepare(
          `UPDATE browser_task_runs SET ended_at = ? WHERE browser_task_id = ? AND ended_at IS NULL`
        ).run(now, input.browserTaskId)
        db.prepare(
          `INSERT INTO browser_task_runs
            (browser_task_id, run_id, provider_id, model, ord, handoff_reason, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          input.browserTaskId,
          input.runId,
          input.providerId ?? null,
          input.model ?? null,
          nextOrd,
          input.handoffReason ?? 'new_send',
          now
        )
        // current_run_id — голова lineage — указывает на самый свежий run.
        db.prepare(`UPDATE browser_tasks SET current_run_id = ?, updated_at = ? WHERE browser_task_id = ?`)
          .run(input.runId, now, input.browserTaskId)
      })
      tx()
      const row = db.prepare(
        `SELECT * FROM browser_task_runs WHERE browser_task_id = ? AND run_id = ?`
      ).get(input.browserTaskId, input.runId) as Record<string, unknown> | undefined
      return mapRunRow(row)!
    },

    currentRun(browserTaskId) {
      const row = db.prepare(
        `SELECT * FROM browser_task_runs WHERE browser_task_id = ?
         ORDER BY ord DESC LIMIT 1`
      ).get(browserTaskId) as Record<string, unknown> | undefined
      return mapRunRow(row)
    },

    lineage(browserTaskId) {
      const rows = db.prepare(
        `SELECT * FROM browser_task_runs WHERE browser_task_id = ? ORDER BY ord ASC`
      ).all(browserTaskId) as Record<string, unknown>[]
      return rows.map(r => mapRunRow(r)!)
    },

    handoffTo(input) {
      // handoff = appendRun с явным handoffReason;поверхностно это alias, но
      // даёт явную семантику в коде вызывающих сайтов (failover, resume).
      return this.appendRun({
        browserTaskId: input.browserTaskId,
        runId: input.runId,
        providerId: input.providerId,
        model: input.model,
        handoffReason: input.handoffReason ?? 'provider_switch',
      })
    },

    // ── Action ledger ────────────────────────────────────────────────────
    proposeAction(input) {
      const now = Date.now()
      // Atomic: INSERT row + log event в одной транзакции. Если INSERT упал —
      // event не пишется (трейл не оторван от строки); если event падает — INSERT
      // откатывается (нет «висящей» proposed-строки без аудита).
      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO browser_actions
            (action_id, browser_task_id, run_id, attempt, action_type, risk_level,
             scope_json, payload_json, preconditions_json, expected_postcondition_json,
             approval_digest, approval_consumed_at, approval_expires_at, status, attempt_id,
             result_status, result_detail, created_at, updated_at, finalized_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'proposed', NULL, NULL, NULL, ?, ?, NULL)`
        ).run(
          input.actionId,
          input.browserTaskId,
          input.runId,
          input.actionType,
          input.riskLevel,
          JSON.stringify(input.scope ?? {}),
          JSON.stringify(input.payload ?? {}),
          JSON.stringify(input.preconditions ?? {}),
          input.expectedPostcondition ? JSON.stringify(input.expectedPostcondition) : null,
          input.approvalDigest ?? null,
          input.approvalExpiresAt ?? null,
          now,
          now
        )
        logActionEvent(input.actionId, null, 'proposed', 'proposed', null)
      })
      tx()
      const row = db.prepare(`SELECT * FROM browser_actions WHERE action_id = ?`).get(input.actionId)
      return mapActionRow(row as Record<string, unknown>)!
    },

    getAction(actionId) {
      const row = db.prepare(`SELECT * FROM browser_actions WHERE action_id = ?`).get(actionId)
      return mapActionRow(row as Record<string, unknown> | undefined)
    },

    listActions(browserTaskId, opts) {
      let sql = `SELECT * FROM browser_actions WHERE browser_task_id = ?`
      const vals: unknown[] = [browserTaskId]
      if (opts?.status) { sql += ` AND status = ?`; vals.push(opts.status) }
      sql += ` ORDER BY created_at ASC`
      const rows = db.prepare(sql).all(...vals) as Record<string, unknown>[]
      return rows.map(r => mapActionRow(r)!)
    },

    approveAction(actionId, approvalDigest) {
      const cur = this.getAction(actionId)
      if (!cur) return false
      // Одобрить можно только из proposed (approved/executing/verified/... — нет).
      if (cur.status !== 'proposed') return false
      // EXT-B0-R1 TTL: нельзя одобрить уже просроченное.
      if (cur.approvalExpiresAt != null && Date.now() > cur.approvalExpiresAt) return false
      const now = Date.now()
      // Atomic: UPDATE + logEvent в одной транзакции.
      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE browser_actions SET approval_digest = ?, status = 'approved', updated_at = ?
           WHERE action_id = ? AND status = 'proposed'`
        ).run(approvalDigest, now, actionId)
        if (res.changes === 0) throw new Error('approve-noop')
        logActionEvent(actionId, 'proposed', 'approved', 'user_approved', null)
      })
      try { tx() } catch { return false }
      return true
    },

    consumeApproval(actionId, expectedApprovalDigest) {
      const cur = this.getAction(actionId)
      if (!cur) return false
      // Атомарный consume: только approved с непустым digest, digest должен
      // совпадать. После consume нельзя повторно «проголосовать».
      if (cur.status !== 'approved') return false
      if (!cur.approvalDigest) return false
      if (cur.approvalDigest !== expectedApprovalDigest) return false
      // EXT-B0-R1 TTL: просроченное approval нельзя потребить.
      if (cur.approvalExpiresAt != null && Date.now() > cur.approvalExpiresAt) return false
      const now = Date.now()
      // Atomic: UPDATE + logEvent. Если UPDATE выбил 0 rows (кто-то успел
      // изменить статус между getAction и UPDATE) — бросаем, транзакция
      // откатывается, logEvent не пишется.
      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE browser_actions
           SET status = 'executing', approval_consumed_at = ?, attempt_id = COALESCE(attempt_id, ?), updated_at = ?
           WHERE action_id = ? AND status = 'approved'`
        ).run(now, `${actionId}-${now}`, now, actionId)
        if (res.changes === 0) throw new Error('consume-noop')
        logActionEvent(actionId, 'approved', 'executing', 'consumed', null)
      })
      try { tx() } catch { return false }
      return true
    },

    startExecute(actionId, attemptId) {
      // Для R0/R1 действий (auto-accept, нет approval) — явный переход в executing.
      const cur = this.getAction(actionId)
      if (!cur) return
      if (cur.status !== 'proposed' && cur.status !== 'approved') return
      const fromStatus = cur.status
      const now = Date.now()
      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE browser_actions SET status = 'executing', attempt_id = ?, updated_at = ?
           WHERE action_id = ? AND status IN ('proposed','approved')`
        ).run(attemptId, now, actionId)
        if (res.changes === 0) throw new Error('start-noop')
        logActionEvent(actionId, fromStatus, 'executing', 'started', null)
      })
      try { tx() } catch { /* race — кто-то уже перевел */ }
    },

    finalizeAction(actionId, status, input) {
      const cur = this.getAction(actionId)
      if (!cur) return
      // Финал идемпотентен: повторный finalize по уже финализированному — no-op.
      if (cur.status === 'verified' || cur.status === 'uncertain' || cur.status === 'failed'
          || cur.status === 'blocked' || cur.status === 'rejected' || cur.status === 'cancelled') {
        return
      }
      const fromStatus = cur.status
      const now = Date.now()
      const detail = input?.resultDetail ? input.resultDetail.slice(0, DETAIL_CAP) : null
      // Atomic: UPDATE + logEvent. WHERE finalized_at IS NULL — идемпотентность.
      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE browser_actions
           SET status = ?, result_status = ?, result_detail = ?, attempt_id = COALESCE(attempt_id, ?),
               updated_at = ?, finalized_at = ?
           WHERE action_id = ? AND finalized_at IS NULL`
        ).run(
          status,
          input?.resultStatus ?? null,
          detail,
          input?.attemptId ?? null,
          now,
          now,
          actionId
        )
        if (res.changes === 0) throw new Error('finalize-noop')
        logActionEvent(actionId, fromStatus, status, 'finalized', input ? { resultStatus: input.resultStatus } : null)
      })
      try { tx() } catch { /* race — кто-то финализировал раньше */ }
    },

    rejectAction(actionId, reason) {
      const cur = this.getAction(actionId)
      if (!cur) return
      if (cur.status === 'rejected' || cur.status === 'cancelled'
          || cur.status === 'verified' || cur.status === 'failed'
          || cur.status === 'uncertain' || cur.status === 'blocked') return
      const fromStatus = cur.status
      const now = Date.now()
      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE browser_actions SET status = 'rejected', updated_at = ?, finalized_at = ?
           WHERE action_id = ? AND finalized_at IS NULL`
        ).run(now, now, actionId)
        if (res.changes === 0) throw new Error('reject-noop')
        logActionEvent(actionId, fromStatus, 'rejected', reason ?? 'rejected', null)
      })
      try { tx() } catch { /* race */ }
    },

    cancelAction(actionId, reason) {
      const cur = this.getAction(actionId)
      if (!cur) return
      if (cur.status === 'verified' || cur.status === 'uncertain'
          || cur.status === 'failed' || cur.status === 'rejected'
          || cur.status === 'blocked' || cur.status === 'cancelled') return
      const fromStatus = cur.status
      const now = Date.now()
      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE browser_actions SET status = 'cancelled', updated_at = ?, finalized_at = ?
           WHERE action_id = ? AND finalized_at IS NULL`
        ).run(now, now, actionId)
        if (res.changes === 0) throw new Error('cancel-noop')
        logActionEvent(actionId, fromStatus, 'cancelled', reason ?? 'cancelled', null)
      })
      try { tx() } catch { /* race */ }
    },

    actionEvents(actionId) {
      const rows = db.prepare(
        `SELECT * FROM browser_action_events WHERE action_id = ? ORDER BY id ASC`
      ).all(actionId) as Record<string, unknown>[]
      return rows.map(mapEventRow)
    },

    // ── Proof refs ───────────────────────────────────────────────────────
    appendProofRef(ref) {
      const now = Date.now()
      const res = db.prepare(
        `INSERT INTO browser_proof_refs
          (action_id, browser_task_id, run_id, kind, artifact_path, artifact_digest,
           origin, url, redacted_summary, omissions_json, retention_until, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ref.actionId ?? null,
        ref.browserTaskId,
        ref.runId ?? null,
        ref.kind,
        ref.artifactPath ?? null,
        ref.artifactDigest ?? null,
        ref.origin ?? null,
        ref.url ?? null,
        ref.redactedSummary ?? null,
        JSON.stringify(ref.omissions ?? []),
        ref.retentionUntil ?? null,
        now
      )
      return Number(res.lastInsertRowid)
    },

    listProofRefs(browserTaskId) {
      const rows = db.prepare(
        `SELECT * FROM browser_proof_refs WHERE browser_task_id = ? ORDER BY created_at ASC`
      ).all(browserTaskId) as Record<string, unknown>[]
      return rows.map(r => mapProofRow(r)!)
    },

    // ── Crash recovery ───────────────────────────────────────────────────
    reconcileStaleActions() {
      // Два класса stale actions на старте:
      //   1. executing → uncertain (crash во время execute; автоповтор запрещён)
      //   2. proposed/approved с истекшим approval_expires_at → rejected
      //      (action не начался, но TTL истёк — одобрение протухло)
      // Все переходы — в одной транзакции. Если хоть один UPDATE/logEvent
      // падает, всё откатывается (атомарность восстановленного состояния).
      const now = Date.now()
      const stuckExecuting = db.prepare(
        `SELECT action_id FROM browser_actions WHERE status = 'executing'`
      ).all() as Array<{ action_id: string }>
      const expired = db.prepare(
        `SELECT action_id FROM browser_actions
         WHERE status IN ('proposed','approved')
           AND approval_expires_at IS NOT NULL
           AND approval_expires_at < ?`
      ).all(now) as Array<{ action_id: string }>
      if (stuckExecuting.length === 0 && expired.length === 0) return 0

      const finalizeExecuting = db.prepare(
        `UPDATE browser_actions
         SET status = 'uncertain', result_status = 'crashed', updated_at = ?, finalized_at = ?
         WHERE action_id = ? AND status = 'executing'`
      )
      const finalizeExpired = db.prepare(
        `UPDATE browser_actions
         SET status = 'rejected', result_status = 'approval_expired', updated_at = ?, finalized_at = ?
         WHERE action_id = ? AND status IN ('proposed','approved')`
      )
      const logExecutingEvent = db.prepare(
        `INSERT INTO browser_action_events (action_id, from_status, to_status, reason, detail_json, created_at)
         VALUES (?, 'executing', 'uncertain', ?, ?, ?)`
      )
      const logExpiredEvent = db.prepare(
        `INSERT INTO browser_action_events (action_id, from_status, to_status, reason, detail_json, created_at)
         VALUES (?, ?, 'rejected', ?, ?, ?)`
      )
      let affected = 0
      const tx = db.transaction(() => {
        for (const { action_id } of stuckExecuting) {
          const res = finalizeExecuting.run(now, now, action_id)
          if (res.changes > 0) {
            affected++
            logExecutingEvent.run(action_id, 'reconcile_stale_on_startup', null, now)
          }
        }
        for (const { action_id } of expired) {
          // from_status мы не знаем точно (proposed или approved) — пишем оба варианта
          // через SELECT с проверкой. Для аудита достаточно знать «было proposed/approved».
          const res = finalizeExpired.run(now, now, action_id)
          if (res.changes > 0) {
            affected++
            logExpiredEvent.run(action_id, 'proposed/approved', 'approval_ttl_expired_on_startup', null, now)
          }
        }
      })
      tx()
      return affected
    },

    purgeExpiredProofRefs(now = Date.now()) {
      const res = db.prepare(
        `DELETE FROM browser_proof_refs WHERE retention_until IS NOT NULL AND retention_until < ?`
      ).run(now)
      return Number(res.changes)
    },
  }
}
