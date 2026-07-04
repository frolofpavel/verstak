/**
 * Telegram Bot API connector — send_message, edit, delete, react.
 * Read истории НЕ через bot (Bot API не даёт) — через ssh + Telethon скрипт.
 *
 * Источник: V3 Plan раздел 5.2.
 *
 * Credentials (settings keys):
 *   telegram_bot_token         — токен от @BotFather
 *   telegram_chat_whitelist    — JSON array chat_ids которым разрешена
 *                                отправка. Пустой массив = «никому».
 *                                null/missing = «всем» (только для dev).
 *
 * Безопасность:
 *   - Whitelist chat_ids: без него можно отправить незнакомому чату.
 *   - Rate limit: max 20 send в минуту на тот же chat_id (предотвращает
 *     accidental flood и Telegram lockout).
 *   - Все text проходят secret-scanner перед отправкой (если случайно
 *     модель сгенерила API key, он не уйдёт клиенту).
 */

import { readFile } from 'fs/promises'
import { basename } from 'path'
import type { Connector, ConnectorInfo, ConnectorContext } from './types'
import { scanText } from '../ai/secret-scanner'

const TG_API = 'https://api.telegram.org'
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 20

// Per-chat sliding window. key = chat_id; value = timestamps массив.
const sendHistory = new Map<string, number[]>()

export function createTelegramConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'telegram',
        label: 'Telegram (bot)',
        kind: 'telegram',
        status: 'ready',
        detail: 'Bot token + whitelist chat_ids в settings. Read через ssh+Telethon.'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('telegram_bot_token')
      if (!token) {
        return {
          error: 'no-token',
          message: 'Telegram bot token не настроен. Settings → введи token от @BotFather в "telegram_bot_token".'
        }
      }
      try {
        switch (op) {
          case 'send_message':  return await sendMessage(token, args, ctx)
          case 'edit_message':  return await editMessage(token, args, ctx)
          case 'send_document': return await sendDocument(token, args, ctx)
          case 'react':         return await reactToMessage(token, args, ctx)
          case 'delete_message':return await deleteMessage(token, args, ctx)
          case 'get_me':        return await callBot(token, 'getMe', {}, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная операция «${op}». Доступно: send_message, edit_message, send_document, react, delete_message, get_me.`
            }
        }
      } catch (err) {
        return {
          error: 'request-failed',
          message: err instanceof Error ? err.message : String(err),
          op
        }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function sendMessage(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const chatId = String(args.chat_id ?? '')
  const text = String(args.text ?? '')
  if (!chatId || !text) return { error: 'bad-args', message: 'send_message требует chat_id и text' }

  const whitelistCheck = checkWhitelist(chatId, ctx)
  if (whitelistCheck) return whitelistCheck

  const rateCheck = checkRateLimit(chatId)
  if (rateCheck) return rateCheck

  // Secret scan текста — модель могла случайно сгенерить токен / API key
  const scan = scanText(text)
  const safeText = scan.hits.length > 0
    ? `[gg: redacted ${scan.hits.join(', ')} перед отправкой]\n${scan.redacted}`
    : text

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: safeText
  }
  if (args.message_thread_id) body.message_thread_id = args.message_thread_id
  if (args.reply_to_message_id) body.reply_parameters = { message_id: args.reply_to_message_id }
  if (args.parse_mode) body.parse_mode = args.parse_mode
  if (args.disable_web_page_preview) body.link_preview_options = { is_disabled: true }

  recordSend(chatId)
  return await callBot(token, 'sendMessage', body, ctx)
}

async function editMessage(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const chatId = String(args.chat_id ?? '')
  const messageId = Number(args.message_id ?? 0)
  const text = String(args.text ?? '')
  if (!chatId || !messageId || !text) {
    return { error: 'bad-args', message: 'edit_message требует chat_id, message_id, text' }
  }
  const whitelistCheck = checkWhitelist(chatId, ctx)
  if (whitelistCheck) return whitelistCheck
  const scan = scanText(text)
  return await callBot(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: scan.hits.length > 0 ? scan.redacted : text,
    ...(args.parse_mode ? { parse_mode: args.parse_mode } : {})
  }, ctx)
}

async function sendDocument(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  // Document upload требует multipart/form-data, что усложняет код.
  // V1: поддерживаем только URL document — сначала загрузите файл в
  // Yandex Disk или другое облако, затем шлите ссылку. Multipart добавим в V3.1.
  const chatId = String(args.chat_id ?? '')
  const documentUrl = String(args.document_url ?? '')
  const documentPath = String(args.document_path ?? '')
  const caption = args.caption ? String(args.caption) : undefined
  if (!chatId || (!documentUrl && !documentPath)) {
    return { error: 'bad-args', message: 'send_document V1 требует chat_id + document_url (HTTP). Файл должен быть публично доступен.' }
  }
  const whitelistCheck = checkWhitelist(chatId, ctx)
  if (whitelistCheck) return whitelistCheck
  recordSend(chatId)
  if (documentPath) {
    const file = await readFile(documentPath)
    const form = new FormData()
    form.set('chat_id', chatId)
    form.set('document', new Blob([file]), basename(documentPath))
    if (caption) {
      const scan = scanText(caption)
      form.set('caption', scan.hits.length > 0 ? scan.redacted : caption)
    }
    return await callBotForm(token, 'sendDocument', form, ctx)
  }
  return await callBot(token, 'sendDocument', {
    chat_id: chatId,
    document: documentUrl,
    ...(caption ? { caption } : {})
  }, ctx)
}

async function reactToMessage(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const chatId = String(args.chat_id ?? '')
  const messageId = Number(args.message_id ?? 0)
  const emoji = String(args.emoji ?? '👍')
  if (!chatId || !messageId) return { error: 'bad-args', message: 'react требует chat_id и message_id' }
  const whitelistCheck = checkWhitelist(chatId, ctx)
  if (whitelistCheck) return whitelistCheck
  return await callBot(token, 'setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }]
  }, ctx)
}

async function deleteMessage(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const chatId = String(args.chat_id ?? '')
  const messageId = Number(args.message_id ?? 0)
  if (!chatId || !messageId) return { error: 'bad-args', message: 'delete_message требует chat_id и message_id' }
  const whitelistCheck = checkWhitelist(chatId, ctx)
  if (whitelistCheck) return whitelistCheck
  return await callBot(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }, ctx)
}

// ----------------------------------------------------------------- helpers

async function callBot(token: string, method: string, body: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const url = `${TG_API}/bot${token}/${method}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctx.signal
  })
  const payload = await res.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number }
  if (!payload.ok) {
    throw new Error(`Telegram ${method} failed: ${payload.error_code} ${payload.description}`)
  }
  return payload.result
}

async function callBotForm(token: string, method: string, form: FormData, ctx: ConnectorContext): Promise<unknown> {
  const url = `${TG_API}/bot${token}/${method}`
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: ctx.signal
  })
  const payload = await res.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number }
  if (!payload.ok) {
    throw new Error(`Telegram ${method} failed: ${payload.error_code} ${payload.description}`)
  }
  return payload.result
}

function checkWhitelist(chatId: string, ctx: ConnectorContext): { error: string; message: string } | null {
  const raw = ctx.getSecret('telegram_chat_whitelist')
  if (!raw) {
    // Развитие: в production обязательно whitelist. В dev/первом запуске
    // разрешаем — иначе ни одна операция не получится без manual config.
    return null
  }
  // Аудит M5: whitelist ЗАДАН — значит пользователь выразил намерение ограничить.
  // Если он битый/не-массив, fail-OPEN (слать в любой chat_id) противоречит этому
  // намерению. Fail-CLOSED: пока конфиг не починят, ничего не уходит.
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return {
      error: 'whitelist-invalid',
      message: 'telegram_chat_whitelist задан, но это невалидный JSON. Отправка заблокирована — почини settings → telegram_chat_whitelist (массив chat_id).'
    }
  }
  if (!Array.isArray(list)) {
    return {
      error: 'whitelist-invalid',
      message: 'telegram_chat_whitelist должен быть JSON-массивом chat_id. Отправка заблокирована.'
    }
  }
  const normalized = list.map(String)
  if (!normalized.includes(chatId)) {
    return {
      error: 'not-whitelisted',
      message: `chat_id «${chatId}» не в whitelist. Добавь в settings → telegram_chat_whitelist.`
    }
  }
  return null
}

function checkRateLimit(chatId: string): { error: string; message: string } | null {
  const now = Date.now()
  const hist = sendHistory.get(chatId) ?? []
  const recent = hist.filter(t => t > now - RATE_LIMIT_WINDOW_MS)
  if (recent.length >= RATE_LIMIT_MAX) {
    return {
      error: 'rate-limited',
      message: `В чат ${chatId} отправлено ${recent.length} сообщений за минуту. Лимит ${RATE_LIMIT_MAX}. Подожди.`
    }
  }
  sendHistory.set(chatId, recent)
  return null
}

function recordSend(chatId: string): void {
  const now = Date.now()
  const hist = sendHistory.get(chatId) ?? []
  hist.push(now)
  // Подрезаем чтобы не утекало
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  sendHistory.set(chatId, hist.filter(t => t > cutoff))
}
