/**
 * V2-3 (agent-runtime-v2.md §4) — completion gate на обычном чат-пути.
 *
 * Механизм «не выпускать финал без доказательства» в продукте был, но включался
 * только под recipe (`recipe.reviewer.required`, см. review-gate.ts). На обычном
 * пути агент мог записать файлы и объявить работу сделанной, ни разу её не
 * проверив. Baseline Arena 09.08 показал цену: слабые классы — правка связанных
 * файлов (1/3) и регрессия от собственной правки (2/3).
 *
 * Правило: были ПРИНЯТЫЕ записи в файлы и не было ни одной проверки за прогон —
 * финал не выпускаем, возвращаем модели ход с требованием доказательства.
 * Bounded по построению: после COMPLETION_GATE_MAX_NUDGES попыток прогон
 * закрывается честной формулировкой «сделано, не проверено» — видимой человеку,
 * а не выдачей работы за проверенную. Бесконечного цикла не образуется.
 *
 * Промпт не трогаем (§4.1 system-layer — только по решению Павла): гейт живёт в
 * рантайме, потому что просьба в промпте — это то, что уже не сработало.
 */
import type { ToolCall } from './types'

/** Сколько раз возвращаем ход перед честным unverified-финалом. */
export const COMPLETION_GATE_MAX_NUDGES = 2

/** Инструменты, сам вызов которых является проверкой. */
const VERIFICATION_TOOLS = new Set(['check_diagnostics', 'attest_verification', 'review_before_commit'])

/**
 * Команды-проверки: тест, тайпчек, сборка, линт. Держим узко и по границам слов —
 * иначе «ls -la» и «cat test-plan.md» сойдут за доказательство, и гейт станет
 * декоративным.
 */
const VERIFICATION_COMMAND_RE = /\b(test|tests|test:\S+|type|typecheck|tsc|build|lint|vitest|jest|pytest|mypy|cargo\s+test|go\s+test)\b/i

export function isVerificationToolCall(call: Pick<ToolCall, 'name' | 'args'>): boolean {
  if (VERIFICATION_TOOLS.has(call.name)) return true
  if (call.name !== 'run_command') return false
  const command = typeof call.args?.command === 'string' ? call.args.command : ''
  return VERIFICATION_COMMAND_RE.test(command)
}

export type CompletionGateDecision = 'allow' | 'retry' | 'finish-unverified'

export function decideCompletionGate(input: {
  acceptedWrites: number
  verifications: number
  nudges: number
}): CompletionGateDecision {
  // Читающий прогон доказывать нечего — гейт не мешает работать.
  if (input.acceptedWrites <= 0) return 'allow'
  if (input.verifications > 0) return 'allow'
  if (input.nudges >= COMPLETION_GATE_MAX_NUDGES) return 'finish-unverified'
  return 'retry'
}

export function buildCompletionGateNudge(verifyCommands: string[]): string {
  const commands = verifyCommands.filter(Boolean).slice(0, 4)
  const how = commands.length
    ? `Проверить можно так: ${commands.map(c => `\`${c}\``).join(', ')}.`
    : 'Проверь тем, чем проверяется этот проект: тесты, тайпчек или сборка.'
  return [
    'Ты изменил файлы, но ни разу не проверил результат — работа не доказана.',
    how,
    'Выполни проверку и покажи её вывод. Если проверить нечем, скажи об этом прямо и назови причину.',
  ].join('\n')
}

/** Честная пометка для человека: работа сделана, но НЕ проверена. */
export function unverifiedWorkNote(fileCount: number): string {
  return `⚠️ Файлов изменено: ${fileCount}, но результат не проверен — тесты, тайпчек или сборка за этот прогон не запускались. Проверьте перед тем, как полагаться на изменения.`
}
