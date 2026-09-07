/**
 * Происхождение прогона: какие возможности в нём участвовали.
 *
 * Заведено потому, что доверие считать было НЕ ИЗ ЧЕГО: `agent_runs` не хранил
 * ни скилла, ни возможности, а `skill_usage` считает использования без исходов.
 * Уровень автономности, посчитанный по такой основе, был бы выдумкой.
 *
 * Связь многие-ко-многим: один прогон задействует скилл, роль и, в будущем,
 * несколько MCP-серверов сразу. Первичный ключ по ПАРЕ — повтор привязки при
 * возобновлении прогона не удваивает доказательства, то есть доверие нельзя
 * накрутить перезапуском.
 */
import type { Database } from 'better-sqlite3'

export interface RunCapabilities {
  /**
   * Привязать прогон к возможностям ВМЕСТЕ С ИХ ВЕРСИЯМИ. Повтор безопасен,
   * пустой список — no-op. Версия обязательна: доказательства принадлежат
   * проверенному содержимому, а не имени возможности.
   */
  link: (runId: string, used: ReadonlyArray<{ id: string; version: string }>) => void
  /** Прогоны, в которых участвовала возможность. */
  runsFor: (capabilityId: string) => string[]
  /** Возможности одного прогона. */
  capabilitiesOf: (runId: string) => string[]
}

export function createRunCapabilities(db: Database): RunCapabilities {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO agent_run_capabilities (run_id, capability_id, capability_version, created_at) VALUES (?, ?, ?, ?)'
  )
  const byCapability = db.prepare('SELECT run_id FROM agent_run_capabilities WHERE capability_id = ? ORDER BY created_at')
  const byRun = db.prepare('SELECT capability_id FROM agent_run_capabilities WHERE run_id = ?')

  return {
    link(runId, used) {
      if (!runId || used.length === 0) return
      const now = Date.now()
      const tx = db.transaction((items: ReadonlyArray<{ id: string; version: string }>) => {
        for (const item of items) if (item.id) insert.run(runId, item.id, item.version, now)
      })
      tx(used)
    },

    runsFor(capabilityId) {
      return (byCapability.all(capabilityId) as Array<{ run_id: string }>).map(r => r.run_id)
    },

    capabilitiesOf(runId) {
      return (byRun.all(runId) as Array<{ capability_id: string }>).map(r => r.capability_id)
    },
  }
}
