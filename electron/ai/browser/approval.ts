// approval.ts — строгий scoped browser-action approval transport (BR-017).
//
// КОНТРАСТ с существующим `ai:resolve-command`/`ai:resolve-write` (см.
// electron/ipc/ai.ts:1300-1316, 1381-1394): те каналы — boolean-only (accept:
// boolean) + endsWith-suffix fallback. План EXT-B0 §13 BR-017 явно требует НЕ
// переиспользовать слабый транспорт: «От старого pending-command переиспользуется
// UI, но browser approval получает строгий scoped transport без suffix fallback».
//
// Поэтому:
//   • approval привязан к digest'у ВСЕХ неизменяемых полей действия (BR-017 п.7):
//     browserTaskId/runId/clientId/tab/document/origin/tenant/account/observation/
//     elementRef, actionType, payload, preconditions, expected postcondition.
//   • approval одноразовый: после consume — status='executing', повторное
//     consume невозможно (см. browser-tasks.ts:consumeApproval).
//   • approval атомарно потребляется ДО executor (см. controller.ts).
//   • scope check при consume: если любое поле изменилось (другой task/run/
//     observationVersion/tenant) — digest не совпадёт, approval отклоняется.
//
// Машиностроение: digest = sha256(canonical_json(snapshot)). Canonical JSON —
// отсортированные ключи на всех уровнях, без trailing newline. Это детерминированно
// и не зависит от порядка полей в исходном объекте.

import { createHash } from 'node:crypto'
import type {
  ActionId,
  BrowserAction,
  BrowserActionScope,
  BrowserActionType,
  BrowserApprovalDigest,
  BrowserPostcondition,
  BrowserActionPreconditions,
  BrowserTaskId,
  RunId,
  RiskLevel,
} from './types'

// ── Canonical JSON ───────────────────────────────────────────────────────────

/**
 * Сериализует значение в детерминированный JSON: ключи объектов отсортированы
 * рекурсивно, без пробелов, без trailing newline. Массивы — в исходном порядке
 * (это важно: порядок строк в таблице, последовательность preconditions и т.п.).
 *
 * Это даёт стабильный sha256 для одного и того же логического содержания, даже
 * если исходный объект был собран из разных мест с разным порядком ключей.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]))
    return '{' + pairs.join(',') + '}'
  }
  // functions, symbols, bigint — не должны попадать в approval snapshot.
  return 'null'
}

// ── Snapshot — то, что входит в digest ───────────────────────────────────────

export interface ApprovalSnapshot {
  browserTaskId: BrowserTaskId
  runId: RunId
  clientId?: string | null
  scope: BrowserActionScope
  actionType: BrowserActionType
  payload: Record<string, unknown>
  preconditions: BrowserActionPreconditions
  expectedPostcondition?: BrowserPostcondition | null
  risk: RiskLevel
}

/**
 * Собирает snapshot из BrowserAction (или из полей controller'а). Snapshot —
 * ВСЕ неизменяемые поля действия. Любое изменение в любом из них даёт другой
 * digest → старый approval становится недействительным.
 */
export function buildApprovalSnapshot(action: {
  browserTaskId: BrowserTaskId
  runId: RunId
  scope: BrowserActionScope
  actionType: BrowserActionType
  payload?: Record<string, unknown>
  preconditions?: BrowserActionPreconditions
  expectedPostcondition?: BrowserPostcondition | null
  risk: RiskLevel
  clientId?: string | null
}): ApprovalSnapshot {
  return {
    browserTaskId: action.browserTaskId,
    runId: action.runId,
    clientId: action.clientId ?? action.scope.clientId ?? null,
    scope: action.scope,
    actionType: action.actionType,
    payload: action.payload ?? {},
    preconditions: action.preconditions ?? {},
    expectedPostcondition: action.expectedPostcondition ?? null,
    risk: action.risk,
  }
}

/**
 * Считает sha256 digest от snapshot. Детерминированный: тот же snapshot → тот же
 * digest. Любое изменение хотя бы в одном поле — другой digest.
 */
export function computeDigest(snapshot: ApprovalSnapshot): string {
  const payload = canonicalJson({
    v: 1,                                      // version digest-схемы
    browserTaskId: snapshot.browserTaskId,
    runId: snapshot.runId,
    clientId: snapshot.clientId ?? null,
    scope: snapshot.scope,
    actionType: snapshot.actionType,
    payload: snapshot.payload,
    preconditions: snapshot.preconditions,
    expectedPostcondition: snapshot.expectedPostcondition ?? null,
    risk: snapshot.risk,
  })
  return 'sha256:' + createHash('sha256').update(payload, 'utf8').digest('hex')
}

/**
 * Полный digest-объект для UI и аудита. Содержит snapshot для отображения
 * «что именно одобряется» ( BR-017 п.6: «Approval показывает client/project,
 * tenant/account, домен, target, действие, old/new и ожидаемый эффект»).
 */
export function buildDigest(action: {
  actionId: ActionId
  browserTaskId: BrowserTaskId
  runId: RunId
  scope: BrowserActionScope
  actionType: BrowserActionType
  payload?: Record<string, unknown>
  preconditions?: BrowserActionPreconditions
  expectedPostcondition?: BrowserPostcondition | null
  risk: RiskLevel
  clientId?: string | null
}): BrowserApprovalDigest {
  const snapshot = buildApprovalSnapshot(action)
  const digest = computeDigest(snapshot)
  return { actionId: action.actionId, digest, snapshot }
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * Проверяет, что текущий snapshot действия совпадает с тем, под который выдавался
 * approval. Используется в controller'е ПЕРЕД consume: если action изменился
 * после propose (модель «дописала» payload, наблюдение устарело, tenant сменился) —
 * approval недействителен, нужен новый propose + новый approval.
 */
export function verifyDigest(currentSnapshot: ApprovalSnapshot, expectedDigest: string): boolean {
  const currentDigest = computeDigest(currentSnapshot)
  return constantTimeEqual(currentDigest, expectedDigest)
}

/**
 * Сравнение строк в constant-time (защита от timing-атак на digest compare).
 * Здесь это теоретическая мера — на практике digest'ы приходят из UI по IPC, не
 * от внешнего атакующего, но привычка писать safe-compare для approval'ов
 * полезна и стоит копейки.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// ── Scope check helpers (для controller'а) ───────────────────────────────────

export interface ScopeCheckResult {
  ok: boolean
  reason?: string
}

/**
 * Проверка: текущий observation соответствует preconditions действия? Это НЕ
 * digest-check (digest фиксирован на момент propose); это проверка «актуально ли
 * действие ВООБЩЕ». Используется в controller'е:
 *   1. observe свежий
 *   2. propose action с preconditions (expectedOrigin, expectedObservationVersion)
 *   3. между propose и execute — страница могла смениться (navigation, tenant
 *      switch). scopeCheck проверяет, что preconditions ещё держатся.
 */
export function checkPreconditions(
  preconditions: BrowserActionPreconditions,
  current: {
    origin?: string | null
    observationVersion?: number | null
    observationId?: string | null
    tenant?: string | null
    account?: string | null
    url?: string | null
  }
): ScopeCheckResult {
  if (preconditions.expectedOrigin != null) {
    if (current.origin !== preconditions.expectedOrigin) {
      return { ok: false, reason: `origin изменился: ожидался ${preconditions.expectedOrigin}, фактически ${current.origin ?? 'null'}` }
    }
  }
  if (preconditions.expectedObservationVersion != null) {
    if (current.observationVersion !== preconditions.expectedObservationVersion) {
      return { ok: false, reason: `observationVersion изменился: ожидался ${preconditions.expectedObservationVersion}, фактически ${current.observationVersion ?? 'null'}` }
    }
  }
  if (preconditions.expectedObservationId != null) {
    if (current.observationId !== preconditions.expectedObservationId) {
      return { ok: false, reason: `observationId изменился` }
    }
  }
  if (preconditions.expectedTenant != null) {
    if (current.tenant !== preconditions.expectedTenant) {
      return { ok: false, reason: `tenant изменился: ожидался ${preconditions.expectedTenant}, фактически ${current.tenant ?? 'null'}` }
    }
  }
  if (preconditions.expectedAccount != null) {
    if (current.account !== preconditions.expectedAccount) {
      return { ok: false, reason: `account изменился: ожидался ${preconditions.expectedAccount}, фактически ${current.account ?? 'null'}` }
    }
  }
  if (preconditions.expectedUrlPattern != null && current.url != null) {
    if (!current.url.includes(preconditions.expectedUrlPattern)) {
      return { ok: false, reason: `URL не содержит ожидаемый паттерн "${preconditions.expectedUrlPattern}"` }
    }
  }
  return { ok: true }
}

/**
 * Проверка: scope действия (action.scope) принадлежит тому же task/run/client,
 * что и approval, под которым оно выполняется. Контроллер использует это для
 * защиты от cross-task/cross-client утечки approval (BR-017 п.6: «approval
 * клиента A нельзя применить к клиенту B»).
 */
export function checkScopeAlignment(
  action: { browserTaskId: BrowserTaskId; runId: RunId; scope: BrowserActionScope },
  approval: { snapshot: ApprovalSnapshot }
): ScopeCheckResult {
  if (action.browserTaskId !== approval.snapshot.browserTaskId) {
    return { ok: false, reason: `browserTaskId не совпадает: action=${action.browserTaskId}, approval=${approval.snapshot.browserTaskId}` }
  }
  if (action.runId !== approval.snapshot.runId) {
    return { ok: false, reason: `runId не совпадает: action=${action.runId}, approval=${approval.snapshot.runId}` }
  }
  const aScope = action.scope
  const pScope = approval.snapshot.scope
  if (aScope.tabRef !== pScope.tabRef) {
    return { ok: false, reason: 'tabRef не совпадает' }
  }
  if (aScope.origin !== pScope.origin) {
    return { ok: false, reason: 'origin не совпадается' }
  }
  if (aScope.tenant !== pScope.tenant) {
    return { ok: false, reason: 'tenant не совпадается' }
  }
  if (aScope.account !== pScope.account) {
    return { ok: false, reason: 'account не совпадается' }
  }
  if (aScope.observationVersion !== pScope.observationVersion) {
    return { ok: false, reason: 'observationVersion не совпадается (старые refs недействительны)' }
  }
  return { ok: true }
}

// ── Re-export для controller'а ───────────────────────────────────────────────

export { buildApprovalSnapshot as snapshotFromAction }
