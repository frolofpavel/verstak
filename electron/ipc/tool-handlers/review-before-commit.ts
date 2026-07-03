// Этап 4, Блок E: review_before_commit — гейт качества перед коммитом (recipe-шаг).
// Оркестрация поверх существующих примитивов: НЕ переписывает agent loop.
//  1. Прогоняет обязательную verify (allowlisted, через ctx.tools.runCommand).
//  2. Baseline-aware оценка (Блок F): pre-existing red не блокирует, новые — да.
//  3. Отдаёт diff+brief+verify независимому ревьюеру (delegate role=critic, свежий
//     контекст), парсит строго-JSON вердикт fail-closed.
//  4. При FAIL — до 2 циклов авто-починки отдельным фиксером (delegate role=executor,
//     свежий контекст ≠ ревьюер), затем повторная verify+ревью. После 2 неудач — стоп.
// Политики не обходятся: verify/git через classifyCommand (денилист) + allowlist verify,
// фиксер пишет через mode-policy.decide и run_command через денилист внутри sub-loop.
import type { ToolHandler, ToolContext } from './shared'
import type { ToolCall } from '../../ai/types'
import { delegateTaskHandler } from './delegation'
import { buildDiffCommand } from './review-diff'
import {
  isAllowedVerifyCommand,
  evaluateVerify,
  parseReviewVerdict,
  buildVerdictReviewerPrompt,
  buildFixerPrompt,
  formatVerifyReport,
  MAX_AUTOFIX_CYCLES,
  type VerifyRun,
} from '../../ai/review-gate'

const MAX_DIFF_CHARS = 14000

async function runVerify(ctx: ToolContext, commands: string[]): Promise<{ runs: VerifyRun[]; error?: string }> {
  const runs: VerifyRun[] = []
  for (const cmd of commands) {
    if (!isAllowedVerifyCommand(cmd)) return { runs, error: `verify-команда не в allowlist: "${cmd}"` }
    const verdict = ctx.tools.classifyCommand(cmd)
    if (!verdict.allowed) return { runs, error: `verify-команда заблокирована политикой: ${verdict.reason ?? 'денилист'}` }
    try {
      const r = await ctx.tools.runCommand(cmd)
      runs.push({ command: cmd, output: `${r.stdout || ''}\n${r.stderr || ''}`.trim(), exitCode: r.exitCode })
    } catch (err) {
      runs.push({ command: cmd, output: err instanceof Error ? err.message : String(err), exitCode: 1 })
    }
  }
  return { runs }
}

async function getDiff(ctx: ToolContext, base?: string): Promise<{ diff?: string; error?: string; empty?: boolean }> {
  const built = buildDiffCommand(base ? { base } : { uncommitted: true })
  if ('error' in built) return { error: built.error }
  const verdict = ctx.tools.classifyCommand(built.command)
  if (!verdict.allowed) return { error: `git заблокирован политикой: ${verdict.reason ?? 'денилист'}` }
  try {
    const r = await ctx.tools.runCommand(built.command)
    const diff = (r.stdout || '').trim()
    if (!diff) return { empty: true }
    return { diff: diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + '\n…[diff обрезан по лимиту]' : diff }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export const reviewBeforeCommitHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call: ToolCall, ctx: ToolContext) {
    const args = call.args as Record<string, unknown>
    const brief = String(args.task_brief ?? args.brief ?? '')
    const base = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined
    const providerId = args.provider_id
    const model = args.model
    const verifyCommands = Array.isArray(args.verify_commands)
      ? (args.verify_commands as unknown[]).map(String).map(s => s.trim()).filter(Boolean)
      : []
    // Baseline: явный аргумент модели ИЛИ авто-снапшот из run context (Этап 6 P1).
    // Модель может забыть передать baseline → берём снятый runtime'ом перед первой
    // правкой. Без baseline любая ошибка verify блокирует (fail-closed, без false-pass).
    const explicitBaseline: VerifyRun[] | undefined = Array.isArray(args.baseline) && args.baseline.length
      ? (args.baseline as unknown[]).map(b => {
          const o = b && typeof b === 'object' ? (b as Record<string, unknown>) : {}
          return { command: String(o.command ?? ''), output: String(o.output ?? '') }
        }).filter(b => b.command)
      : undefined
    const baseline: VerifyRun[] | undefined = explicitBaseline ?? ctx.getRecipeBaseline?.()

    const fail = (reason: string) => ({
      id: call.id,
      name: call.name,
      result: `❌ REVIEW GATE: НЕ ПРОЙДЕНО.\nПричина: ${reason}\nНЕ коммить. Устрани причину и вызови гейт снова.`,
    })

    // required verify не задана = fail (гейт без обязательной проверки не пропускает).
    if (verifyCommands.length === 0) {
      return fail('обязательная верификация не задана (verify_commands пуст)')
    }

    let lastReasons: string[] = []
    // Цикл: первичное ревью + до MAX_AUTOFIX_CYCLES попыток авто-починки.
    for (let cycle = 0; cycle <= MAX_AUTOFIX_CYCLES; cycle++) {
      const { runs, error: vErr } = await runVerify(ctx, verifyCommands)
      if (vErr) return fail(vErr)
      const vgate = evaluateVerify(runs, baseline)
      const verifyReport = formatVerifyReport(runs, vgate)

      const d = await getDiff(ctx, base)
      if (d.error) return fail(`не удалось получить diff: ${d.error}`)
      if (d.empty || !d.diff) return fail('нет изменений для ревью (git diff пуст)')

      // Ревьюер — свежий critic (read-only набор), видит только diff+brief+verify.
      const reviewerPrompt = buildVerdictReviewerPrompt(d.diff, brief, verifyReport)
      const reviewCall: ToolCall = {
        ...call,
        args: { role: 'critic', prompt: reviewerPrompt, provider_id: providerId, model, group: 'review_before_commit' },
      }
      const res = await delegateTaskHandler.handle(reviewCall, ctx)
      if (res.error) return fail(`ревьюер недоступен: ${res.error}`)
      const verdict = parseReviewVerdict(typeof res.result === 'string' ? res.result : '')

      if (vgate.pass && verdict.pass) {
        return {
          id: call.id,
          name: call.name,
          result: `✅ REVIEW GATE: ПРОЙДЕНО (confidence ${verdict.confidence}).\n${verdict.summary || 'Изменения безопасно коммитить.'}\n\nВерификация:\n${verifyReport}`,
        }
      }

      lastReasons = []
      if (!vgate.pass) lastReasons.push(`verify: ${vgate.blocking.join('; ')}`)
      if (!verdict.pass && verdict.failReason) lastReasons.push(`ревьюер: ${verdict.failReason}`)

      if (cycle === MAX_AUTOFIX_CYCLES) break

      // Авто-починка: свежий executor (≠ ревьюер и ≠ основной реализатор).
      const issues = [
        ...vgate.blocking,
        ...verdict.issues.map(i =>
          `${i.severity ? `[${i.severity}] ` : ''}${i.file ? `${i.file}: ` : ''}${i.detail}${i.fix ? ` → ${i.fix}` : ''}`),
      ]
      const fixCall: ToolCall = {
        ...call,
        args: { role: 'executor', prompt: buildFixerPrompt(brief, d.diff, issues, verifyReport), provider_id: providerId, model, group: 'review_autofix' },
      }
      const fixRes = await delegateTaskHandler.handle(fixCall, ctx)
      if (fixRes.error) {
        return fail(`авто-починка не выполнена: ${fixRes.error}. Причины ревью: ${lastReasons.join(' | ')}`)
      }
      // Следующая итерация перепрогонит verify + diff + ревью после правок фиксера.
    }

    return fail(`гейт не пройден после ${MAX_AUTOFIX_CYCLES} попыток авто-починки. ${lastReasons.join(' | ')}`)
  },
}
