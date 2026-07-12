// Построение headers и body для POST chatgpt.com/backend-api/codex/responses.
// Это ChatGPT backend (Responses API), к которому Verstak ходит по OAuth-токену
// Codex-аккаунта. Чистая логика: без сети и fs — только сборка запроса.

/** Уровень reasoning для Responses API (o-модели). */
export interface Reasoning {
  effort?: 'minimal' | 'low' | 'medium' | 'high'
  summary?: 'auto' | 'concise' | 'detailed'
}

/** Один function-tool в формате Responses API (плоский, не вложенный в {function:...}). */
export interface FunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: true
}

/** Пользовательское сообщение как элемент input[]. */
export interface UserMessageItem {
  type: 'message'
  role: 'user'
  content: Array<{ type: 'input_text'; text: string }>
}

/** Результат вызова функции, скармливаемый обратно модели. */
export interface FunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

// Элемент истории input[]. Помимо наших хелперов сюда попадают сырые элементы
// (assistant-сообщения, function_call, reasoning) — их принимаем через escape-хатч.
export type ResponseItem =
  | UserMessageItem
  | FunctionCallOutputItem
  | { type: string; [key: string]: unknown }

export interface BuildHeadersOpts {
  accessToken: string
  accountId?: string
  version?: string
  appVersion?: string
  sessionId?: string
  threadId?: string
}

// Собираем HTTP-заголовки. Семантически обязательны только Authorization и
// ChatGPT-Account-ID; остальное — телеметрия/трейсинг, добавляем если передано.
export function buildHeaders(opts: BuildHeadersOpts): Record<string, string> {
  const { accessToken, accountId, version, appVersion, sessionId, threadId } = opts
  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    // Честный идентификатор клиента — НЕ выдаём себя за codex_cli_rs.
    originator: 'verstak',
    'User-Agent': 'Verstak/' + (appVersion || '0.0.0')
  }
  if (accountId) headers['ChatGPT-Account-ID'] = accountId
  if (version) headers['version'] = version
  if (sessionId) headers['session-id'] = sessionId // через дефис, как ждёт backend
  if (threadId) {
    headers['thread-id'] = threadId
    headers['x-client-request-id'] = threadId
  }
  return headers
}

export interface BuildBodyOpts {
  model: string
  instructions: string
  input: ResponseItem[]
  tools?: FunctionTool[]
  reasoning?: Reasoning | null
}

export interface ResponsesBody {
  model: string
  instructions: string
  input: ResponseItem[]
  tools: FunctionTool[]
  tool_choice: 'auto'
  parallel_tool_calls: false
  reasoning: Reasoning | null
  store: false
  stream: true
  include: string[]
}

// Тело запроса в форме Responses API. store:false — не хранить на стороне OpenAI;
// stream:true — SSE. encrypted_content включаем только когда есть reasoning.
export function buildBody(opts: BuildBodyOpts): ResponsesBody {
  const { model, instructions, input, tools, reasoning } = opts
  return {
    model,
    instructions,
    input,
    tools: tools ?? [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: reasoning ?? null,
    store: false,
    stream: true,
    include: reasoning ? ['reasoning.encrypted_content'] : []
  }
}

export function userMessage(text: string): UserMessageItem {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
}

export function functionTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>
): FunctionTool {
  return { type: 'function', name, description, parameters, strict: true }
}

export function functionCallOutput(callId: string, output: string): FunctionCallOutputItem {
  return { type: 'function_call_output', call_id: callId, output }
}
