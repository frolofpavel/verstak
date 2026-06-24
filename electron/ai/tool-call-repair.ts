/**
 * T1.5 — восстановление tool-call'ов, которые слабые/RU-модели отдают ТЕКСТОМ
 * вместо структурного `tool_calls`. Без этого вызов падает в чат прозой и тулза
 * не исполняется → локальный Ollama и GigaChat-класс непригодны как агенты.
 *
 * Чистая логика. Вызывается из openai-compat ТОЛЬКО когда структурных tool_calls
 * в ответе не было (сильные провайдеры шлют structured и сюда не попадают —
 * дефолтный путь не ломается). Поддержанные форматы:
 *  1. Qwen/Hermes/many:  <tool_call>{"name","arguments"}</tool_call>
 *  2. function-тег:       <function=NAME>{args}</function>
 *  3. Harmony (gpt-oss):  to=functions.NAME … <|message|>{args}<|call|>
 *  4. Mistral:            [TOOL_CALLS][ {"name","arguments"} ]
 *  5. голый/огороженный JSON: {"tool"|"name", "parameters"|"arguments"}
 */

export interface RepairedCall {
  name: string
  args: Record<string, unknown>
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Имя вызова из обёртки: name/tool/function/tool_name. */
function pickName(obj: Record<string, unknown>): string | null {
  for (const k of ['name', 'tool', 'function', 'tool_name']) {
    if (typeof obj[k] === 'string' && obj[k]) return obj[k] as string
  }
  return null
}

/** Аргументы из обёртки (arguments/parameters/args/input) или сам объект. */
function pickArgs(obj: Record<string, unknown>): Record<string, unknown> {
  for (const k of ['arguments', 'parameters', 'args', 'input']) {
    const v = obj[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    if (typeof v === 'string') {
      const parsed = safeJson(v)
      if (parsed) return parsed
    }
  }
  return {}
}

/** Первый сбалансированный {…}-объект в тексте (учёт строк/эскейпов). */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export function parseTextToolCalls(text: string): RepairedCall[] {
  const s = String(text ?? '')
  if (!s) return []
  const out: RepairedCall[] = []

  // 4. Mistral [TOOL_CALLS][ … ] — массив {name, arguments}
  const mistral = s.match(/\[TOOL_CALLS\]\s*(\[[\s\S]*\])/)
  if (mistral) {
    try {
      const arr = JSON.parse(mistral[1])
      if (Array.isArray(arr)) {
        for (const c of arr) {
          if (c && typeof c === 'object') {
            const name = pickName(c as Record<string, unknown>)
            if (name) out.push({ name, args: pickArgs(c as Record<string, unknown>) })
          }
        }
      }
    } catch { /* битый — пропускаем */ }
    if (out.length) return out
  }

  // 1. <tool_call>{name,arguments}</tool_call>
  for (const m of s.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    const obj = safeJson(m[1])
    if (obj) {
      const name = pickName(obj)
      if (name) out.push({ name, args: pickArgs(obj) })
    }
  }
  if (out.length) return out

  // 2. <function=NAME>{args}</function> — имя в теге, тело = args
  for (const m of s.matchAll(/<function=([\w./-]+)\s*>\s*([\s\S]*?)\s*<\/function>/g)) {
    const name = m[1].split('.').pop() || m[1]
    const body = m[2].trim()
    out.push({ name, args: (body ? safeJson(body) : {}) || {} })
  }
  if (out.length) return out

  // 3. Harmony: to=functions.NAME … <|message|>{args}<|call|>
  for (const m of s.matchAll(/to=functions\.([\w.-]+)[\s\S]*?<\|message\|>\s*([\s\S]*?)\s*<\|call\|>/g)) {
    const name = m[1].split('.').pop() || m[1]
    out.push({ name, args: safeJson(m[2]) || {} })
  }
  if (out.length) return out

  // 5. голый/огороженный JSON {name|tool, parameters|arguments}
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  const json = extractFirstJsonObject(fence ? fence[1] : s)
  if (json) {
    const obj = safeJson(json)
    if (obj) {
      const name = pickName(obj)
      if (name) out.push({ name, args: pickArgs(obj) })
    }
  }
  return out
}
