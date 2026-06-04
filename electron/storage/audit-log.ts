import type { Database } from 'better-sqlite3'

export interface AuditEntry {
  id: number
  timestamp: number
  projectPath: string
  chatId: number | null
  action: string  // 'tool_call' | 'tool_result' | 'write_file' | 'run_command' | 'provider_switch' | 'error' | 'memory_save' | 'session_start' | 'session_end'
  detail: string  // JSON stringified details, max 500 chars
  providerId: string | null
  model: string | null
}

interface AuditRow {
  id: number
  timestamp: number
  project_path: string
  chat_id: number | null
  action: string
  detail: string
  provider_id: string | null
  model: string | null
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    projectPath: row.project_path,
    chatId: row.chat_id,
    action: row.action,
    detail: row.detail,
    providerId: row.provider_id,
    model: row.model
  }
}

export function appendAudit(
  db: Database,
  entry: Omit<AuditEntry, 'id'>
): void {
  // Cap detail to 500 chars
  const detail = entry.detail.length > 500 ? entry.detail.slice(0, 500) : entry.detail
  db.prepare(
    `INSERT INTO audit_log (timestamp, project_path, chat_id, action, detail, provider_id, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.timestamp,
    entry.projectPath,
    entry.chatId ?? null,
    entry.action,
    detail,
    entry.providerId ?? null,
    entry.model ?? null
  )
}

export interface AuditQueryOpts {
  limit?: number
  action?: string
  since?: number
}

export function queryAudit(
  db: Database,
  projectPath: string,
  opts: AuditQueryOpts = {}
): AuditEntry[] {
  const { limit = 100, action, since } = opts
  const conditions: string[] = ['project_path = ?']
  const params: unknown[] = [projectPath]

  if (action) {
    conditions.push('action = ?')
    params.push(action)
  }
  if (since != null) {
    conditions.push('timestamp >= ?')
    params.push(since)
  }

  params.push(Math.max(1, Math.min(1000, limit)))

  const sql = `SELECT * FROM audit_log WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`
  const rows = db.prepare(sql).all(...params) as AuditRow[]
  return rows.map(rowToEntry)
}

export function exportAuditCsv(db: Database, projectPath: string): string {
  const entries = queryAudit(db, projectPath, { limit: 1000 })
  const header = 'id,timestamp,project_path,chat_id,action,detail,provider_id,model'
  const esc = (v: string | number | null) => {
    if (v == null) return ''
    const s = String(v)
    // CSV escape: wrap in quotes if contains comma, quote, or newline
    if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }
  const rows = entries.map(e =>
    [e.id, e.timestamp, e.projectPath, e.chatId, e.action, e.detail, e.providerId, e.model]
      .map(esc)
      .join(',')
  )
  return [header, ...rows].join('\n')
}

export function clearAudit(
  db: Database,
  projectPath: string,
  olderThan?: number
): number {
  if (olderThan != null) {
    const info = db.prepare(
      'DELETE FROM audit_log WHERE project_path = ? AND timestamp < ?'
    ).run(projectPath, olderThan)
    return info.changes
  }
  const info = db.prepare('DELETE FROM audit_log WHERE project_path = ?').run(projectPath)
  return info.changes
}
