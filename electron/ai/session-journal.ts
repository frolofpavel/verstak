import type { ToolCall } from './types'

export type ExitReason = 'completed' | 'aborted' | 'error' | 'max-turns' | 'loop-detected' | 'crashed'

export function callSignature(call: ToolCall): string {
  return `${call.name}::${JSON.stringify(call.args)}`
}

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

export function writeSessionJournal(
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void,
  projectPath: string,
  lastAssistantText: string,
  filesTouched: Set<string>,
  commandsRun: string[],
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
  reason: ExitReason = 'completed'
): void {
  void recordJournal
  void projectPath
  void lastAssistantText
  void filesTouched
  void commandsRun
  void usage
  void reason
}
