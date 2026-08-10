// V2-3 completion gate — ЕДИНСТВЕННЫЙ источник правила для обоих путей.
//
// Почему .mjs, а не .ts: этот модуль исполняет scripts/verstak-cli.mjs напрямую,
// без сборки и без Electron, поэтому он не может лежать в electron/. Десктопный
// путь берёт ЭТОТ ЖЕ файл через electron/ai/completion-gate.ts (типы — из
// соседнего .d.mts). Дубля логики нет — один файл и две точки входа.
//
// ИСПРАВЛЕНО 10.08 (правило §3.1 «запись, пережившая свою правду»): здесь стояло
// «логика здесь та же, и тождественность десктопной стережёт анти-дрейф-пин
// tests/scripts/cli-completion-gate.test.ts». Утверждение описывало ПЕРВУЮ
// редакцию правки, где модулей было два; 131e1a6 свёл их в один, названного пина
// не существует и существовать не должно — сверять нечему. Ложное обоснование
// опаснее ложного факта: оно объясняло, почему расхождения можно не бояться.
//
// Правило: были принятые записи в файлы и ни одной проверки за прогон — финал не
// выпускается, ход возвращается модели с требованием доказательства. Bounded:
// после COMPLETION_GATE_MAX_NUDGES попыток прогон закрывается честной пометкой
// «сделано, не проверено» вместо выдачи работы за проверенную.

export const COMPLETION_GATE_MAX_NUDGES = 2

// C2 (P6): mutation_check — проверка «тест не декоративный» тоже проверка.
const VERIFICATION_TOOLS = new Set(['check_diagnostics', 'attest_verification', 'review_before_commit', 'mutation_check'])
const VERIFICATION_COMMAND_RE = /\b(test|tests|test:\S+|type|typecheck|tsc|build|lint|vitest|jest|pytest|mypy|cargo\s+test|go\s+test)\b/i

export function isVerificationToolCall(call) {
  if (VERIFICATION_TOOLS.has(call?.name)) return true
  if (call?.name !== 'run_command') return false
  const command = typeof call?.args?.command === 'string' ? call.args.command : ''
  return VERIFICATION_COMMAND_RE.test(command)
}

export function decideCompletionGate({ acceptedWrites, verifications, nudges }) {
  if (acceptedWrites <= 0) return 'allow'
  if (verifications > 0) return 'allow'
  if (nudges >= COMPLETION_GATE_MAX_NUDGES) return 'finish-unverified'
  return 'retry'
}

export function buildCompletionGateNudge(verifyCommands) {
  const commands = (verifyCommands ?? []).filter(Boolean).slice(0, 4)
  const how = commands.length
    ? `Проверить можно так: ${commands.map(c => `\`${c}\``).join(', ')}.`
    : 'Проверь тем, чем проверяется этот проект: тесты, тайпчек или сборка.'
  return [
    'Ты изменил файлы, но ни разу не проверил результат — работа не доказана.',
    how,
    'Выполни проверку и покажи её вывод. Если проверить нечем, скажи об этом прямо и назови причину.',
  ].join('\n')
}

export function unverifiedWorkNote(fileCount) {
  return `⚠️ Файлов изменено: ${fileCount}, но результат не проверен — тесты, тайпчек или сборка за этот прогон не запускались. Проверьте перед тем, как полагаться на изменения.`
}

/**
 * V3 (волна 2.6.0): ИТОГ ПРОВЕРОК ОДНОЙ СТРОКОЙ — положительная половина пары.
 *
 * До неё человек видел только отрицательную ноту («сделано, не проверено»), а
 * успешный случай не сообщал ничего: тишина одинаково означала и «проверок не
 * было», и «проверки прошли». Отсюда правило §3.1 наоборот — у сработавшего
 * ХОРОШЕГО пути тоже должен быть след, иначе доверять нечему.
 *
 * Строка собирается из ФАКТА прогона (что реально исполнилось и с каким кодом
 * возврата), а не из слов модели: «я всё проверил» доказательством не является.
 * Нет ни одной проверки → строки нет вовсе (её место занимает нота выше).
 */
export function verifiedWorkNote(checks, fileCount) {
  const list = (checks ?? []).filter(c => c && c.label)
  if (list.length === 0) return null
  const failed = list.filter(c => !c.ok)
  const names = list.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`).join(', ')
  const head = failed.length === 0
    ? `✅ Проверено: ${plural(list.length, 'пройдена', 'пройдены', 'пройдено')} ${list.length} ${plural(list.length, 'проверка', 'проверки', 'проверок')}`
    : `⚠️ Проверок: ${list.length}, из них не прошло ${failed.length}`
  const files = typeof fileCount === 'number' && fileCount > 0
    ? `; файлов изменено: ${fileCount}`
    : ''
  return `${head}${files}. ${names}`
}

function plural(n, one, few, many) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}
