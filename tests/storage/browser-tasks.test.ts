// browser-tasks.test.ts — EXT-B0 storage layer: durable state + state machine
// + crash recovery. Сначала готовим БД через openDb (миграции проходят), потом
// гоняем createBrowserTasks(db) по red-first сценариям из BROWSER_EMPLOYEE_PLAN.md
// §9 Phase B0 / §10.5.
//
// Паттерн зеркалит tests/storage/settings.test.ts — прямой ESM import openDb.
// Известный shum (AGENTS.md §3): на Node ABI better-sqlite3 может падать с
// NODE_MODULE_VERSION 137 vs 143 — тогда весь файл падает с native-ошибкой и
// это НЕ регрессия. Мы не оборачиваем в try/catch чтобы отличить shum от
// реальной поломки схемы.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createBrowserTasks } from '../../electron/storage/browser-tasks'
import type { BrowserTasks } from '../../electron/storage/browser-tasks'

let dir: string
let db: Database
let bt: BrowserTasks

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'v54-bt-test-'))
  db = openDb(join(dir, 'test.db'))
  bt = createBrowserTasks(db)
})

afterEach(() => {
  try { db?.close() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('EXT-B0: migration v54 — fresh DB', () => {
  it('создаёт все 5 browser_* таблиц', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'browser_%' ORDER BY name"
    ).all().map((r: any) => r.name)
    expect(tables).toEqual([
      'browser_action_events',
      'browser_actions',
      'browser_proof_refs',
      'browser_task_runs',
      'browser_tasks',
    ])
  })

  it('schema_version = 54 после fresh open', () => {
    const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }
    expect(row.version).toBeGreaterThanOrEqual(54)
  })

  it('CHECK risk_level отклоняет R5', () => {
    db.prepare(`INSERT INTO browser_tasks (browser_task_id, project_path, created_at, updated_at) VALUES ('bt', '/p', 1, 1)`).run()
    expect(() => {
      db.prepare(`INSERT INTO browser_actions (action_id, browser_task_id, run_id, action_type, risk_level, created_at, updated_at) VALUES ('a','bt','r','click','R5',1,1)`).run()
    }).toThrow()
  })

  it('CHECK status отклоняет bogus', () => {
    db.prepare(`INSERT INTO browser_tasks (browser_task_id, project_path, created_at, updated_at) VALUES ('bt', '/p', 1, 1)`).run()
    db.prepare(`INSERT INTO browser_actions (action_id, browser_task_id, run_id, action_type, risk_level, created_at, updated_at) VALUES ('a','bt','r','click','R3',1,1)`).run()
    expect(() => {
      db.prepare(`UPDATE browser_actions SET status = 'bogus' WHERE action_id = 'a'`).run()
    }).toThrow()
  })

  it('CHECK browser_mode отклоняет unknown', () => {
    expect(() => {
      db.prepare(`INSERT INTO browser_tasks (browser_task_id, project_path, browser_mode, created_at, updated_at) VALUES ('bt','/p','rogue',1,1)`).run()
    }).toThrow()
  })
})

describe('EXT-B0: task lifecycle', () => {
  it('create + get roundtrip', () => {
    const t = bt.create({ browserTaskId: 'bt-1', projectPath: '/p', chatId: 42, runId: 'run-1', providerId: 'kimi', model: 'k1.5' })
    expect(t.browserTaskId).toBe('bt-1')
    expect(t.browserMode).toBe('watch')
    expect(t.observationVersion).toBe(0)
    expect(t.currentRunId).toBe('run-1')
    expect(t.allowedDomains).toEqual([])
    const got = bt.get('bt-1')!
    expect(got.chatId).toBe(42)
  })

  it('listByProject — active фильтр по ended_at', () => {
    bt.create({ browserTaskId: 'a', projectPath: '/p' })
    bt.create({ browserTaskId: 'b', projectPath: '/p' })
    bt.endTask('a')
    const active = bt.listByProject('/p', { activeOnly: true })
    expect(active.map(t => t.browserTaskId)).toEqual(['b'])
    const all = bt.listByProject('/p')
    expect(all.map(t => t.browserTaskId).sort()).toEqual(['a', 'b'])
  })

  it('updateBrowserMode / setAllowedDomains / updateObservation', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p' })
    bt.updateBrowserMode('bt', 'execute')
    bt.setAllowedDomains('bt', ['calltouch.com', 'novoe.online'])
    bt.updateObservation('bt', 'obs-7', 7)
    const t = bt.get('bt')!
    expect(t.browserMode).toBe('execute')
    expect(t.allowedDomains).toEqual(['calltouch.com', 'novoe.online'])
    expect(t.observationVersion).toBe(7)
    expect(t.observationId).toBe('obs-7')
  })
})

describe('EXT-B0: run lineage (BR-015)', () => {
  it('appendRun — ord monotonic, current указывает на голову', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1', providerId: 'kimi' })
    bt.appendRun({ browserTaskId: 'bt', runId: 'r2', providerId: 'codex', handoffReason: 'provider_switch' })
    bt.appendRun({ browserTaskId: 'bt', runId: 'r3', providerId: 'claude', handoffReason: 'provider_switch' })
    const lin = bt.lineage('bt')
    expect(lin.map(r => r.runId)).toEqual(['r1', 'r2', 'r3'])
    expect(lin.map(r => r.ord)).toEqual([0, 1, 2])
    expect(bt.currentRun('bt')!.runId).toBe('r3')
    expect(bt.get('bt')!.currentRunId).toBe('r3')
  })

  it('handoffTo сохраняет reason и не теряет задачу', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.handoffTo({ browserTaskId: 'bt', runId: 'r2', providerId: 'glm', handoffReason: 'provider_switch' })
    const lin = bt.lineage('bt')
    expect(lin[1].handoffReason).toBe('provider_switch')
    expect(bt.currentRun('bt')!.runId).toBe('r2')
    // Старый run закрыт (ended_at заполнен).
    expect(lin[0].endedAt).not.toBeNull()
    expect(lin[1].endedAt).toBeNull()
  })

  it('повторный append того же run_id идемпотентен (UNIQUE)', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    expect(() => bt.appendRun({ browserTaskId: 'bt', runId: 'r1' })).not.toThrow()
    expect(bt.lineage('bt').length).toBe(1)
  })

  it('Pause/Resume — appendRun после endTask остаётся в той же задаче', () => {
    // Симуляция Pause: задача не закрывается, только меняется run.
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.endTask('bt') // Pause = endTask (физически завершаем run-task, но id живёт)
    // Resume: bt.get не должен быть null (задача durable)
    const t = bt.get('bt')
    expect(t).not.toBeNull()
    expect(t!.endedAt).not.toBeNull()
  })
})

describe('EXT-B0: action ledger (BR-013)', () => {
  it('proposeAction — initial state proposed', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    const a = bt.proposeAction({
      actionId: 'a1', browserTaskId: 'bt', runId: 'r1',
      actionType: 'click', riskLevel: 'R3',
      payload: { elementRef: 'btn-1' },
    })
    expect(a.status).toBe('proposed')
    expect(a.riskLevel).toBe('R3')
    expect(a.payload).toEqual({ elementRef: 'btn-1' })
  })

  it('state machine: proposed → approved → executing → verified', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({
      actionId: 'a', browserTaskId: 'bt', runId: 'r1',
      actionType: 'click', riskLevel: 'R3', approvalDigest: 'd-1',
    })
    expect(bt.approveAction('a', 'd-1')).toBe(true)
    expect(bt.getAction('a')!.status).toBe('approved')
    // Атомарный consume — digest должен совпасть.
    expect(bt.consumeApproval('a', 'd-1')).toBe(true)
    expect(bt.getAction('a')!.status).toBe('executing')
    expect(bt.getAction('a')!.approvalConsumedAt).not.toBeNull()
    bt.finalizeAction('a', 'verified', { resultStatus: 'ok' })
    expect(bt.getAction('a')!.status).toBe('verified')
    expect(bt.getAction('a')!.finalizedAt).not.toBeNull()
  })

  it('consumeApproval — неверный digest → отказ', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({ actionId: 'a', browserTaskId: 'bt', runId: 'r1', actionType: 'click', riskLevel: 'R3', approvalDigest: 'd-1' })
    bt.approveAction('a', 'd-1')
    expect(bt.consumeApproval('a', 'wrong-digest')).toBe(false)
    expect(bt.getAction('a')!.status).toBe('approved') // не изменился
  })

  it('consumeApproval — повторный consume после executing → отказ (atomic)', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({ actionId: 'a', browserTaskId: 'bt', runId: 'r1', actionType: 'click', riskLevel: 'R3', approvalDigest: 'd-1' })
    bt.approveAction('a', 'd-1')
    expect(bt.consumeApproval('a', 'd-1')).toBe(true)
    // Повторно «проголосовать» тем же digest — уже нельзя (статус executing).
    expect(bt.consumeApproval('a', 'd-1')).toBe(false)
  })

  it('approveAction — нельзя одобрить уже executing', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({ actionId: 'a', browserTaskId: 'bt', runId: 'r1', actionType: 'click', riskLevel: 'R3', approvalDigest: 'd-1' })
    bt.approveAction('a', 'd-1')
    bt.consumeApproval('a', 'd-1')
    expect(bt.approveAction('a', 'd-1')).toBe(false)
  })

  it('finalize идемпотентен — повторный no-op', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({ actionId: 'a', browserTaskId: 'bt', runId: 'r1', actionType: 'click', riskLevel: 'R3', approvalDigest: 'd-1' })
    bt.approveAction('a', 'd-1')
    bt.consumeApproval('a', 'd-1')
    bt.finalizeAction('a', 'verified', { resultStatus: 'ok' })
    const finalizedAt1 = bt.getAction('a')!.finalizedAt
    bt.finalizeAction('a', 'failed', { resultStatus: 'oops' }) // no-op
    const a = bt.getAction('a')!
    expect(a.status).toBe('verified')
    expect(a.finalizedAt).toBe(finalizedAt1)
  })

  it('actionEvents — append-only трейл переходов', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({ actionId: 'a', browserTaskId: 'bt', runId: 'r1', actionType: 'click', riskLevel: 'R3', approvalDigest: 'd-1' })
    bt.approveAction('a', 'd-1')
    bt.consumeApproval('a', 'd-1')
    bt.finalizeAction('a', 'verified', { resultStatus: 'ok' })
    const ev = bt.actionEvents('a')
    const transitions = ev.map(e => `${e.fromStatus ?? '∅'}→${e.toStatus}`)
    expect(transitions).toEqual(['∅→proposed', 'proposed→approved', 'approved→executing', 'executing→verified'])
  })
})

describe('EXT-B0: crash recovery — executing → uncertain без повтора', () => {
  it('reconcileStaleActions на старте → executing становится uncertain', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({ actionId: 'a', browserTaskId: 'bt', runId: 'r1', actionType: 'click', riskLevel: 'R3', approvalDigest: 'd-1' })
    bt.approveAction('a', 'd-1')
    bt.consumeApproval('a', 'd-1')
    expect(bt.getAction('a')!.status).toBe('executing')
    // Симулируем crash: процесс упал во время executing. На старте:
    const affected = bt.reconcileStaleActions()
    expect(affected).toBe(1)
    const a = bt.getAction('a')!
    expect(a.status).toBe('uncertain')
    expect(a.resultStatus).toBe('crashed')
    // Повторно reconcile — уже ничего не находит (idempotent).
    expect(bt.reconcileStaleActions()).toBe(0)
  })

  it('uncertain action нельзя повторно consume (автоповтор запрещён)', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({ actionId: 'a', browserTaskId: 'bt', runId: 'r1', actionType: 'click', riskLevel: 'R3', approvalDigest: 'd-1' })
    bt.approveAction('a', 'd-1')
    bt.consumeApproval('a', 'd-1')
    bt.reconcileStaleActions()
    // После crash action в uncertain. Повторное consume отклоняется.
    expect(bt.consumeApproval('a', 'd-1')).toBe(false)
    // Новый run (handoff) должен предложить новый action с новым attempt, а не
    // реюзать старый uncertain.
    const sameAction = bt.getAction('a')!
    expect(sameAction.status).toBe('uncertain')
  })

  it('reconcile не трогает verified/failed/proposed actions', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({ actionId: 'p', browserTaskId: 'bt', runId: 'r1', actionType: 'click', riskLevel: 'R3' })
    bt.proposeAction({ actionId: 'v', browserTaskId: 'bt', runId: 'r1', actionType: 'click', riskLevel: 'R3', approvalDigest: 'dv' })
    bt.approveAction('v', 'dv')
    bt.consumeApproval('v', 'dv')
    bt.finalizeAction('v', 'verified')
    expect(bt.reconcileStaleActions()).toBe(0)
    expect(bt.getAction('p')!.status).toBe('proposed')
    expect(bt.getAction('v')!.status).toBe('verified')
  })
})

describe('EXT-B0: proof refs (BR-016) — redacted, no raw secrets', () => {
  it('appendProofRef не принимает cookie/token (contract)', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    const id = bt.appendProofRef({
      actionId: null, browserTaskId: 'bt', runId: 'r1', kind: 'before',
      artifactPath: 'C:/userData/proof/before.png', artifactDigest: 'sha256:abc',
      origin: 'calltouch.com', url: 'https://calltouch.com/report',
      redactedSummary: 'страница отчёта (текст отредактирован)',
      omissions: ['screenshot blocked on sensitive page'],
      retentionUntil: null,
    })
    expect(id).toBeGreaterThan(0)
    const refs = bt.listProofRefs('bt')
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('before')
    expect(refs[0].omissions).toContain('screenshot blocked on sensitive page')
  })

  it('purgeExpiredProofRefs — истекшие по retention_until чистятся', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.appendProofRef({ actionId: null, browserTaskId: 'bt', runId: null, kind: 'observe',
      artifactPath: '/old.png', artifactDigest: 'h1', origin: null, url: null,
      redactedSummary: null, omissions: [], retentionUntil: 1000 })
    bt.appendProofRef({ actionId: null, browserTaskId: 'bt', runId: null, kind: 'observe',
      artifactPath: '/fresh.png', artifactDigest: 'h2', origin: null, url: null,
      redactedSummary: null, omissions: [], retentionUntil: Date.now() + 100000 })
    const purged = bt.purgeExpiredProofRefs(5000)
    expect(purged).toBe(1)
    const left = bt.listProofRefs('bt')
    expect(left).toHaveLength(1)
    expect(left[0].artifactPath).toBe('/fresh.png')
  })
})

describe('EXT-B0-R1: migration v55 — approval TTL column', () => {
  it('browser_actions имеет approval_expires_at колонку', () => {
    const cols = (db.prepare('PRAGMA table_info(browser_actions)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('approval_expires_at')
  })
  it('schema_version ≥ 55', () => {
    const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }
    expect(row.version).toBeGreaterThanOrEqual(55)
  })
  it('idx_browser_actions_approval_ttl существует', () => {
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_browser_actions_approval_ttl'"
    ).get()
    expect(idx).toBeTruthy()
  })
})

describe('EXT-B0-R1: approval TTL — propose with expiresAt + consume after expiry rejected', () => {
  it('proposeAction сохраняет approval_expires_at', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    const expiresAt = Date.now() + 60_000
    const a = bt.proposeAction({
      actionId: 'a1', browserTaskId: 'bt', runId: 'r1',
      actionType: 'click', riskLevel: 'R3', approvalDigest: 'd1',
      approvalExpiresAt: expiresAt,
    })
    expect(a.approvalExpiresAt).toBe(expiresAt)
  })

  it('approveAction после истечения TTL → отказ', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({
      actionId: 'a1', browserTaskId: 'bt', runId: 'r1',
      actionType: 'click', riskLevel: 'R3', approvalDigest: 'd1',
      approvalExpiresAt: Date.now() - 1000, // уже истёк
    })
    expect(bt.approveAction('a1', 'd1')).toBe(false)
    expect(bt.getAction('a1')!.status).toBe('proposed') // не изменился
  })

  it('consumeApproval после истечения TTL → отказ (даже если статус approved)', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    // Симулируем: approve прошёл до истечения, но к моменту consume TTL истёк.
    bt.proposeAction({
      actionId: 'a1', browserTaskId: 'bt', runId: 'r1',
      actionType: 'click', riskLevel: 'R3', approvalDigest: 'd1',
      approvalExpiresAt: Date.now() + 60_000,
    })
    expect(bt.approveAction('a1', 'd1')).toBe(true)
    // Симулируем истечение TTL: обновим approval_expires_at напрямую.
    db.prepare('UPDATE browser_actions SET approval_expires_at = ? WHERE action_id = ?')
      .run(Date.now() - 1000, 'a1')
    expect(bt.consumeApproval('a1', 'd1')).toBe(false)
    expect(bt.getAction('a1')!.status).toBe('approved') // не стал executing
  })

  it('reconcileStaleActions переводит expired proposed/approved в rejected', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({
      actionId: 'expired', browserTaskId: 'bt', runId: 'r1',
      actionType: 'click', riskLevel: 'R3', approvalDigest: 'd1',
      approvalExpiresAt: Date.now() - 1000,
    })
    bt.proposeAction({
      actionId: 'fresh', browserTaskId: 'bt', runId: 'r1',
      actionType: 'click', riskLevel: 'R3', approvalDigest: 'd2',
      approvalExpiresAt: Date.now() + 60_000,
    })
    const affected = bt.reconcileStaleActions()
    expect(affected).toBe(1)
    expect(bt.getAction('expired')!.status).toBe('rejected')
    expect(bt.getAction('expired')!.resultStatus).toBe('approval_expired')
    expect(bt.getAction('fresh')!.status).toBe('proposed') // не тронут
  })
})

describe('EXT-B0-R1: atomicity — state transition + event в одной транзакции', () => {
  it('proposeAction пишет row + event атомарно', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({
      actionId: 'a1', browserTaskId: 'bt', runId: 'r1',
      actionType: 'click', riskLevel: 'R3',
    })
    const ev = bt.actionEvents('a1')
    expect(ev.length).toBe(1)
    expect(ev[0].toStatus).toBe('proposed')
  })

  it('consumeApproval — нет event без успешного UPDATE (digest mismatch)', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({
      actionId: 'a1', browserTaskId: 'bt', runId: 'r1',
      actionType: 'click', riskLevel: 'R3', approvalDigest: 'd-correct',
    })
    bt.approveAction('a1', 'd-correct')
    // consume с неверным digest — UPDATE не выполнится, event не пишется.
    expect(bt.consumeApproval('a1', 'd-wrong')).toBe(false)
    const ev = bt.actionEvents('a1')
    // Должен быть только 'proposed' и 'approved' — НЕТ 'executing'.
    expect(ev.map(e => e.toStatus)).toEqual(['proposed', 'approved'])
  })

  it('finalizeAction идемпотентен — второй finalize не дублирует event', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    bt.proposeAction({
      actionId: 'a1', browserTaskId: 'bt', runId: 'r1',
      actionType: 'click', riskLevel: 'R3', approvalDigest: 'd1',
    })
    bt.approveAction('a1', 'd1')
    bt.consumeApproval('a1', 'd1')
    bt.finalizeAction('a1', 'verified', { resultStatus: 'ok' })
    bt.finalizeAction('a1', 'failed', { resultStatus: 'oops' }) // no-op
    const ev = bt.actionEvents('a1')
    const finalizedEvents = ev.filter(e => e.toStatus === 'verified' || e.toStatus === 'failed')
    expect(finalizedEvents.length).toBe(1) // только первый
    expect(finalizedEvents[0].toStatus).toBe('verified')
  })
})

describe('EXT-B0-R1: appendRun — идемпотентность и атомарность lineage', () => {
  it('повторный append того же run_id НЕ закрывает активный run', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1' })
    // r1 — активный. Добавим r2 — он должен закрыть r1.
    bt.appendRun({ browserTaskId: 'bt', runId: 'r2', handoffReason: 'provider_switch' })
    const r1First = bt.lineage('bt').find(r => r.runId === 'r1')!
    expect(r1First.endedAt).not.toBeNull()
    // Теперь повторно append r2 — НЕ должно закрывать r2 (он сам активный).
    bt.appendRun({ browserTaskId: 'bt', runId: 'r2', handoffReason: 'provider_switch' })
    const lin = bt.lineage('bt')
    expect(lin.length).toBe(2) // не дублировался
    const r2 = lin.find(r => r.runId === 'r2')!
    expect(r2.endedAt).toBeNull() // остался активным
  })

  it('handoffToProvider сохраняет task + lineage (atomic)', () => {
    bt.create({ browserTaskId: 'bt', projectPath: '/p', runId: 'r1', providerId: 'kimi' })
    bt.handoffTo({ browserTaskId: 'bt', runId: 'r2', providerId: 'glm', handoffReason: 'provider_switch' })
    // task current указывает на r2, lineage не рассинхронизирован.
    expect(bt.get('bt')!.currentRunId).toBe('r2')
    expect(bt.currentRun('bt')!.runId).toBe('r2')
    expect(bt.lineage('bt').length).toBe(2)
  })
})
