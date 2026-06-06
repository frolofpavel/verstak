import type { ToolCall } from './types'

/**
 * Pure helpers for the agent run loop, extracted from ipc/ai.ts.
 * These functions hold NO run state — they take everything as parameters
 * (recordJournal callback, plain data) and never close over the IPC sender,
 * AbortController, or sendId. Behaviour is identical to the inline versions.
 */

/** Reason why the agent loop ended — recorded in the journal entry. */
export type ExitReason = 'completed' | 'aborted' | 'error' | 'max-turns' | 'loop-detected' | 'crashed'

/** Stable signature for a tool call — used for dedupe + loop detection. */
export function callSignature(call: ToolCall): string {
  return `${call.name}::${JSON.stringify(call.args)}`
}

/** Quick verify-script detection for inline hints after accepted writes. */
export async function detectVerifyScriptsForHint(projectPath: string): Promise<string[]> {
  const { readFile } = await import('fs/promises')
  const { join } = await import('path')
  const hints: string[] = []
  try {
    const raw = await readFile(join(projectPath, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
    const s = pkg.scripts ?? {}
    if (s.test) hints.push('npm test')
    if (s['type-check'] || s.typecheck) hints.push('npm run type-check')
    if (s.lint) hints.push('npm run lint')
  } catch { /* not node */ }
  try {
    await readFile(join(projectPath, 'tsconfig.json'), 'utf8')
    if (!hints.some(h => h.includes('tsc') || h.includes('type-check'))) {
      hints.push('npx tsc --noEmit')
    }
  } catch { /* no tsconfig */ }
  return hints
}

/**
 * Write a brief journal summary for the just-finished agent session.
 * Skipped if nothing meaningful happened (no text, no files, no commands).
 */
export function writeSessionJournal(
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void,
  projectPath: string,
  lastAssistantText: string,
  filesTouched: Set<string>,
  commandsRun: string[],
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
  reason: ExitReason = 'completed'
): void {
  const hasFiles = filesTouched.size > 0
  const hasCommands = commandsRun.length > 0
  const text = lastAssistantText.trim()
  const hasUsage = usage && ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0)
  // For non-completed reasons we ALWAYS write the entry, even empty — closes
  // Gemini audit 2.2: previously aborted/crashed sessions left no trail.
  const hasMaterial = hasFiles || hasCommands || hasUsage || text.length >= 40
  if (reason === 'completed' && !hasMaterial) return
  // Title prefix communicates outcome at a glance
  const tag = reason === 'completed' ? '' :
              reason === 'aborted' ? '⏹ Прерывание · ' :
              reason === 'error' ? '✗ Ошибка · ' :
              reason === 'max-turns' ? '⏸ Лимит ходов · ' :
              reason === 'loop-detected' ? '🔁 Зацикливание · ' :
              '💥 Крах · '
  const firstLine = text.split(/\n+/)[0] ?? ''
  const baseTitle = firstLine.length > 0 ? firstLine : 'AI-сессия'
  const title = (tag + baseTitle).slice(0, 100)
  const detailLines: string[] = []
  if (hasFiles) detailLines.push(`Файлы (${filesTouched.size}): ${[...filesTouched].slice(0, 8).join(', ')}${filesTouched.size > 8 ? ' …' : ''}`)
  if (hasCommands) detailLines.push(`Команды (${commandsRun.length}): ${commandsRun.slice(0, 5).join(' · ')}${commandsRun.length > 5 ? ' …' : ''}`)
  if (hasUsage) {
    const i = usage!.inputTokens ?? 0
    const o = usage!.outputTokens ?? 0
    const c = usage!.cachedInputTokens ?? 0
    detailLines.push(`Токены: ↑${i} ↓${o}${c > 0 ? ` ⟲${c}` : ''}`)
  }
  if (text && text.length > firstLine.length) {
    const rest = text.slice(firstLine.length).trim()
    if (rest) detailLines.push(rest.slice(0, 600))
  }
  if (reason !== 'completed') {
    detailLines.unshift(`Состояние: ${reason}`)
  }
  try { recordJournal(projectPath, 'session', title, detailLines.join('\n') || null) } catch { /* journal not critical */ }
}
