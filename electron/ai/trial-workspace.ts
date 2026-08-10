/**
 * P1: изолированный workspace на исполнителя.
 *
 * Правило постановки — «workspace на исполнителя, как в Arena». Причина не в
 * чистоте эксперимента, а в сохранности работы: два агента в одном каталоге
 * пишут друг поверх друга, и потерю человек замечает постфактум.
 *
 * Механика та же, что у мутационной проверки (C2): git worktree на HEAD. Это
 * даёт настоящую копию дерева без копирования файлов, свой индекс и свой HEAD —
 * и точно так же, как там, рабочее дерево человека не трогается ни байтом.
 *
 * ГРАНИЦА, НАЗВАННАЯ ПРЯМО: проект без git изолировать нечем. Тогда состязание
 * НЕ запускается — молча свести двух исполнителей в один каталог было бы хуже
 * отказа, потому что цена ошибки здесь измеряется потерянной работой.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, existsSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export interface TrialWorkspace {
  /** Абсолютный путь каталога исполнителя. */
  path: string
  /** Снять каталог. Вызывается ТОЛЬКО когда человек решил убрать состязание. */
  dispose: () => void
}

export function isGitRepo(projectPath: string): boolean {
  try {
    execFileSync('git', ['-C', projectPath, 'rev-parse', '--git-dir'], { stdio: 'pipe' })
    return true
  } catch { return false }
}

/**
 * Завести N изолированных копий проекта — по одной на исполнителя.
 * Бросает, если проект не под git: причина в сообщении, а не в логе.
 */
export function createTrialWorkspaces(projectPath: string, count: number, label = 'trial'): TrialWorkspace[] {
  if (count < 1) throw new Error('состязание: нужен хотя бы один исполнитель')
  if (!isGitRepo(projectPath)) {
    throw new Error('Состязание исполнителей требует git-репозитория: только он даёт каждому свою копию дерева. Без него два исполнителя писали бы в один каталог и затирали работу друг друга.')
  }
  const created: TrialWorkspace[] = []
  try {
    for (let i = 0; i < count; i++) {
      const root = mkdtempSync(join(tmpdir(), `verstak-${label}-${i + 1}-`))
      const wt = join(root, 'w')
      execFileSync('git', ['-C', projectPath, 'worktree', 'add', '--detach', wt, 'HEAD'], { stdio: 'pipe' })
      // node_modules общий ссылкой — ставить зависимости в каждую копию значило бы
      // минуты ожидания на ровном месте (тот же приём, что в mutation-check).
      const nm = join(projectPath, 'node_modules')
      if (existsSync(nm) && !existsSync(join(wt, 'node_modules'))) {
        try { symlinkSync(nm, join(wt, 'node_modules'), 'junction') } catch { /* без ссылки просто медленнее */ }
      }
      created.push({
        path: wt,
        dispose: () => {
          try { execFileSync('git', ['-C', projectPath, 'worktree', 'remove', '--force', wt], { stdio: 'pipe' }) } catch { /* prune ниже */ }
          try { execFileSync('git', ['-C', projectPath, 'worktree', 'prune'], { stdio: 'pipe' }) } catch { /* best-effort */ }
          try { rmSync(root, { recursive: true, force: true }) } catch { /* temp */ }
        },
      })
    }
    return created
  } catch (err) {
    // Частично созданные каталоги убираем: половина состязания хуже, чем его отсутствие.
    for (const w of created) w.dispose()
    throw err
  }
}

/**
 * Дифф работы попытки — то, ЧТО именно исполнитель сделал. Им человек смотрит
 * и принятую работу, и отклонённую (правило «принятие не теряет работу»).
 */
export function trialWorkspaceDiff(workspace: string, maxBytes = 200_000): string {
  try {
    const out = execFileSync('git', ['-C', workspace, 'diff', 'HEAD'], {
      encoding: 'utf8', maxBuffer: Math.max(maxBytes * 2, 1_000_000),
    })
    return out.length > maxBytes ? `${out.slice(0, maxBytes)}\n… дифф обрезан (${out.length} байт)` : out
  } catch (err) {
    return `Не удалось прочитать дифф: ${err instanceof Error ? err.message : String(err)}`
  }
}
