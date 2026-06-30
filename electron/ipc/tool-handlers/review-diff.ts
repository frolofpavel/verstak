// F5: review_diff — ревью git-diff, скоупленного по base-ветке / коммиту / рабочему
// дереву (uncommitted), отдельным критиком. В отличие от Explicit Review (ревьюит
// ОТВЕТ модели) и run_command(git diff) — это first-class действие: сам считает
// merge-base, отдаёт критику структурированный diff.
import type { ToolHandler } from './shared'
import { delegateTaskHandler } from './delegation'

// Безопасные символы git-ref: буквы/цифры/_/-/./+/слэш. Блокируем shell-инъекцию
// (base="main; rm -rf /") ещё до денилиста — строгий allowlist символов ref.
const GIT_REF_RE = /^[\w./+-]+$/
const MAX_DIFF_CHARS = 14000

export interface DiffArgs {
  base?: string        // ревью против ветки/ref: git diff <base>...HEAD (merge-base, three-dot)
  commit?: string      // ревью конкретного коммита: git show <commit>
  uncommitted?: boolean // ревью рабочего дерева vs HEAD (по умолчанию)
}

/** Построить git-команду диффа. Pure — тестируется отдельно. Валидирует ref. */
export function buildDiffCommand(args: DiffArgs): { command: string } | { error: string } {
  const commit = args.commit?.trim()
  const base = args.base?.trim()
  if (commit) {
    if (!GIT_REF_RE.test(commit)) return { error: `Небезопасный commit ref: "${commit}"` }
    return { command: `git --no-pager show ${commit}` }
  }
  if (base) {
    if (!GIT_REF_RE.test(base)) return { error: `Небезопасный base ref: "${base}"` }
    return { command: `git --no-pager diff ${base}...HEAD` }
  }
  // По умолчанию — рабочее дерево против HEAD (staged + unstaged).
  return { command: `git --no-pager diff HEAD` }
}

function reviewInstruction(scope: string, diff: string): string {
  return `Ты — строгий код-ревьюер. Отревьюй ИМЕННО этот git-diff (${scope}). Ищи: баги/логические ошибки, дыры безопасности, регрессии, нарушения стиля и контрактов, отсутствие проверок. Не правь и не запускай команды — только разбор. Для каждой находки: файл:строка, серьёзность (CRITICAL/HIGH/MEDIUM/LOW), в чём проблема, как чинить. Если всё чисто — скажи прямо.\n\nDIFF:\n\`\`\`diff\n${diff}\n\`\`\``
}

export const reviewDiffHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const args = call.args as DiffArgs
    const built = buildDiffCommand(args)
    if ('error' in built) {
      return { id: call.id, name: call.name, result: '', error: built.error }
    }
    // Денилист-гейт (git diff/show безопасны) + исполнение проектным раннером.
    const verdict = ctx.tools.classifyCommand(built.command)
    if (!verdict.allowed) {
      return { id: call.id, name: call.name, result: '', error: `git-команда заблокирована: ${verdict.reason ?? 'денилист'}` }
    }
    let diff: string
    try {
      const r = await ctx.tools.runCommand(built.command)
      diff = (r.stdout || '').trim()
      if (!diff && r.stderr) {
        return { id: call.id, name: call.name, result: '', error: `git diff: ${r.stderr.trim().slice(0, 300)}` }
      }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: `git diff не выполнен: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!diff) {
      return { id: call.id, name: call.name, result: 'Нет изменений в выбранном диапазоне — ревьюить нечего.' }
    }
    const scope = args.commit ? `коммит ${args.commit}` : args.base ? `против ${args.base}` : 'рабочее дерево (uncommitted)'
    let capped = diff
    if (capped.length > MAX_DIFF_CHARS) capped = capped.slice(0, MAX_DIFF_CHARS) + '\n…[diff обрезан по лимиту]'
    // Делегируем критику (role=critic → read-only набор), как oracle.
    const dargs = {
      role: 'critic',
      prompt: reviewInstruction(scope, capped),
      provider_id: (call.args as Record<string, unknown>).provider_id,
      model: (call.args as Record<string, unknown>).model,
      group: 'review_diff',
    }
    const res = await delegateTaskHandler.handle({ ...call, args: dargs }, ctx)
    return { ...res, name: call.name }
  }
}
