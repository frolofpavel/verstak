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
 * БЕЗОПАСНОСТЬ: исполняем в vm.createContext — ФРЕШ-контекст без process/require/fs/
 * global. Инъектим только read-only тулзы (через lookupHandler в хендлере) + log +
 * безопасные билтины. Таймаут на sync (vm option) И на async (Promise.race). Модель
 * угроз не нова: агент УЖЕ умеет run_command (любой код), здесь возможностей МЕНЬШЕ
 * (только чтение). Скрипт не может писать файлы/запускать команды.
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

  // Прокси тулз: считаем вызовы, прозрачно отдаём результат.
  const tools: Record<string, unknown> = {}
  for (const [name, fn] of Object.entries(opts.tools)) {
    tools[name] = async (args: Record<string, unknown>) => {
      toolCalls++
      return fn(args ?? {})
    }
  }

  // Фреш-контекст: только то, что положили. process/require/fs/global недоступны.
  const sandbox = {
    tools,
    log,
    console: { log },
    JSON, Math, Object, Array, String, Number, Boolean, Promise, Date, RegExp, Map, Set,
  }
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
