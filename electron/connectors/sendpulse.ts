/**
 * SendPulse connector — email-рассылки, кампании, баланс аккаунта.
 *
 * Своя реализация поверх официального SendPulse REST API. OAuth2
 * client_credentials: по client_id/secret получаем access_token (кэшируем
 * до истечения), затем Bearer-запросы.
 *
 * Зачем агентству: многие клиенты ведут email-рассылки через SendPulse —
 * мониторинг адресных книг (размер базы), статус кампаний и остаток на
 * балансе для своевременного пополнения.
 *
 * Credentials (settings keys):
 *   sendpulse_client_id     — ID приложения (login.sendpulse.com → API).
 *   sendpulse_client_secret — Secret приложения.
 *
 * API (https://sendpulse.com/integrations/api):
 *   - OAuth:  POST https://api.sendpulse.com/oauth/access_token
 *               {grant_type:'client_credentials', client_id, client_secret}
 *               → {access_token, token_type:'Bearer', expires_in}
 *   - Base:   https://api.sendpulse.com  (Authorization: Bearer {token})
 *
 * Операции (args.op):
 *   list_mailing_lists — адресные книги (GET /addressbooks).
 *   list_campaigns     — email-кампании (GET /campaigns).
 *   get_balance        — баланс аккаунта (GET /user/balance).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API = 'https://api.sendpulse.com'

export function createSendPulseConnector(): Connector {
  // Кэш токена живёт в замыкании коннектора (один на процесс).
  // 2.0.1 bug: кэш привязан к client_id — иначе после ротации креда возвращался
  // токен старого аккаунта до истечения.
  let cachedToken: { value: string; expiresAt: number; forId: string } | null = null

  async function getToken(id: string, secret: string, ctx: ConnectorContext): Promise<string> {
    const now = Date.now()
    if (cachedToken && cachedToken.forId === id && cachedToken.expiresAt > now + 30_000) return cachedToken.value
    const res = await fetch(`${API}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
      signal: ctx.signal
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`SendPulse auth ${res.status} (проверь client_id/secret): ${text.slice(0, 200)}`)
    let json: { access_token?: string; expires_in?: number }
    try { json = JSON.parse(text) } catch { throw new Error('SendPulse auth вернул не-JSON ответ') }
    if (!json.access_token) throw new Error('SendPulse не вернул access_token')
    cachedToken = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000, forId: id }
    return cachedToken.value
  }

  return {
    info(): ConnectorInfo {
      return {
        id: 'sendpulse',
        label: 'SendPulse',
        kind: 'sendpulse',
        status: 'ready',
        detail: 'Email-рассылки, кампании, баланс. client_id/secret в settings (sendpulse_client_id).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const clientId = ctx.getSecret('sendpulse_client_id')
      const clientSecret = ctx.getSecret('sendpulse_client_secret')
      if (!clientId || !clientSecret) {
        return {
          error: 'no-credentials',
          message: 'SendPulse client_id/secret не настроены. Settings → SendPulse. ' +
                   'Получить: login.sendpulse.com → раздел API (Account → API).'
        }
      }
      try {
        const token = await getToken(clientId, clientSecret, ctx)
        switch (op) {
          case 'list_mailing_lists': return await listMailingLists(token, ctx)
          case 'list_campaigns':     return await listCampaigns(token, ctx)
          case 'get_balance':        return await getBalance(token, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_mailing_lists, list_campaigns, get_balance.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listMailingLists(token: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${API}/addressbooks`, token, ctx)
  const books = (Array.isArray(json) ? json : []).map(formatBook)
  return { count: books.length, mailing_lists: books }
}

async function listCampaigns(token: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${API}/campaigns`, token, ctx)
  const campaigns = (Array.isArray(json) ? json : []).map(formatCampaign)
  return { count: campaigns.length, campaigns }
}

async function getBalance(token: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${API}/user/balance`, token, ctx) as Record<string, any>
  return formatBalance(json)
}

// ----------------------------------------------------------------- helpers

async function get(url: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь sendpulse_client_id / sendpulse_client_secret)'
      : ''
    throw new Error(`SendPulse ${res.status}${hint} ${url.replace(API, '')}: ${text.slice(0, 250)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('SendPulse вернул не-JSON ответ') }
}

// Извлекаем только нужные плоские поля — компактный предсказуемый ответ
// вместо громоздкого SendPulse JSON (защита контекста + удобство для модели).

function formatBook(b: Record<string, any>): unknown {
  return {
    id: b.id ?? null,
    name: b.name ?? null,
    all_email_qty: b.all_email_qty ?? null,
    active_email_qty: b.active_email_qty ?? null
  }
}

function formatCampaign(c: Record<string, any>): unknown {
  return {
    id: c.id ?? null,
    name: c.name ?? null,
    status: c.status ?? null,
    send_date: c.send_date ?? null,
    all_email_qty: c.all_email_qty ?? null
  }
}

// Баланс: основной эндпоинт отдаёт плоско (currency/balance_main/balance_bonus),
// detail-вариант — вложенно (balance.main/.bonus/.currency). Читаем оба.
function formatBalance(j: Record<string, any>): unknown {
  const nested = (j.balance ?? {}) as Record<string, any>
  return {
    currency: j.currency ?? j.balance_currency ?? nested.currency ?? null,
    balance_main: j.balance_main ?? nested.main ?? null,
    balance_bonus: j.balance_bonus ?? nested.bonus ?? null
  }
}
