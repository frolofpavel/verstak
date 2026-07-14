// OpenAI Codex OAuth провайдер (2.0.4, Experimental). НАШ agent-loop поверх
// подписки ChatGPT/Codex через direct-OAuth (endpoint chatgpt.com/backend-api/codex).
// Формат подтверждён live-смоуком (ground truth Codex 0.144.1). Режим — API.
//
// Собирает tested-модули: credential-store (auth/refresh) + request-builder (headers/body)
// + inline SSE-стриминг с Hermes-фиксом (tool-calls из output_item.done, не из финального
// output). originator честный ('verstak'), НЕ выдаём себя за codex_cli_rs.

import { randomUUID } from 'crypto'
import type { ChatMessage, ChatEvent, ToolDefinition, ToolResult, ChatProvider, UsageDelta } from '../types'
import { createCodexCredentialStore } from './credential-store'
import { buildHeaders, buildBody, userMessage, functionTool, functionCallOutput, type ResponseItem } from './request-builder'

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const WIRE_VERSION = '0.144.1'

/**
 * Маппинг истории Verstak (ChatMessage[] + отдельные toolResults текущего хода) в
 * Responses input[]. system → instructions (не в input). store:false → шлём всю
 * цепочку каждый ход. Экспортируется для юнит-теста (чистая функция).
 */
export function toResponseInput(
  messages: ChatMessage[],
  toolResults?: ToolResult[]
): { input: ResponseItem[]; instructions: string } {
  const instructionParts: string[] = []
  const input: ResponseItem[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) instructionParts.push(m.content)
      continue
    }
    if (m.role === 'assistant') {
      if (m.content) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.args ?? {}) })
      }
      continue
    }
    // user
    for (const tr of m.toolResults ?? []) {
      input.push(functionCallOutput(tr.id, toolResultText(tr)))
    }
    if (m.content) input.push(userMessage(m.content))
  }
  // toolResults текущего хода (отдельный параметр send) — в конец цепочки
  for (const tr of toolResults ?? []) {
    input.push(functionCallOutput(tr.id, toolResultText(tr)))
  }
  return { input, instructions: instructionParts.join('\n\n') || 'You are a coding assistant.' }
}

function toolResultText(tr: ToolResult): string {
  if (tr.error) return `Error: ${tr.error}`
  return typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result)
}

function mapUsage(u: unknown, model: string): UsageDelta | null {
  if (!u || typeof u !== 'object') return null
  const x = u as Record<string, any>
  return {
    inputTokens: x.input_tokens ?? 0,
    outputTokens: x.output_tokens ?? 0,
    cachedInputTokens: x.input_tokens_details?.cached_tokens ?? 0,
    model,
  }
}

function safeJsonArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {}
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
}

/** Провайдер. threadId стабилен на инстанс (один диалог); sessionId — на каждый send. */
export function createCodexOAuthProvider(opts: { model: string; appVersion?: string; codexHome?: string | null }): ChatProvider {
  const store = createCodexCredentialStore(opts.codexHome)
  const threadId = randomUUID()

  async function post(input: ResponseItem[], instructions: string, tools: ToolDefinition[], signal?: AbortSignal): Promise<Response> {
    const fnTools = tools.map(t => functionTool(t.name, t.description, t.parameters))
    const body = buildBody({ model: opts.model, instructions, input, tools: fnTools })
    let creds = await store.getCredentials()
    const send = (c: { accessToken: string; accountId: string }) => fetch(RESPONSES_URL, {
      method: 'POST', signal,
      headers: buildHeaders({ accessToken: c.accessToken, accountId: c.accountId, version: WIRE_VERSION, appVersion: opts.appVersion, sessionId: randomUUID(), threadId }),
      body: JSON.stringify(body),
    })
    let res = await send(creds)
    if (res.status === 401) {  // реактивный refresh + один retry (ground truth D)
      creds = await store.forceRefresh()
      res = await send(creds)
    }
    return res
  }

  return {
    id: 'openai-codex-oauth',
    name: 'OpenAI Codex OAuth',
    models: [opts.model],
    async *send(messages: ChatMessage[], tools: ToolDefinition[], toolResults?: ToolResult[], signal?: AbortSignal): AsyncGenerator<ChatEvent> {
      const { input, instructions } = toResponseInput(messages, toolResults)
      let res: Response
      try {
        res = await post(input, instructions, tools, signal)
      } catch (e) {
        yield { type: 'error', message: `Codex OAuth: ${e instanceof Error ? e.message : String(e)}` }
        return
      }
      // Срез 6: если refresh прошёл, но записать обновлённый auth.json не удалось —
      // сессия живёт на токенах в памяти, но пользователь ДОЛЖЕН узнать (в упакованном
      // .exe консоли нет, console.warn был бы немым). Показываем в Timeline.
      const persistWarning = store.takePersistWarning()
      if (persistWarning) {
        yield { type: 'agent-progress', phase: 'model', status: 'error', title: 'Codex: токен не сохранён', detail: persistWarning }
      }
      if (!res.ok || !res.body) {
        const t = res.ok ? '(нет тела)' : await res.text().catch(() => '')
        yield { type: 'error', message: `Codex OAuth HTTP ${res.status}: ${t.slice(0, 300)}` }
        return
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const chunks = buf.split('\n\n')
          buf = chunks.pop() ?? ''
          for (const chunk of chunks) {
            const dataLine = chunk.split('\n').find(l => l.startsWith('data:'))
            if (!dataLine) continue
            const payload = dataLine.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            let ev: any
            try { ev = JSON.parse(payload) } catch { continue }
            switch (ev.type) {
              case 'response.output_text.delta':
                if (ev.delta) yield { type: 'text', text: String(ev.delta) }
                break
              case 'response.reasoning_text.delta':
              case 'response.reasoning_summary_text.delta':
                if (ev.delta) yield { type: 'thought', text: String(ev.delta) }
                break
              case 'response.output_item.done':
                // Hermes-фикс: tool-calls берём отсюда (не из финального output).
                if (ev.item?.type === 'function_call') {
                  yield { type: 'tool-call', call: { id: ev.item.call_id, name: ev.item.name, args: safeJsonArgs(ev.item.arguments) } }
                }
                break
              case 'response.completed': {
                const usage = mapUsage(ev.response?.usage, opts.model)
                if (usage) yield { type: 'usage', usage }
                yield { type: 'done' }
                return
              }
              case 'response.failed':
              case 'response.incomplete':
                yield { type: 'error', message: `Codex OAuth: ${ev.type} ${JSON.stringify(ev.response?.status_details ?? ev.error ?? '')}`.slice(0, 300) }
                return
              case 'error':
                yield { type: 'error', message: `Codex OAuth error: ${JSON.stringify(ev).slice(0, 300)}` }
                return
            }
          }
        }
      } finally {
        reader.releaseLock?.()
      }
      // стрим кончился без completed
      yield { type: 'done' }
    },
  }
}
