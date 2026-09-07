/**
 * Доказательства о работе возможности — вход для губернатора доверия.
 *
 * Считается ТОЛЬКО по тому, что продукт реально пишет: статусы прогонов
 * (`agent_runs`), итоги проверок (`verifications`) и связь прогона с
 * возможностью (`agent_run_capabilities`).
 *
 * ЧТО НЕ СЧИТАЕТСЯ И ПОЧЕМУ. Нарушения политики и безопасности, неожиданное
 * поведение инструмента, отказы человека и перерасход бюджета остаются нулями:
 * в продукте сегодня НЕТ события, которое их записывает — журнал знает
 * `tool_call`, `error` и `smart_approve`, и ни одно из них не означает нарушения.
 * Пересказать `error` как «нарушение безопасности» было бы хуже нуля: доверие
 * падало бы от обычной неудачи команды, а настоящее нарушение всё равно осталось
 * бы незамеченным. Ноль здесь честно значит «не наблюдалось», а не «не было».
 */
import type { Database } from 'better-sqlite3'
import { emptyEvidence, type TrustEvidence } from '../../shared/contracts/trust'
import { parseCapabilityId } from '../../shared/contracts/capability'

/** Статусы, означающие, что прогон ДОШЁЛ до конца — успешно или нет. */
const TERMINAL = ['done', 'failed', 'stopped', 'timed_out', 'interrupted']

/**
 * `currentVersion` обязателен: считаются ТОЛЬКО прогоны, сделанные этим самым
 * содержимым. Иначе правка файла скилла унаследовала бы репутацию прежней
 * версии, и правило «обновление не повышает доверие» обходилось бы редактором.
 */
export function collectEvidence(db: Database, capabilityId: string, currentVersion: string): TrustEvidence {
  const evidence = emptyEvidence()
  const parsed = parseCapabilityId(capabilityId)
  if (!parsed) return evidence

  const runIds = new Set<string>(
    (db
      .prepare('SELECT run_id FROM agent_run_capabilities WHERE capability_id = ? AND capability_version = ?')
      .all(capabilityId, currentVersion) as Array<{ run_id: string }>).map(r => r.run_id)
  )

  // У ролей агента привязка уже была своя: durable control plane хранит роль
  // прямо в задании. Заводить для них вторую связь незачем.
  if (parsed.type === 'agent') {
    for (const row of db
      .prepare('SELECT run_id FROM agent_jobs WHERE role = ? AND run_id IS NOT NULL')
      .all(parsed.nativeId) as Array<{ run_id: string }>) {
      runIds.add(row.run_id)
    }
  }

  if (runIds.size === 0) return evidence

  const ids = [...runIds]
  const holes = ids.map(() => '?').join(',')

  for (const row of db
    .prepare(`SELECT status FROM agent_runs WHERE run_id IN (${holes})`)
    .all(...ids) as Array<{ status: string }>) {
    if (row.status === 'done') evidence.successfulRuns += 1
    if (TERMINAL.includes(row.status)) evidence.completedTasks += 1
  }

  for (const row of db
    .prepare(`SELECT overall FROM verifications WHERE run_id IN (${holes})`)
    .all(...ids) as Array<{ overall: string }>) {
    // `not_run` — не провал: проверки просто не было. Считать её провалом значило
    // бы наказывать возможность за отсутствие проверки, а не за её итог.
    if (row.overall === 'not_run') continue
    evidence.verificationsTotal += 1
    if (row.overall === 'passed') evidence.verificationsPassed += 1
  }

  return evidence
}
