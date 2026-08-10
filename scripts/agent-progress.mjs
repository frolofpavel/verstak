// V2-4 (agent-runtime-v2.md §4) — признак прогресса прогона и детект застоя.
//
// Почему .mjs, а не .ts: тот же модуль обязан работать в scripts/verstak-cli.mjs,
// который исполняется без сборки и без Electron и потому не может импортировать
// из electron/. Десктопный путь берёт этот же файл через electron/ai/progress.ts,
// типы — из соседнего .d.mts. Один файл, две точки входа; дубля логики нет.
// Ровно та же схема, что у V2-3 (scripts/agent-completion-gate.mjs).
//
// ── Одно правило вместо трёх ────────────────────────────────────────────────
// Постановка называет три симптома застоя: повтор того же вызова с теми же
// аргументами, N ходов без нового факта, циклическое чтение одних файлов. Это
// не три механизма, а три вида ОДНОГО события: ход не добавил прогону ничего,
// чего в нём ещё не было. Поэтому правило здесь одно:
//
//   ход даёт прогресс ⟺ он породил хотя бы один факт, не встречавшийся в прогоне.
//
// Факт — пара «что спросили → что ответили»: `имя : дайджест(аргументы) :
// дайджест(результат)`. Повторный вызов с теми же аргументами и тем же ответом
// даёт тот же ключ (симптом 1); перечитывание неизменившегося файла — тот же
// ключ (симптом 3); ход, не породивший ни одного нового ключа, — симптом 2.
// Красный тест, ставший зелёным, ключ МЕНЯЕТ — это и есть новый факт.
//
// ── Направление ошибки выбрано намеренно ────────────────────────────────────
// Инструмент, чей ответ меняется сам по себе (`date`, вывод со случайным id),
// будет выглядеть прогрессом вечно, и застой на нём НЕ будет пойман. Это
// осознанная сторона: пропустить застой — потерять ходы, ошибочно объявить
// застой на работающем агенте — оборвать живую работу. Вторая цена выше.
// Волатильные куски ответа (время, длительности, epoch, адреса) нормализуются
// ниже — без этого самый частый цикл, повторный прогон тестов с плавающей
// длительностью, читался бы как бесконечный прогресс.

/** Ходов подряд без нового факта, после которых прогон считается вставшим. */
export const STAGNATION_TURNS = 3
/** Сколько раз подсказываем сменить стратегию прежде чем честно остановиться. */
export const MAX_STRATEGY_NUDGES = 1

const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_directory', 'get_project_map', 'search_project', 'grep_project',
  'find_files', 'read_many_files', 'check_diagnostics', 'lsp_definition', 'lsp_references',
])

// Куски ответа, меняющиеся сами по себе. Нормализуются ДО дайджеста, иначе
// «npm run test:fast» с строкой длительности каждый раз выглядит новым фактом.
const VOLATILE = [
  [/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<ts>'],
  [/\b\d+(?:[.,]\d+)?\s*(?:ms|s|sec|мс|сек)\b/gi, '<dur>'],
  [/\b0x[0-9a-f]{4,}\b/gi, '<addr>'],
  [/\b\d{9,}\b/g, '<num>'],
]

function normalize(text) {
  let out = String(text ?? '')
  for (const [re, to] of VOLATILE) out = out.replace(re, to)
  return out
}

/** FNV-1a: ключи должны быть короткими — они копятся на весь прогон. */
function digest(value) {
  const text = normalize(typeof value === 'string' ? value : JSON.stringify(value ?? null))
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/**
 * Дайджест ОДНОГО наблюдения — что инструмент увидел, с нормализацией волатильного.
 * Экспортируется ради Д4 (electron/ai/loop-detect.ts): подпись безаргументного
 * вызова строится из наблюдения, и нормализация обязана быть той же самой —
 * иначе страница с часами выглядела бы вечно новой для одного механизма и
 * повторяющейся для другого.
 */
export function observationDigest(value) {
  return digest(value)
}

/** Ключ факта одного вызова: что спросили → что ответили. */
export function factKey(call) {
  const name = String(call?.name ?? 'unknown')
  const outcome = call?.error ? `!${call.error}` : call?.result
  return `${name}:${digest(call?.args ?? null)}:${digest(outcome)}`
}

/** Подпись вызова без ответа — ею различается «повтор того же вызова». */
export function callKey(call) {
  return `${String(call?.name ?? 'unknown')}:${digest(call?.args ?? null)}`
}

export function createProgressState() {
  return { facts: new Set(), staleTurns: 0, window: [], strategyNudges: 0 }
}

/**
 * Учесть ход. calls — вызовы хода с их результатами:
 * `{ name, args, result, error }`. Возвращает, был ли прогресс.
 */
export function recordTurn(state, calls) {
  const list = Array.isArray(calls) ? calls : []
  const fresh = []
  for (const call of list) {
    const key = factKey(call)
    if (!state.facts.has(key)) {
      state.facts.add(key)
      fresh.push(key)
    }
  }
  // Ход БЕЗ вызовов инструментов прогрессом не считается: это чистый текст,
  // а работа продукта измеряется действиями. Но и застоем сам по себе он не
  // является — счётчик просто не сбрасывается.
  const progressed = fresh.length > 0
  state.staleTurns = progressed ? 0 : state.staleTurns + 1
  state.window.push({ calls: list.map(callKey), readOnly: list.length > 0 && list.every(c => READ_ONLY_TOOLS.has(String(c?.name))) })
  if (state.window.length > STAGNATION_TURNS) state.window.shift()
  return { progressed, newFacts: fresh.length }
}

/**
 * Встал ли прогон, и в чём это выражается. Причина нужна человеку и модели:
 * «повторяешь один вызов» и «читаешь по кругу» лечатся по-разному.
 */
export function detectStagnation(state) {
  if (!state || state.staleTurns < STAGNATION_TURNS) {
    return { stagnant: false, reason: null, staleTurns: state?.staleTurns ?? 0 }
  }
  const window = state.window ?? []
  const seen = new Map()
  for (const turn of window) for (const key of turn.calls) seen.set(key, (seen.get(key) ?? 0) + 1)
  const repeated = [...seen.values()].some(count => count >= 2)
  const allReads = window.length > 0 && window.every(turn => turn.readOnly)
  const reason = repeated ? 'repeat-call' : allReads ? 'reread-loop' : 'no-new-facts'
  return { stagnant: true, reason, staleTurns: state.staleTurns }
}

const REASON_TEXT = {
  'repeat-call': 'ты повторяешь один и тот же вызов с теми же аргументами и получаешь тот же ответ',
  'reread-loop': 'ты по кругу перечитываешь одни и те же файлы и не узнаёшь ничего нового',
  'no-new-facts': 'последние ходы не добавили ни одного нового факта',
}

/** Подсказка сменить стратегию — один раз перед честной остановкой. */
export function buildStrategyChangeHint(reason, staleTurns) {
  return [
    `Стоп: ${REASON_TEXT[reason] ?? REASON_TEXT['no-new-facts']} (${staleTurns} хода подряд без продвижения).`,
    'Прежний подход не работает — повторять его смысла нет. Сделай одно из трёх:',
    '1) сформулируй другую гипотезу и проверь её другим способом (другой файл, другая команда, другой инструмент);',
    '2) позови oracle с конкретным вопросом, если не хватает знания;',
    '3) если продвинуться нечем — скажи прямо, что именно блокирует, и остановись.',
  ].join('\n')
}

/** Честная остановка: что человек увидит вместо тихого выгорания бюджета. */
export function stagnationStopNote(reason, staleTurns) {
  return `⛔ Работа остановлена без результата: ${REASON_TEXT[reason] ?? REASON_TEXT['no-new-facts']} (${staleTurns} хода подряд), и смена подхода не помогла. Ходы дальше тратились бы впустую — нужна ваша подсказка или уточнение задачи.`
}
