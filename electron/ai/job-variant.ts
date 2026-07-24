import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentJobV1 } from '../../shared/contracts/agent-job'
import type { UndoStack } from '../storage/undo'
import { safeRealJoin } from './path-policy'
import { mergeWorktreeToMain, removeWorktree, worktreeChangedFiles, worktreeDiff } from './git-worktree'

export type ApplyJobVariantResult =
  | { ok: true; files: string[]; cleanupOk: boolean; warning: string | null }
  | { ok: false; error: string }

export async function applyAgentJobVariant(
  job: AgentJobV1,
  undoStack: UndoStack,
  deps: {
    merge?: typeof mergeWorktreeToMain
    remove?: typeof removeWorktree
  } = {},
): Promise<ApplyJobVariantResult> {
  if (job.status !== 'succeeded' || !job.worktreePath) {
    return { ok: false, error: 'У job нет готового изолированного варианта.' }
  }
  const diff = worktreeDiff(job.worktreePath)
  if (!diff.trim()) return { ok: false, error: 'Вариант не содержит файловых изменений.' }
  if (/^deleted file mode /m.test(diff) || /^Binary files /m.test(diff)) {
    return { ok: false, error: 'Удаления и binary-файлы требуют ручного решения; apply остановлен.' }
  }
  const files = worktreeChangedFiles(job.worktreePath)
  if (files.length === 0) return { ok: false, error: 'Preflight не нашёл применимых файлов.' }
  const snapshots: Array<{ file: string; mainPath: string; before: string | null }> = []
  try {
    for (const file of files) {
      const mainPath = await safeRealJoin(job.projectPath, file)
      const variantPath = await safeRealJoin(job.worktreePath, file)
        readFileSync(variantPath, 'utf8') // preflight: вариант обязан быть читаемым
        snapshots.push({ file, mainPath, before: existsSync(mainPath) ? readFileSync(mainPath, 'utf8') : null })
    }
  } catch (error) {
    return { ok: false, error: `Preflight файлов не пройден: ${error instanceof Error ? error.message : String(error)}` }
  }

  const applied = (deps.merge ?? mergeWorktreeToMain)(job.projectPath, job.worktreePath)
  if (!applied.ok) return { ok: false, error: applied.error ?? 'Не удалось применить variant.' }
  const undoIds: number[] = []
  try {
    for (const snapshot of snapshots) {
      const actualAfter = readFileSync(snapshot.mainPath, 'utf8')
      undoIds.push(undoStack.push(job.projectPath, snapshot.file, snapshot.before, actualAfter, {
        runId: job.runId,
        chatId: job.chatId,
      }).id)
    }
  } catch (error) {
    for (const id of undoIds.reverse()) undoStack.pop(id)
    for (const snapshot of snapshots) {
      if (snapshot.before == null) {
        try { rmSync(snapshot.mainPath, { force: true }) } catch { /* best-effort rollback */ }
      } else {
        mkdirSync(dirname(snapshot.mainPath), { recursive: true })
        writeFileSync(snapshot.mainPath, snapshot.before)
      }
    }
    return { ok: false, error: `Apply отменён: не удалось создать undo-записи (${error instanceof Error ? error.message : String(error)}).` }
  }
  const cleanupOk = (deps.remove ?? removeWorktree)(job.projectPath, job.worktreePath)
  return {
    ok: true,
    files,
    cleanupOk,
    warning: cleanupOk ? null : 'Изменения применены, но cleanup worktree не завершён.',
  }
}

export function rejectAgentJobVariant(
  job: Pick<AgentJobV1, 'projectPath' | 'worktreePath'>,
  remove: typeof removeWorktree = removeWorktree,
): { ok: boolean; removed: boolean; error?: string } {
  if (!job.worktreePath) return { ok: true, removed: false }
  const removed = remove(job.projectPath, job.worktreePath)
  return { ok: removed, removed, error: removed ? undefined : 'Не удалось удалить worktree; путь сохранён для диагностики.' }
}
