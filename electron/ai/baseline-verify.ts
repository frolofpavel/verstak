/**
 * Baseline-aware verification (Этап 4, Блок F).
 *
 * Проблема: recipe с `verify` не должен блокировать задачу из-за КРАСНОГО, который
 * был в проекте ДО правки (pre-existing red — не вина текущего изменения). Блокировать
 * должны только НОВЫЕ ошибки/деградации.
 *
 * Решение (минимальное, in-memory, без БД): при старте recipe снимаем снапшот вывода
 * verify (baseline), после правки снимаем ещё раз и сравниваем по нормализованным
 * сигнатурам ошибок. Новые сигнатуры → блок. Пропавшие → «починено». Общие → pre-existing.
 *
 * Переиспользует форматы существующих primitives: tsc / check_diagnostics
 * (`path:line:col — TSxxxx: msg`) и vitest (`FAIL …`, `× …`). Своей системы тестов
 * не заводит — только парсит их вывод.
 */

/** Строка похожа на пустую/успех — не ошибка. */
function isNoise(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (t.startsWith('✅')) return true
  if (/нет ошибок/i.test(t)) return true
  if (/^\s*(PASS|✓|√)\b/.test(t)) return true
  if (/\b(fail|failed|error|errors|exception)s?\s*0\b/i.test(t)) return true
  if (/\b0\s*(fail|failed|error|errors|exception)s?\b/i.test(t)) return true
  return false
}

/** Нормализация волатильных частей строки: пути → basename, числовые серии → #. */
function normalize(s: string): string {
  return s
    .replace(/\\/g, '/')
    .replace(/\d+/g, '#')       // line/col/counts/тайминги — волатильны
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || p
}

/**
 * Извлекает нормализованные сигнатуры ошибок из вывода verify-команды.
 * Сигнатура стабильна к сдвигу строк (line/col отброшены) — правка выше по файлу
 * не превращает старую ошибку в «новую».
 */
export function extractErrorSignatures(output: string): string[] {
  const out = new Set<string>()
  for (const rawLine of (output ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (isNoise(line)) continue

    // TypeScript: `file(line,col): error TSxxxx: msg` ИЛИ `file:line:col — TSxxxx: msg`
    const ts = line.match(/^(.+?)[([:](\d+)[,:](\d+)\)?\s*[—:-]*\s*(?:error\s+)?(TS\d+)\s*:\s*(.+)$/i)
    if (ts) {
      out.add(`ts:${basename(ts[1])}:${ts[4].toUpperCase()}:${normalize(ts[5])}`)
      continue
    }

    // vitest/jest FAIL: `FAIL tests/x.test.ts > name` или `× name` / `✗ name`
    const fail = line.match(/^(?:FAIL|×|✗|✖|❯)\s+(.+)$/)
    if (fail) {
      out.add(`test:${normalize(fail[1])}`)
      continue
    }

    // Обобщённо: строки с error/failed (напр. runtime/ESLint) — нормализуем целиком.
    if (/\b(error|failed|exception)\b/i.test(line)) {
      out.add(`gen:${normalize(line)}`)
    }
  }
  return [...out]
}

export interface BaselineDiff {
  /** Сигнатуры, которых НЕ было в baseline → появились после правки. Блокируют. */
  newErrors: string[]
  /** Были и до, и после — pre-existing red, НЕ блокируют. */
  preExisting: string[]
  /** Были в baseline, исчезли после правки — починены. */
  resolved: string[]
  /** true, если есть новые ошибки. */
  blocked: boolean
}

/**
 * Сравнивает вывод verify до и после правки. Блокирует только новые сигнатуры.
 */
export function diffAgainstBaseline(before: string, after: string): BaselineDiff {
  const beforeSet = new Set(extractErrorSignatures(before))
  const afterSet = extractErrorSignatures(after)
  const afterUniq = new Set(afterSet)

  const newErrors: string[] = []
  const preExisting: string[] = []
  for (const sig of afterUniq) {
    if (beforeSet.has(sig)) preExisting.push(sig)
    else newErrors.push(sig)
  }
  const resolved = [...beforeSet].filter(sig => !afterUniq.has(sig))

  return { newErrors, preExisting, resolved, blocked: newErrors.length > 0 }
}

/**
 * In-memory снапшоты baseline per-run/per-command. Без БД и долгого хранения —
 * живёт на время прогона recipe. Ключ: `${runId}\u0000${command}`.
 */
export class BaselineStore {
  private map = new Map<string, string>()

  private key(runId: string, command: string): string {
    return `${runId}\u0000${command}`
  }

  /** Снять baseline (вывод verify ДО правки). */
  snapshot(runId: string, command: string, output: string): void {
    this.map.set(this.key(runId, command), output ?? '')
  }

  /** Есть ли baseline для этого run+command. */
  has(runId: string, command: string): boolean {
    return this.map.has(this.key(runId, command))
  }

  /**
   * Сравнить текущий вывод с baseline. null, если baseline не снимался
   * (нечего сравнивать — вызывающий решает как трактовать).
   */
  compare(runId: string, command: string, afterOutput: string): BaselineDiff | null {
    const before = this.map.get(this.key(runId, command))
    if (before === undefined) return null
    return diffAgainstBaseline(before, afterOutput)
  }

  /** Очистить снапшоты прогона (по завершении recipe). */
  clear(runId: string): void {
    const prefix = `${runId}\u0000`
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k)
  }
}
