import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'

export type HeadlessTaskOperation = 'create' | 'continue'

export const HEADLESS_IDEMPOTENCY_CONFLICT = 'HEADLESS_IDEMPOTENCY_CONFLICT'
export const HEADLESS_IDEMPOTENCY_PENDING = 'HEADLESS_IDEMPOTENCY_PENDING'
export const HEADLESS_IDEMPOTENCY_INVALID = 'HEADLESS_IDEMPOTENCY_INVALID'
export const HEADLESS_IDEMPOTENCY_CORRUPT = 'HEADLESS_IDEMPOTENCY_CORRUPT'

export type HeadlessIdempotencyErrorCode =
  | typeof HEADLESS_IDEMPOTENCY_CONFLICT
  | typeof HEADLESS_IDEMPOTENCY_PENDING
  | typeof HEADLESS_IDEMPOTENCY_INVALID
  | typeof HEADLESS_IDEMPOTENCY_CORRUPT

/** Stable machine-readable error for the HTTP adapter; the message remains useful in logs. */
export class HeadlessIdempotencyError extends Error {
  readonly code: HeadlessIdempotencyErrorCode
  readonly retryAfterSeconds: number | null

  constructor(code: HeadlessIdempotencyErrorCode, message: string, retryAfterSeconds: number | null = null) {
    super(`${code}: ${message}`)
    this.name = 'HeadlessIdempotencyError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

interface Row {
  key: string
  operation: HeadlessTaskOperation
  requestHash: string
  status: 'pending' | 'completed' | 'retryable'
  claimToken: string | null
  leaseExpiresAt: number
  runId: string | null
  threadId: number | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}

export interface HeadlessIdempotencyClaim {
  key: string
  operation: HeadlessTaskOperation
  requestHash: string
  claimToken: string
}

export interface HeadlessIdempotencyReplay {
  runId: string
  threadId: number
}

export type HeadlessIdempotencyLookup =
  | { kind: 'absent' | 'retryable' }
  | { kind: 'pending'; retryAfterSeconds: number }
  | ({ kind: 'completed' } & HeadlessIdempotencyReplay)

export type HeadlessIdempotencyClaimResult =
  | { kind: 'claimed'; claim: HeadlessIdempotencyClaim }
  | { kind: 'pending'; retryAfterSeconds: number }
  | ({ kind: 'completed' } & HeadlessIdempotencyReplay)

export interface HeadlessIdempotencyStore {
  /** Read-only fast path. A completed replay is intentionally available before capacity guards. */
  lookup: (key: string, operation: HeadlessTaskOperation, requestHash: string, now?: number) => HeadlessIdempotencyLookup
  /**
   * Atomic claim/reclaim. The random claim token fences an old process whose lease expired:
   * only the current claimant can attach the durable run mapping.
   */
  claim: (input: {
    key: string
    operation: HeadlessTaskOperation
    requestHash: string
    leaseMs: number
    retentionMs: number
    now?: number
  }) => HeadlessIdempotencyClaimResult
  /** Must be called inside the same SQLite transaction as thread/message/run/event creation. */
  complete: (claim: HeadlessIdempotencyClaim, runId: string, threadId: number, now?: number) => void
  /** A failure before durable acceptance is safe to retry with the same key. */
  releaseRetryable: (claim: HeadlessIdempotencyClaim, now?: number) => boolean
  /** Fixed-TTL cleanup; successful replays never extend expires_at. */
  cleanupExpired: (now?: number) => number
}

const SELECT_ROW = `
  SELECT idempotency_key as key, operation, request_hash as requestHash, status,
         claim_token as claimToken, lease_expires_at as leaseExpiresAt,
         run_id as runId, thread_id as threadId,
         created_at as createdAt, updated_at as updatedAt, expires_at as expiresAt
  FROM headless_task_idempotency WHERE idempotency_key = ?
`

function pendingRetryAfter(leaseExpiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((leaseExpiresAt - now) / 1000))
}

function assertSameRequest(row: Row, operation: HeadlessTaskOperation, requestHash: string): void {
  if (row.operation !== operation || row.requestHash !== requestHash) {
    throw new HeadlessIdempotencyError(
      HEADLESS_IDEMPOTENCY_CONFLICT,
      'ключ уже привязан к другой операции или другому содержимому запроса',
    )
  }
}

function resultFromRow(row: Row, now: number): HeadlessIdempotencyLookup {
  if (row.status === 'completed') {
    if (row.runId == null || row.threadId == null) {
      throw new HeadlessIdempotencyError(HEADLESS_IDEMPOTENCY_CORRUPT, 'завершённая запись не содержит run/thread')
    }
    return { kind: 'completed', runId: row.runId, threadId: row.threadId }
  }
  if (row.status === 'pending' && row.leaseExpiresAt > now) {
    return { kind: 'pending', retryAfterSeconds: pendingRetryAfter(row.leaseExpiresAt, now) }
  }
  return { kind: 'retryable' }
}

export function createHeadlessIdempotencyStore(db: Database): HeadlessIdempotencyStore {
  const read = db.prepare(SELECT_ROW)

  return {
    lookup(key, operation, requestHash, now = Date.now()) {
      const row = read.get(key) as Row | undefined
      if (!row || row.expiresAt <= now) return { kind: 'absent' }
      assertSameRequest(row, operation, requestHash)
      return resultFromRow(row, now)
    },

    claim({ key, operation, requestHash, leaseMs, retentionMs, now = Date.now() }) {
      db.prepare('DELETE FROM headless_task_idempotency WHERE expires_at <= ?').run(now)
      const claimToken = randomUUID()
      const leaseExpiresAt = now + Math.max(1, Math.floor(leaseMs))
      const expiresAt = now + Math.max(1, Math.floor(retentionMs))

      // One statement is the inter-process arbitration point. ON CONFLICT only
      // reclaims the exact same semantic request after a released/expired lease.
      db.prepare(`
        INSERT INTO headless_task_idempotency
          (idempotency_key, operation, request_hash, status, claim_token,
           lease_expires_at, run_id, thread_id, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, 'pending', ?, ?, NULL, NULL, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          status = 'pending',
          claim_token = excluded.claim_token,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at
        WHERE headless_task_idempotency.operation = excluded.operation
          AND headless_task_idempotency.request_hash = excluded.request_hash
          AND (
            headless_task_idempotency.status = 'retryable'
            OR (
              headless_task_idempotency.status = 'pending'
              AND headless_task_idempotency.lease_expires_at <= excluded.updated_at
            )
          )
      `).run(key, operation, requestHash, claimToken, leaseExpiresAt, now, now, expiresAt)

      const row = read.get(key) as Row | undefined
      if (!row) {
        throw new HeadlessIdempotencyError(HEADLESS_IDEMPOTENCY_CORRUPT, 'атомарный claim не оставил запись')
      }
      assertSameRequest(row, operation, requestHash)
      if (row.status === 'pending' && row.claimToken === claimToken) {
        return {
          kind: 'claimed',
          claim: { key, operation, requestHash, claimToken },
        }
      }
      const existing = resultFromRow(row, now)
      if (existing.kind === 'completed') return existing
      if (existing.kind === 'pending') return existing
      throw new HeadlessIdempotencyError(HEADLESS_IDEMPOTENCY_CORRUPT, 'после claim осталась retryable-запись')
    },

    complete(claim, runId, threadId, now = Date.now()) {
      const result = db.prepare(`
        UPDATE headless_task_idempotency
        SET status = 'completed', claim_token = NULL, lease_expires_at = 0,
            run_id = ?, thread_id = ?, updated_at = ?
        WHERE idempotency_key = ? AND operation = ? AND request_hash = ?
          AND status = 'pending' AND claim_token = ?
      `).run(
        runId,
        threadId,
        now,
        claim.key,
        claim.operation,
        claim.requestHash,
        claim.claimToken,
      )
      if (result.changes !== 1) {
        throw new HeadlessIdempotencyError(
          HEADLESS_IDEMPOTENCY_PENDING,
          'атомарное принятие отклонено: lease уже перехвачен другим процессом',
          1,
        )
      }
    },

    releaseRetryable(claim, now = Date.now()) {
      const result = db.prepare(`
        UPDATE headless_task_idempotency
        SET status = 'retryable', claim_token = NULL, lease_expires_at = 0, updated_at = ?
        WHERE idempotency_key = ? AND operation = ? AND request_hash = ?
          AND status = 'pending' AND claim_token = ?
      `).run(now, claim.key, claim.operation, claim.requestHash, claim.claimToken)
      return result.changes === 1
    },

    cleanupExpired(now = Date.now()) {
      return db.prepare('DELETE FROM headless_task_idempotency WHERE expires_at <= ?').run(now).changes
    },
  }
}
