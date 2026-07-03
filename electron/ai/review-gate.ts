/**
 * Review-before-commit gate (Этап 4, Блок E) — чистая логика.
 *
 * Гейт качества, который recipe вызывает шагом `review` перед завершением. Он:
 *  1. Прогоняет обязательную верификацию (baseline-aware через baseline-verify.ts).
 *  2. Отдаёт diff + task brief + вывод verify независимому ревьюеру со СВЕЖИМ
 *     контекстом (delegate role=critic) и требует СТРОГО JSON-вердикт.
 *  3. Парсит вердикт fail-closed: невалидный/пустой JSON, confidence < 0.7,
 *     ревьюер не осмотрел diff, или обязательная verify не запускалась = FAIL.
 *
 * Здесь только чистые функции (парсинг вердикта, baseline-aware оценка verify,
 * allowlist verify-команд, сборка промптов). Оркестрация (delegate + autofix-цикл)
 * — в ipc/tool-handlers/review-before-commit.ts.
 */

import { diffAgainstBaseline, extractErrorSignatures } from './baseline-verify'

/** Порог доверия ревьюера: ниже — FAIL (решение Павла, п.7). */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.7

/** Максимум циклов авто-починки после первого FAIL (решение Павла). */
export const MAX_AUTOFIX_CYCLES = 2

/** Разрешённые verify-команды. Гейт исполняет ТОЛЬКО их (fail-closed на прочие),
 *  чтобы модель не протащила произвольную команду под видом верификации. */
export function isAllowedVerifyCommand(command: string): boolean {
  const c = command.trim().toLowerCase()
  if (!c) return false
  // fail-closed: никаких составных команд/редиректов/подстановок — только одиночная verify.
  if (/[;&|`$><]|\|\||&&/.test(c)) return false
  // npm/pnpm/yarn скрипты проверки + прямые tsc/vitest/jest/eslint.
  return (
    /^(npm|pnpm|yarn)\s+(run\s+)?(type|typecheck|test|test:fast|lint|build|check)\b/.test(c) ||
    /^npx\s+(tsc|vitest|jest|eslint)\b/.test(c) ||
    /^(tsc|vitest|jest|eslint)\b/.test(c)
  )
}

export interface VerifyRun {
  command: string
  output: string
  exitCode?: number
}

export interface VerifyGate {
  /** Хоть одна verify-команда прогнана. */
  ranAny: boolean
  /** Блокирующие сигнатуры (новые ошибки / провал без baseline). */
  blocking: string[]
  /** Пройдено: verify запускалась и нет блокирующих ошибок. */
  pass: boolean
}

/**
 * Baseline-aware оценка verify. С baseline — блокируют только НОВЫЕ ошибки
 * (pre-existing red не блокирует, Блок F). Без baseline — строго: exit≠0 или
 * наличие сигнатур ошибок в выводе блокирует.
 */
export function evaluateVerify(runs: VerifyRun[], baseline?: VerifyRun[]): VerifyGate {
  if (!runs || runs.length === 0) {
    return { ranAny: false, blocking: ['обязательная верификация не запускалась'], pass: false }
  }
  const baseByCmd = new Map<string, string>()
  for (const b of baseline ?? []) baseByCmd.set(b.command.trim(), b.output)

  const blocking: string[] = []
  for (const run of runs) {
    const base = baseByCmd.get(run.command.trim())
    if (base !== undefined) {
      const diff = diffAgainstBaseline(base, run.output)
      if (diff.blocked) blocking.push(...diff.newErrors.map(e => `${run.command}: ${e}`))
    } else {
      const sigs = extractErrorSignatures(run.output)
      const failedExit = typeof run.exitCode === 'number' && run.exitCode !== 0
      if (failedExit || sigs.length > 0) {
        blocking.push(`${run.command}: ${sigs.length ? sigs.join('; ') : `exit ${run.exitCode}`}`)
      }
    }
  }
  return { ranAny: true, blocking, pass: blocking.length === 0 }
}

export interface ReviewVerdict {
  pass: boolean
  confidence: number
  inspectedDiff: boolean
  issues: Array<{ severity?: string; file?: string; detail: string; fix?: string }>
  summary: string
  /** Причина FAIL для пользователя; null при pass. */
  failReason: string | null
}

/** Извлекает первый валидный JSON-объект из текста (fenced ```json или голый {…}). */
function extractJsonObject(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates: string[] = []
  if (fence) candidates.push(fence[1].trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const c of candidates) {
    try { return JSON.parse(c) } catch { /* пробуем следующий */ }
  }
  return null
}

/**
 * Парсит вердикт ревьюера fail-closed. ЛЮБАЯ неопределённость → FAIL:
 *  - невалидный/отсутствующий JSON → fail;
 *  - нет поля verdict/pass (пустой вердикт) → fail;
 *  - inspected_diff !== true (ревьюер не осмотрел diff) → fail;
 *  - confidence < 0.7 или отсутствует → fail;
 *  - verdict !== 'pass' → fail.
 */
export function parseReviewVerdict(raw: string): ReviewVerdict {
  const fail = (reason: string, extra?: Partial<ReviewVerdict>): ReviewVerdict => ({
    pass: false, confidence: 0, inspectedDiff: false, issues: [], summary: '', failReason: reason, ...extra,
  })

  const obj = extractJsonObject(raw ?? '')
  if (!obj || typeof obj !== 'object') return fail('ревьюер вернул невалидный JSON')
  const r = obj as Record<string, unknown>

  const hasVerdict = 'verdict' in r || 'pass' in r
  if (!hasVerdict) return fail('пустой вердикт ревьюера (нет поля verdict)')

  const verdictStr = typeof r.verdict === 'string' ? r.verdict.trim().toLowerCase() : null
  const verdictBool = typeof r.pass === 'boolean' ? r.pass : null
  const isPass = verdictStr === 'pass' || verdictStr === 'approve' || verdictBool === true

  const inspectedDiff = r.inspected_diff === true || r.inspectedDiff === true
  const confidence = typeof r.confidence === 'number' ? r.confidence : 0
  const issues = Array.isArray(r.issues)
    ? (r.issues as unknown[]).map(i => {
        const o = (i && typeof i === 'object') ? i as Record<string, unknown> : {}
        return {
          severity: o.severity ? String(o.severity) : undefined,
          file: o.file ? String(o.file) : undefined,
          detail: String(o.detail ?? o.title ?? ''),
          fix: o.fix ? String(o.fix) : (o.suggestedFix ? String(o.suggestedFix) : undefined),
        }
      }).filter(i => i.detail)
    : []
  const summary = typeof r.summary === 'string' ? r.summary : ''

  if (!inspectedDiff) return fail('ревьюер не подтвердил, что осмотрел diff', { issues, summary, confidence })
  if (!isPass) return fail(summary || 'ревьюер вынес verdict=fail', { issues, summary, confidence, inspectedDiff: true })
  if (confidence < REVIEW_CONFIDENCE_THRESHOLD) {
    return fail(`уверенность ревьюера ${confidence} < ${REVIEW_CONFIDENCE_THRESHOLD}`, { issues, summary, confidence, inspectedDiff: true })
  }
  return { pass: true, confidence, inspectedDiff: true, issues, summary, failReason: null }
}

/** Строгий контракт JSON-вердикта для ревьюера. */
export const REVIEW_VERDICT_INSTRUCTION = `Верни СТРОГО один JSON-объект и ничего кроме него, по схеме:
{
  "inspected_diff": true,           // подтверди, что реально прочитал diff
  "verdict": "pass" | "fail",       // pass ТОЛЬКО если изменения безопасно коммитить
  "confidence": 0.0-1.0,            // насколько ты уверен в вердикте
  "issues": [                       // блокирующие/важные находки (пусто при pass)
    { "severity": "high|medium|low", "file": "path", "detail": "что не так", "fix": "как починить" }
  ],
  "summary": "1-2 строки итога"
}
Правила: pass только при confidence >= ${REVIEW_CONFIDENCE_THRESHOLD}. Если сомневаешься — verdict "fail". Не пиши текст вне JSON.`

/** Промпт ревьюеру: он видит ТОЛЬКО diff + task brief + вывод verify. */
export function buildVerdictReviewerPrompt(diff: string, brief: string, verifyReport: string): string {
  return `Ты — независимый ревьюер перед коммитом. Твой контекст свежий: ты НЕ писал этот код.
Оцени ТОЛЬКО предоставленные изменения. Не проси дополнительный контекст — работай с тем, что есть.

ЗАДАЧА (task brief):
${brief || '(не указана)'}

РЕЗУЛЬТАТ ВЕРИФИКАЦИИ:
${verifyReport || '(нет данных)'}

DIFF ИЗМЕНЕНИЙ:
\`\`\`diff
${diff}
\`\`\`

Ищи: баги, регрессии, дыры безопасности, несоответствие задаче, отсутствие проверок.
${REVIEW_VERDICT_INSTRUCTION}`
}

/** Промпт фиксеру (executor, свежий контекст — НЕ реализатор и НЕ ревьюер). */
export function buildFixerPrompt(brief: string, diff: string, issues: string[], verifyReport: string): string {
  const issueList = issues.length ? issues.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(см. вывод verify и diff)'
  return `Ты — фиксер со свежим контекстом. Ревью перед коммитом НЕ прошло. Почини ТОЛЬКО перечисленные проблемы минимальными правками, не расширяя scope.

ЗАДАЧА:
${brief || '(не указана)'}

ПРОБЛЕМЫ ОТ ГЕЙТА (verify + ревьюер):
${issueList}

РЕЗУЛЬТАТ ВЕРИФИКАЦИИ:
${verifyReport}

ТЕКУЩИЙ DIFF:
\`\`\`diff
${diff}
\`\`\`

Правила: минимальные точечные правки, сохраняй стиль, не глуши ошибки заглушками. После правок ОБЯЗАТЕЛЬНО прогони те же verify-команды и убедись, что новых ошибок нет.`
}

/** Человекочитаемый отчёт verify для ревьюера/фиксера. */
export function formatVerifyReport(runs: VerifyRun[], gate: VerifyGate): string {
  if (!gate.ranAny) return 'Верификация не запускалась.'
  const lines = runs.map(r => `- ${r.command}: exit ${r.exitCode ?? '?'}`)
  const blocking = gate.blocking.length
    ? `\nБлокирующие ошибки:\n${gate.blocking.map(b => `  • ${b}`).join('\n')}`
    : '\nБлокирующих ошибок нет.'
  return lines.join('\n') + blocking
}
