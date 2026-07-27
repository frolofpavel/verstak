/**
 * Avito connector — объявления, статистика, баланс кошелька.
 *
 * Своя реализация поверх официального Avito API. OAuth2 client_credentials:
 * по client_id/secret получаем access_token (кэшируем до истечения), затем
 * Bearer-запросы. user_id берём из /core/v1/accounts/self и кэшируем.
 *
 * Зачем агентству: у многих клиентов лиды и продажи идут с Авито —
 * мониторинг объявлений, просмотры/контакты, остаток на кошельке.
 *
 * Credentials (settings keys):
 *   avito_client_id     — client_id приложения (developers.avito.ru).
 *   avito_client_secret — client_secret.
 *
 * Операции (args.op):
 *   list_items  — объявления аккаунта (page, per_page).
 *   get_stats   — статистика по объявлениям (item_ids, date_from, date_to).
 *   get_balance — остаток кошелька (реальные + бонусные).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API = 'https://api.avito.ru'

export function createAvitoConnector(): Connector {
  // Кэш токена и user_id живут в замыкании коннектора (один на процесс).
  let cachedToken: { value: string; expiresAt: number; id: string } | null = null
  let cachedUserId: number | null = null

  async function getToken(id: string, secret: string, ctx: ConnectorContext): Promise<string> {
    const now = Date.now()
    // Кэш токена валиден только для ТОГО ЖЕ client_id — иначе после смены креда
    // вернулся бы токен чужого аккаунта (а getUserId отдал бы старый userId) (C4).
    if (cachedToken && cachedToken.id === id && cachedToken.expiresAt > now + 30_000) return cachedToken.value
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret })
    const res = await fetch(`${API}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctx.signal
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Avito auth ${res.status} (проверь client_id/secret): ${text.slice(0, 200)}`)
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number }
    if (!json.access_token) throw new Error('Avito не вернул access_token')
    cachedToken = { value: json.access_token, expiresAt: now + (json.expires_in ?? 86400) * 1000, id }
    cachedUserId = null // новый токен (возможно другой аккаунт) → сбрасываем связанный userId
    return cachedToken.value
  }

  async function getUserId(token: string, ctx: ConnectorContext): Promise<number> {
    if (cachedUserId) return cachedUserId
    const self = await apiGet(`${API}/core/v1/accounts/self`, token, ctx) as { id?: number }
    if (!self.id) throw new Error('Avito accounts/self не вернул id')
    cachedUserId = self.id
    return self.id
  }

  return {
    info(): ConnectorInfo {
      return {
        id: 'avito',
        label: 'Avito',
        kind: 'avito',
        requires: ['avito_client_id', 'avito_client_secret'],
        status: 'ready',
        detail: 'Объявления, статистика, баланс. client_id/secret в settings (avito_client_id).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const clientId = ctx.getSecret('avito_client_id')
      const clientSecret = ctx.getSecret('avito_client_secret')
      if (!clientId || !clientSecret) {
        return {
          error: 'no-credentials',
          message: 'Avito client_id/secret не настроены. Settings → Avito. ' +
                   'Получить: developers.avito.ru (приложение → client_id и client_secret).'
        }
      }
      try {
        const token = await getToken(clientId, clientSecret, ctx)
        switch (op) {
          case 'list_items':  return await listItems(token, args, ctx)
          case 'get_stats':   return await getStats(token, args, ctx, getUserId)
          case 'get_balance': return await getBalance(token, args, ctx, getUserId)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_items, get_stats, get_balance.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listItems(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const page = Math.max(1, Number(args.page ?? 1) || 1)
  const perPage = Math.max(1, Math.min(100, Number(args.per_page ?? 25) || 25))
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) })
  const status = typeof args.status === 'string' ? args.status : ''
  if (status) params.set('status', status)
  const json = await apiGet(`${API}/core/v1/items?${params}`, token, ctx) as { resources?: Array<Record<string, any>>; meta?: any }
  const items = (json.resources ?? []).map(i => ({
    id: i.id, title: i.title, price: i.price, status: i.status, url: i.url, address: i.address, category: i.category?.name
  }))
  return { page, per_page: perPage, count: items.length, items }
}

async function getStats(
  token: string, args: Record<string, unknown>, ctx: ConnectorContext,
  getUserId: (t: string, c: ConnectorContext) => Promise<number>
): Promise<unknown> {
  const itemIds = (args.item_ids as number[] | undefined) ?? []
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return { error: 'bad-args', message: 'get_stats требует item_ids: number[] (id объявлений из list_items).' }
  }
  const userId = await getUserId(token, ctx)
  const body = {
    dateFrom: String(args.date_from ?? daysAgoISO(30)),
    dateTo: String(args.date_to ?? todayISO()),
    fields: ['uniqViews', 'uniqContacts', 'uniqFavorites'],
    itemIds: itemIds.slice(0, 200),
    periodGrouping: 'day'
  }
  const json = await apiPost(`${API}/stats/v1/accounts/${userId}/items`, token, body, ctx) as { result?: { items?: Array<Record<string, any>> } }
  return { items: json.result?.items ?? [] }
}

async function getBalance(
  token: string, _args: Record<string, unknown>, ctx: ConnectorContext,
  getUserId: (t: string, c: ConnectorContext) => Promise<number>
): Promise<unknown> {
  const userId = await getUserId(token, ctx)
  const json = await apiGet(`${API}/core/v1/accounts/${userId}/balance/`, token, ctx) as { real?: number; bonus?: number }
  return { real: json.real ?? null, bonus: json.bonus ?? null }
}

// ----------------------------------------------------------------- helpers

async function apiGet(url: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }, signal: ctx.signal })
  return parse(res, url)
}

async function apiPost(url: string, token: string, body: unknown, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
    signal: ctx.signal
  })
  return parse(res, url)
}

async function parse(res: Response, url: string): Promise<unknown> {
  const text = await res.text()
  if (!res.ok) throw new Error(`Avito ${res.status} ${url.replace(API, '')}: ${text.slice(0, 250)}`)
  try { return JSON.parse(text) } catch { throw new Error('Avito вернул не-JSON ответ') }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}
function daysAgoISO(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10)
}
