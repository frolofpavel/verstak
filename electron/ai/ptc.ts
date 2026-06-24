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

  // ХАРДИНГ ПОБЕГА. vm — НЕ формальная граница безопасности (доки Node): любой ЖИВОЙ
  // хост-объект/функция, достижимая из кода, — мост в реалм Node через
  // .constructor.constructor === хостовый Function → Function('return process')().
  // Закрываем известные векторы:
  //  • НЕ инъектируем хост-интринзики (Object/Array/Promise/JSON/Math) — у vm-контекста
  //    свои, код пользуется ими нативно;
  //  • log/tools/console — null-прототип (.constructor === undefined);
  //  • тулзы возвращают vm-NATIVE Promise (конструктор Promise ИЗ контекста), а не
  //    host-Promise — иначе tools.x().then.constructor вёл бы на host Function
  //    (ревью фиксов 24.06: именно этот async-вектор оставался открыт).
  // Всё равно ОСНОВНОЙ контроль — гейтинг execute_code КАК КОМАНДЫ (trust = run_command,
  // confirm в ask) в хендлере + mode-policy: даже при гипотетическом побеге привилегий
  // не больше, чем у уже доступного агенту run_command. vm-хардинг — defense-in-depth.
  Object.setPrototypeOf(log, null)
  const consoleObj: Record<string, unknown> = Object.create(null)
  consoleObj.log = log
  const toolsObj: Record<string, unknown> = Object.create(null)
  const sandbox: Record<string, unknown> = { tools: toolsObj, log, console: consoleObj }
  const codeWrapped = `(async () => {\n${opts.code}\n})()`

  try {
    const ctx = vm.createContext(sandbox)
    // Конструктор Promise ИЗ vm-реалма → промисы тулз vm-native (их .then/.constructor
    // не выводят на host Function). toolsObj — живой объект из sandbox, заполняем ПОСЛЕ
    // createContext (vm видит свежие свойства) и ДО запуска кода.
    const VmPromise = vm.runInContext('Promise', ctx) as PromiseConstructor
    for (const [name, fn] of Object.entries(opts.tools)) {
      const wrappedTool = (args: Record<string, unknown>) => {
        toolCalls++
        let settle: (v: string) => void = () => {}
        const p = new VmPromise<string>(res => { settle = res })
        // .then(()=>fn()) — sync-throw тулзы становится rejection, не утекает в vm.
        Promise.resolve().then(() => fn(args ?? {})).then(
          v => settle(typeof v === 'string' ? v : safeStringify(v)),
          e => settle(`[tool error: ${e instanceof Error ? e.message : String(e)}]`)
        )
        return p
      }
      Object.setPrototypeOf(wrappedTool, null)
      toolsObj[name] = wrappedTool
    }
    // timeout здесь ловит СИНХРОННЫЙ зацикл (while(true)); async-зависание — race ниже.
    const ran = vm.runInContext(codeWrapped, ctx, { timeout: timeoutMs }) as Promise<unknown>
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
