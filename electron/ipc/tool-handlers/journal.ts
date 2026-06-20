// Journal-хендлер: read_journal. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity } from './shared'

export const readJournalHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    const requestedLimit = typeof call.args.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(call.args.limit))) : 30
    const kindFilter = typeof call.args.kind === 'string' ? call.args.kind : null
    try {
      const all = ctx.readJournal(ctx.projectPath, requestedLimit * 3)
      const filtered = kindFilter ? all.filter(e => e.kind === kindFilter) : all
      const result = filtered.slice(0, requestedLimit).map(e => ({
        kind: e.kind,
        title: e.title,
        detail: e.detail ? e.detail.slice(0, 500) : null,  // cap so journal doesn't blow context
        when: new Date(e.createdAt).toISOString()
      }))
      emitActivity(ctx, call, 'ok', 'read_journal', `${result.length} записей${kindFilter ? ` · kind=${kindFilter}` : ''}`)
      return { id: call.id, name: call.name, result: JSON.stringify(result) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}
