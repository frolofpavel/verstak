/**
 * T1.4 PTC (Programmatic Tool Calling) — движок исполнения скрипта агента.
 *
 * Идея (из исследования; Anthropic PTC / конкуренты): вместо десятка round-trip'ов
 * «вызов тулзы → результат в контекст → следующий вызов» агент пишет ОДИН скрипт,
 * который оркестрирует тулзы программно (циклы, фильтры, агрегация), а в контекст
 * попадает только итог (log/return). На read-тяжёлых задачах («прочитай 30 файлов,
 * собери все TODO») это кратно меньше входных токенов → дешевле (РФ-козырь «Opus
 * на дешёвой»).
 *
 * БЕЗОПАСНОСТЬ: исполняем в vm.createContext с инъекцией ТОЛЬКО tools+log (без хост-
 * конструкторов — см. хардинг ниже), таймаут на sync (vm option) И на async (race).
 * ВАЖНО: vm — НЕ граница безопасности (доки Node): из песочницы возможен побег через
 * .constructor живых хост-объектов. Поэтому НАСТОЯЩИЙ контроль не в vm, а в том, что
 * execute_code гейтится КАК КОМАНДА (trust = run_command: confirm в ask, block в plan)
 * в execute-code.ts + mode-policy. Т.е. execute_code не даёт привилегий БОЛЬШЕ, чем
 * уже имеющийся у агента run_command. Хардинг vm (null-прото инъекций, без хост-
 * интринзиков) поднимает планку, но гарантией изоляции не является.
 */

import vm from 'node:vm'

export interface PtcRunResult {
  output: string
  toolCalls: number
  error?: string
}

/** Тулзы, доступные внутри PTC-скрипта — строго read-only (no write/command). */
export const PTC_READONLY_TOOLS = [
  'read_file',
  'list_directory',
  'search_project',
  'find_files',
  'get_project_map',
] as const

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_OUTPUT = 20_000

export async function runPtcCode(opts: {
  code: string
  /** name → async-функция тулзы (в хендлере — обёртка над lookupHandler). */
  tools: Record<string, (args: Record<string, unknown>) => Promise<string>>
  timeoutMs?: number
  maxOutput?: number
}): Promise<PtcRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT
  let output = ''
  let toolCalls = 0
  let capped = false

  const log = (...args: unknown[]) => {
    if (capped) return
    output += args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ') + '\n'
    if (output.length > maxOutput) {
      output = output.slice(0, maxOutput) + '\n…[вывод обрезан]'
      capped = true
    }
  }

  // ХАРДИНГ ПОБЕГА: НЕ инъектируем хост-реалм Object/Array/Promise/JSON/Math/… —
  // vm-контекст имеет СВОИ интринзики (код использует их нативно). Инъекция живого
  // хост-объекта/функции даёт мост в реалм Node: injected.constructor.constructor ===
  // хостовый Function → Function('return process')() уводит из песочницы. Поэтому
  // кладём ТОЛЬКО tools+log, c null-прототипом (чтобы .constructor не вёл на host
  // Function), а тулзы оборачиваем так, чтобы хостовая ошибка не утекла в vm.
  // ВАЖНО: vm — НЕ граница безопасности (доки Node). Настоящий контроль — execute_code
  // гейтится КАК КОМАНДА (trust run_command, confirm в ask) в хендлере + mode-policy;
  // хардинг лишь поднимает планку, гарантией не является.
  Object.setPrototypeOf(log, null)
  const tools: Record<string, unknown> = Object.create(null)
  for (const [name, fn] of Object.entries(opts.tools)) {
    const wrapped = async (args: Record<string, unknown>) => {
      toolCalls++
      try { return await fn(args ?? {}) }
      catch (e) { return `[tool error: ${e instanceof Error ? e.message : String(e)}]` }
    }
    Object.setPrototypeOf(wrapped, null)
    tools[name] = wrapped
  }
  const consoleObj: Record<string, unknown> = Object.create(null)
  consoleObj.log = log
  const sandbox = { tools, log, console: consoleObj }
  const wrapped = `(async () => {\n${opts.code}\n})()`

  try {
    const ctx = vm.createContext(sandbox)
    // timeout здесь ловит СИНХРОННЫЙ зацикл (while(true)); async-зависание — race ниже.
    const ran = vm.runInContext(wrapped, ctx, { timeout: timeoutMs }) as Promise<unknown>
    const result = await Promise.race([
      Promise.resolve(ran),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`PTC таймаут (${timeoutMs}мс)`)), timeoutMs)),
    ])
    // Код вернул значение, но ничего не логировал — покажем возврат.
    if (result !== undefined && output === '') log(result)
    return { output: output.trim(), toolCalls }
  } catch (e) {
    return { output: output.trim(), toolCalls, error: e instanceof Error ? e.message : String(e) }
  }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}
