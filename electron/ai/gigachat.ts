/**
 * GigaChat provider — Сбер. 152-ФЗ совместим.
 *
 * Особенности:
 *  1. Двухступенчатая auth: clientId + clientSecret → OAuth → access_token.
 *     Token кэшируется module-level до expiresAt - 60s.
 *  2. SSL: Сбер использует свой CA (Russian Trusted Root CA), не в Node trust store.
 *     ⚠️ ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ БЕЗОПАСНОСТИ: сейчас обходим через
 *     https.Agent({ rejectUnauthorized: false }) — TLS-сертификат сервера НЕ
 *     проверяется, теоретически возможен MITM на пути до GigaChat. Это
 *     осознанный временный компромисс (без CA подключение к Сберу не работает
 *     из коробки). Правильный фикс — забандлить корневой сертификат Минцифры
 *     (Russian Trusted Root CA) в resources/ и включить rejectUnauthorized: true
 *     с опцией ca. См. SECURITY-NOTES.md. Затрагивает строки ~76 и ~160.
 *  3. Chat API OpenAI-compatible (SSE streaming с `data: {...}` строками).
 *  4. Function calling — OpenAI-формат: tools[] в запросе, delta.tool_calls в ответе.
 *     Tool result — role: "tool" с tool_call_id.
 *  5. 401 на chat → сброс кеша → один retry (race между cached token и server-side expire).
 *
 * Документация: https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-chat
 */

import { randomUUID } from 'crypto'
import https from 'https'
import type { IncomingMessage } from 'http'
import { URL } from 'url'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import { toOpenAiTools } from './tool-format'

const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth'
const CHAT_URL  = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions'

export const GIGACHAT_MODELS = [
  'GigaChat',
  'GigaChat-Plus',
  'GigaChat-Pro',
  'GigaChat-Max'
]

const DEFAULT_MODEL = 'GigaChat'

// Module-level кеш токена. Между несколькими send() вызовами reuse.
let cachedToken: { value: string; expiresAt: number } | null = null

// Аудит M3: TLS-верификация GigaChat. По умолчанию false (Sber CA не в Node
// trust store → голый rejectUnauthorized:true сломал бы провайдера у всех).
// Пользователь, поставивший Russian Trusted Root CA в системное хранилище,
// включает проверку настройкой gigachat_tls_verify=true. Module-флаг (как
// cachedToken) — провайдер создаётся свежим на каждый send и ставит его до
// первого запроса.
let gigaTlsVerify = false
let gigaInsecureWarned = false

export interface GigaChatOptions {
  clientId: string
  clientSecret: string
  model?: string
  /** Аудит M3: проверять TLS-сертификат сервера (нужен Russian Trusted Root CA
   *  в системном хранилище). По умолчанию false — иначе CERT_UNTRUSTED. */
  tlsVerify?: boolean
}

/**
 * Сбрасывает кеш токена — для тестов и для 401 retry.
 */
export function resetGigaChatTokenCache(): void {
  cachedToken = null
}

interface OAuthResponse {
  access_token: string
  expires_at: number // unix epoch SECONDS
}

/**
 * Тонкая обёртка над https.request для запросов с insecure SSL.
 * Возвращает { statusCode, body } для one-shot (oauth), или IncomingMessage
 * для streaming (chat). Чтобы не тянуть undici.
 */
function httpsRequestRaw(
  url: string,
  options: https.RequestOptions,
  body?: string | Buffer
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: options.method ?? 'GET',
      headers: options.headers,
      // Аудит M3: проверка TLS по настройке gigachat_tls_verify (см. gigaTlsVerify).
      rejectUnauthorized: gigaTlsVerify
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/**
 * Получить access_token. Использует кеш module-level если token действителен
 * ещё минимум 60 секунд (буфер на сетевую задержку).
 */
export async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.value
  }
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await httpsRequestRaw(
    OAUTH_URL,
    {
      method: 'POST',
      headers: {
        'RqUID': randomUUID(),
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    },
    'scope=GIGACHAT_API_PERS'
  )
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`GigaChat OAuth HTTP ${res.statusCode}: ${res.body.slice(0, 400)}`)
  }
  const parsed = JSON.parse(res.body) as OAuthResponse
  if (!parsed.access_token) {
    throw new Error('GigaChat OAuth: пустой access_token в ответе')
  }
  cachedToken = {
    value: parsed.access_token,
    // expires_at у Сбера в секундах. Конвертируем в миллисекунды.
    expiresAt: (parsed.expires_at ?? Math.floor(now / 1000) + 1800) * 1000
  }
  return cachedToken.value
}

/**
 * Streaming POST на /chat/completions — используем https.request напрямую,
 * парсим body как async iterable (line-by-line) и эмитим chunks.
 */
async function* chatStream(
  token: string,
  body: object,
  signal?: AbortSignal
): AsyncGenerator<string, void, void> {
  yield* streamLines(await openChatStream(token, body, signal))
}

function openChatStream(token: string, body: object, signal?: AbortSignal): Promise<IncomingMessage & { __status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(CHAT_URL)
    const payload = JSON.stringify(body)
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Content-Length': Buffer.byteLength(payload).toString()
      },
      rejectUnauthorized: gigaTlsVerify // Аудит M3
    }, (res) => {
      ;(res as any).__status = res.statusCode ?? 0
      resolve(res as IncomingMessage & { __status: number })
    })
    req.on('error', reject)
    if (signal) {
      const onAbort = () => req.destroy(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    }
    req.write(payload)
    req.end()
  })
}

async function* streamLines(res: IncomingMessage & { __status: number }): AsyncGenerator<string, void, void> {
  if (res.__status === 401) {
    throw new GigaChatAuthError('401 Unauthorized — token expired or invalid')
  }
  if (res.__status < 200 || res.__status >= 300) {
    const body = await new Promise<string>(r => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer | string) => chunks.push(Buffer.from(c)))
      res.on('end', () => r(Buffer.concat(chunks).toString('utf8')))
    })
    throw new Error(`GigaChat chat HTTP ${res.__status}: ${body.slice(0, 400)}`)
  }
  res.setEncoding('utf8')
  let buf = ''
  for await (const chunk of res as AsyncIterable<string>) {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      yield t
    }
  }
  if (buf.trim()) yield buf.trim()
}

class GigaChatAuthError extends Error {}

interface ToolCallDelta {
  index?: number
  id?: string
  function?: {
    name?: string
    arguments?: string
  }
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: ToolCallDelta[]
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Конвертирует ChatMessage[] в сообщения для GigaChat (OpenAI-compatible формат).
 * Tool results передаются как role: "tool".
 */
function buildGigaChatMessages(messages: ChatMessage[]): unknown[] {
  const result: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
      if (m.toolCalls?.length) {
        // Сообщение ассистента с вызовами тулзов
        result.push({
          role: 'assistant',
          content: m.content ?? '',
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args)
            }
          }))
        })
      } else if (m.role === 'user' && m.toolResults?.length) {
        // User message carrying tool results → role: "tool" messages
        for (const r of m.toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: r.id,
            content: r.error
              ? `Error: ${r.error}\n${JSON.stringify(r.result)}`
              : (typeof r.result === 'string' ? r.result : JSON.stringify(r.result))
          })
        }
        // verifyHint текст идёт следом как user, если есть
        if (m.content) {
          result.push({ role: 'user', content: m.content })
        }
      } else {
        result.push({ role: m.role, content: m.content ?? '' })
      }
    }
  }
  return result
}

export function createGigaChatProvider(opts: GigaChatOptions): ChatProvider {
  if (!opts.clientId || !opts.clientId.trim()) throw new Error('GigaChat: Client ID не задан')
  if (!opts.clientSecret || !opts.clientSecret.trim()) throw new Error('GigaChat: Client Secret не задан')

  // Аудит M3: ставим TLS-режим до первого запроса. Если проверка выключена —
  // предупреждаем один раз (раньше insecure был молчаливым и без выхода).
  gigaTlsVerify = opts.tlsVerify === true
  if (!gigaTlsVerify && !gigaInsecureWarned) {
    gigaInsecureWarned = true
    console.warn('[gigachat] TLS-сертификат сервера НЕ проверяется (gigachat_tls_verify не включён). Для защиты от MITM поставь Russian Trusted Root CA в системное хранилище и включи gigachat_tls_verify=true.')
  }

  const model = opts.model && opts.model.trim() ? opts.model : DEFAULT_MODEL

  return {
    id: 'gigachat',
    name: 'GigaChat',
    models: GIGACHAT_MODELS,

    async *send(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      _results?: ToolResult[],
      signal?: AbortSignal
    ): AsyncIterable<ChatEvent> {
      const body: Record<string, unknown> = {
        model,
        messages: buildGigaChatMessages(messages),
        stream: true,
        temperature: 0.7,
        max_tokens: 8000
      }

      // Добавляем tools если они есть
      if (tools.length > 0) {
        body.tools = toOpenAiTools(tools)
      }

      let usageIn = 0
      let usageOut = 0
      let attemptedRetry = false

      async function* runOnce(): AsyncGenerator<ChatEvent, void, void> {
        const token = await getAccessToken(opts.clientId, opts.clientSecret)

        // Накапливаем tool_calls по индексу (приходят дельтами по чанкам)
        // Структура: index → { id, name, argumentsBuffer }
        const toolCallAccum = new Map<number, { id: string; name: string; argumentsBuffer: string }>()

        for await (const line of chatStream(token, body, signal)) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') break
          let chunk: ChatChunk
          try { chunk = JSON.parse(payload) } catch { continue }

          const delta = chunk.choices?.[0]?.delta

          // Текстовый контент
          if (delta?.content) yield { type: 'text', text: delta.content }

          // Tool calls — накапливаем дельты
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, {
                  id: tc.id ?? randomUUID(),
                  name: tc.function?.name ?? '',
                  argumentsBuffer: ''
                })
              }
              const acc = toolCallAccum.get(idx)!
              // Имя может прийти в первом чанке, аргументы — дробно
              if (tc.function?.name) acc.name = tc.function.name
              if (tc.id) acc.id = tc.id
              if (tc.function?.arguments) acc.argumentsBuffer += tc.function.arguments
            }
          }

          const finishReason = chunk.choices?.[0]?.finish_reason
          if (finishReason === 'tool_calls' || finishReason === 'stop') {
            // Эмитим накопленные tool calls
            for (const [, acc] of toolCallAccum) {
              if (!acc.name) continue
              let args: Record<string, unknown> = {}
              try { args = JSON.parse(acc.argumentsBuffer) } catch { /* некорректный JSON — пустые args */ }
              yield {
                type: 'tool-call',
                call: {
                  id: acc.id,
                  name: acc.name,
                  args
                }
              }
            }
            toolCallAccum.clear()
          }

          if (chunk.usage) {
            usageIn = chunk.usage.prompt_tokens ?? usageIn
            usageOut = chunk.usage.completion_tokens ?? usageOut
          }
        }

        // На случай если finish_reason не пришёл явно, но tool calls накоплены
        for (const [, acc] of toolCallAccum) {
          if (!acc.name) continue
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(acc.argumentsBuffer) } catch { /* skip */ }
          yield {
            type: 'tool-call',
            call: {
              id: acc.id,
              name: acc.name,
              args
            }
          }
        }
      }

      try {
        try {
          yield* runOnce()
        } catch (err) {
          // 401 race condition: cached token expired server-side но ещё в кеше.
          // Сбрасываем + один retry. Любой другой error — пробрасываем.
          if (err instanceof GigaChatAuthError && !attemptedRetry) {
            attemptedRetry = true
            resetGigaChatTokenCache()
            yield* runOnce()
          } else {
            throw err
          }
        }
        if (usageIn > 0 || usageOut > 0) {
          yield { type: 'usage', usage: { inputTokens: usageIn, outputTokens: usageOut, model } }
        }
      } catch (err) {
        yield { type: 'error', message: `GigaChat: ${err instanceof Error ? err.message : String(err)}` }
      } finally {
        yield { type: 'done' }
      }
    }
  }
}
