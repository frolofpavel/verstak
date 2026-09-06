/**
 * Оверлей возможностей — единственное, что реестр хранит СВОЕГО.
 *
 * Имя, описание, включённость и права читаются у источников (файл скилла,
 * mcp_servers, BUILTINS коннекторов, agent-model-policy.json) и здесь НЕ
 * дублируются: копия однажды разойдётся с источником и начнёт врать молча
 * (CLAUDE.md §3.1). Здесь живёт бездомное: уровень доверия, его причина, оценка,
 * отметка проверки и версия, НА КОТОРОЙ доверие было заработано.
 */
import type { Database } from 'better-sqlite3'
import { TRUST_FLOOR, type TrustLevel } from '../../shared/contracts/capability'

export interface CapabilityOverlayRow {
  trustLevel: TrustLevel
  version: string
  evalScore: number | null
  lastVerifiedAt: number | null
}

export interface CapabilityOverlayInput extends CapabilityOverlayRow {
  /** Почему уровень такой. Человек должен видеть основание, а не только цифру. */
  reason: string
}

export interface CapabilityOverlayStore {
  get: (capabilityId: string) => CapabilityOverlayRow | null
  reason: (capabilityId: string) => string | null
  set: (capabilityId: string, input: CapabilityOverlayInput) => void
  /**
   * Реестр увидел текущую версию возможности. Разошлась с той, на которой
   * доверие заработано — уровень падает на пол ЗДЕСЬ, в слое хранения, а не по
   * доброй воле вызывающего: подмена содержимого не должна зависеть от того,
   * вспомнил ли о ней очередной потребитель.
   */
  observeVersion: (capabilityId: string, version: string) => void
}

export function createCapabilityOverlay(db: Database): CapabilityOverlayStore {
  const selectRow = db.prepare(
    'SELECT trust_level, version, eval_score, last_verified_at, trust_reason FROM capability_overlay WHERE capability_id = ?'
  )

  const upsert = db.prepare(`
    INSERT INTO capability_overlay
      (capability_id, trust_level, version, eval_score, last_verified_at, trust_reason, created_at, updated_at)
    VALUES (@id, @trust, @version, @evalScore, @lastVerifiedAt, @reason, @now, @now)
    ON CONFLICT(capability_id) DO UPDATE SET
      trust_level = excluded.trust_level,
      version = excluded.version,
      eval_score = excluded.eval_score,
      last_verified_at = excluded.last_verified_at,
      trust_reason = excluded.trust_reason,
      updated_at = excluded.updated_at
  `)

  const demote = db.prepare(`
    UPDATE capability_overlay
       SET trust_level = @floor, version = @version, eval_score = NULL,
           last_verified_at = NULL, trust_reason = @reason, updated_at = @now
     WHERE capability_id = @id
  `)

  type Raw = {
    trust_level: string
    version: string
    eval_score: number | null
    last_verified_at: number | null
    trust_reason: string | null
  }

  const read = (capabilityId: string): Raw | null =>
    (selectRow.get(capabilityId) as Raw | undefined) ?? null

  return {
    get(capabilityId) {
      const row = read(capabilityId)
      if (!row) return null
      return {
        trustLevel: row.trust_level as TrustLevel,
        version: row.version,
        evalScore: row.eval_score,
        lastVerifiedAt: row.last_verified_at,
      }
    },

    reason(capabilityId) {
      return read(capabilityId)?.trust_reason ?? null
    },

    set(capabilityId, input) {
      upsert.run({
        id: capabilityId,
        trust: input.trustLevel,
        version: input.version,
        evalScore: input.evalScore,
        lastVerifiedAt: input.lastVerifiedAt,
        reason: input.reason,
        now: Date.now(),
      })
    },

    observeVersion(capabilityId, version) {
      const row = read(capabilityId)
      // Записи нет — доверия тоже нет. Заводить строку здесь значило бы создать
      // доверие из ничего: возможность без истории получает дефолт при сборке.
      if (!row) return
      if (row.version === version) return
      demote.run({
        id: capabilityId,
        floor: TRUST_FLOOR,
        version,
        reason: `Сброшено: версия возможности изменилась (${row.version} → ${version}).`,
        now: Date.now(),
      })
    },
  }
}
