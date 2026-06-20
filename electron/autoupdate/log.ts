import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { logsDir } from './paths'

export function logAutoUpdate(event: string, data: Record<string, unknown> = {}): void {
  try {
    mkdirSync(logsDir(), { recursive: true })
    appendFileSync(
      join(logsDir(), 'trace.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...data })}\n`,
      'utf8',
    )
  } catch {
    // Logging must never break update flow.
  }
}
