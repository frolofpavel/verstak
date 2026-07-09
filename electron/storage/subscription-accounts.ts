/**
 * Реестр аккаунтов подписочных / CLI-провайдеров (1.9.3). Несколько аккаунтов на
 * провайдера (напр. пул Claude Max), один активный. Секреты (токены/ключи) НЕ здесь —
 * только `cred_ref` (ключ в SafeStorage settings). Активный аккаунт биндится в env
 * при спавне провайдера (см. runtime). Один активный на провайдера — инвариант.
 */

import type { Database } from 'better-sqlite3'

export interface SubscriptionAccount {
  id: number
  providerId: string
  label: string
  /** Ключ секрета в SafeStorage (settings). Сам токен/ключ в таблице не хранится. */
  credRef: string
  /** Изолированный config-dir (для Gemini/Codex/Grok мультиаккаунта). null = не задан. */
  configDir: string | null
  /** Base URL (для coding-endpoint'ов Kimi/Z.ai). null = дефолт провайдера. */
  baseUrl: string | null
  active: boolean
  /** Состояние (1.9.4): ready | cooling. */
  state: string
  /** Epoch ms до которого аккаунт «остывает» после лимита (null = не остывает). */
  coolingUntil: number | null
  createdAt: number
  lastUsedAt: number | null
}

interface Row extends Omit<SubscriptionAccount, 'active'> { active: number }

const SELECT = `
  SELECT id, provider_id as providerId, label, cred_ref as credRef,
         config_dir as configDir, base_url as baseUrl, active, state,
         cooling_until as coolingUntil, created_at as createdAt, last_used_at as lastUsedAt
  FROM subscription_accounts
`

function toAccount(r: Row): SubscriptionAccount {
  return { ...r, active: r.active === 1 }
}

export interface CreateAccountInput {
  providerId: string
  label: string
  credRef: string
  configDir?: string | null
  baseUrl?: string | null
}

export function createSubscriptionAccount(db: Database, input: CreateAccountInput): SubscriptionAccount {
  const now = Date.now()
  // Первый аккаунт для провайдера становится активным автоматически — иначе провайдер
  // остался бы без активного аккаунта и рантайм не знал бы, чей env биндить.
  const hasActive = db.prepare(
    "SELECT 1 FROM subscription_accounts WHERE provider_id = ? AND active = 1 LIMIT 1"
  ).get(input.providerId)
  const active = hasActive ? 0 : 1
  const info = db.prepare(
    `INSERT INTO subscription_accounts
       (provider_id, label, cred_ref, config_dir, base_url, active, state, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, NULL)`
  ).run(input.providerId, input.label, input.credRef, input.configDir ?? null, input.baseUrl ?? null, active, now)
  return getSubscriptionAccount(db, Number(info.lastInsertRowid))!
}

export function getSubscriptionAccount(db: Database, id: number): SubscriptionAccount | null {
  const r = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined
  return r ? toAccount(r) : null
}

/** Все аккаунты (или одного провайдера), новые первыми. */
export function listSubscriptionAccounts(db: Database, providerId?: string): SubscriptionAccount[] {
  const rows = providerId
    ? db.prepare(`${SELECT} WHERE provider_id = ? ORDER BY created_at DESC, id DESC`).all(providerId)
    : db.prepare(`${SELECT} ORDER BY created_at DESC, id DESC`).all()
  return (rows as Row[]).map(toAccount)
}

/** Активный аккаунт провайдера (или null). */
export function getActiveAccount(db: Database, providerId: string): SubscriptionAccount | null {
  const r = db.prepare(`${SELECT} WHERE provider_id = ? AND active = 1 LIMIT 1`).get(providerId) as Row | undefined
  return r ? toAccount(r) : null
}

/** Сделать аккаунт активным эксклюзивно в рамках его провайдера (другие провайдеры не трогаем). */
export function setActiveAccount(db: Database, providerId: string, id: number): void {
  const tx = db.transaction(() => {
    db.prepare('UPDATE subscription_accounts SET active = 0 WHERE provider_id = ?').run(providerId)
    db.prepare('UPDATE subscription_accounts SET active = 1 WHERE id = ? AND provider_id = ?').run(id, providerId)
  })
  tx()
}

export function renameSubscriptionAccount(db: Database, id: number, label: string): void {
  db.prepare('UPDATE subscription_accounts SET label = ? WHERE id = ?').run(label, id)
}

export function touchSubscriptionAccount(db: Database, id: number, when = Date.now()): void {
  db.prepare('UPDATE subscription_accounts SET last_used_at = ? WHERE id = ?').run(when, id)
}

export function setAccountState(db: Database, id: number, state: string): void {
  db.prepare('UPDATE subscription_accounts SET state = ? WHERE id = ?').run(state, id)
}

/** Пометить аккаунт «остывающим» после лимита (до coolingUntil epoch ms). */
export function markAccountCooling(db: Database, id: number, coolingUntil: number | null): void {
  db.prepare("UPDATE subscription_accounts SET state = 'cooling', cooling_until = ? WHERE id = ?").run(coolingUntil, id)
}

/** Вернуть аккаунт в готовое состояние (лимит сброшен / вручную). */
export function clearCooling(db: Database, id: number): void {
  db.prepare("UPDATE subscription_accounts SET state = 'ready', cooling_until = NULL WHERE id = ?").run(id)
}

export interface SwitchResult { switched: boolean; newAccountId?: number }

/**
 * 1.9.4: активный аккаунт провайдера бьёт лимит → помечаем его cooling(coolingUntil) и
 * переключаем на другой ГОТОВЫЙ аккаунт того же провайдера (не cooling, либо cooling истёк).
 * Кандидат активируется и раскулдаунивается. Нет готового кандидата → switched:false
 * (пул исчерпан целиком — рантайм падёт на обычный provider-fallback).
 */
export function switchActiveOnLimit(db: Database, providerId: string, coolingUntil: number | null, now = Date.now()): SwitchResult {
  const current = getActiveAccount(db, providerId)
  const tx = db.transaction((): SwitchResult => {
    if (current) markAccountCooling(db, current.id, coolingUntil)
    const candidate = db.prepare(
      `SELECT id FROM subscription_accounts
       WHERE provider_id = ? AND id != ?
         AND (state != 'cooling' OR cooling_until IS NULL OR cooling_until <= ?)
       ORDER BY (last_used_at IS NULL) DESC, last_used_at ASC, created_at DESC
       LIMIT 1`
    ).get(providerId, current?.id ?? -1, now) as { id: number } | undefined
    if (!candidate) return { switched: false }
    clearCooling(db, candidate.id)
    setActiveAccount(db, providerId, candidate.id)
    return { switched: true, newAccountId: candidate.id }
  })
  return tx()
}

/**
 * Удалить аккаунт. Если удаляли активный — повышаем следующий (новейший) аккаунт того же
 * провайдера в активные, чтобы провайдер не остался без активного.
 */
export function deleteSubscriptionAccount(db: Database, id: number): boolean {
  const existing = getSubscriptionAccount(db, id)
  if (!existing) return false
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM subscription_accounts WHERE id = ?').run(id)
    if (existing.active) {
      const next = db.prepare(
        "SELECT id FROM subscription_accounts WHERE provider_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
      ).get(existing.providerId) as { id: number } | undefined
      if (next) db.prepare('UPDATE subscription_accounts SET active = 1 WHERE id = ?').run(next.id)
    }
  })
  tx()
  return true
}
