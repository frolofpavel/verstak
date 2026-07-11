/**
 * Ozon Performance connector — рекламный кабинет Ozon (Performance API, бета).
 *
 * Своя реализация поверх официального Ozon Performance API. OAuth2
 * client_credentials: по client_id/secret получаем access_token (кэшируем до
 * истечения в замыкании), затем Bearer-запросы. Только чтение — кампании и их
 * объекты; ничего не создаём и не редактируем.
 *
 * Зачем агентству: у клиентов с продажами на Ozon реклама идёт через Performance
 * кабинет — список рекламных кампаний и состав (товары/SKU внутри кампании) для
 * отчётов и контроля, что крутится.
 *
 * Credentials (settings keys):
 *   ozon_perf_client_id     — Client ID из performance.ozon.ru (API-доступ).
 *   ozon_perf_client_secret — Client Secret. Нужны оба, иначе no-credentials.
 *
 * API:
 *   - Auth: POST https://api-performance.ozon.ru/api/client/token
 *           JSON {client_id, client_secret, grant_type:'client_credentials'}
 *           -> {access_token, expires_in}. Далее Authorization: Bearer {token}.
 *   - Base: https://api-performance.ozon.ru
 *
 * Операции (args.op):
 *   list_campaigns — GET /api/client/campaign -> {list:[...]}. Рекламные кампании.
 *   list_objects   — GET /api/client/campaign/{campaign_id}/objects. Объекты кампании.
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API = 'https://api-performance.ozon.ru'

export function createOzonPerformanceConnector(): Connector {
  // Кэш токена живёт в замыкании коннектора (один на процесс).
  // 2.0.1 bug: кэш привязан к client_id — иначе после ротации креда в settings
  // возвращался токен СТАРОГО аккаунта до истечения (до 30 мин).
  let cachedToken: { value: string; expiresAt: number; forId: string } | null = null

  async function getToken(id: string, secret: string, ctx: ConnectorContext): Promise<string> {
    const now = Date.now()
    if (cachedToken && cachedToken.forId === id && cachedToken.expiresAt > now + 30_000) return cachedToken.value
    const res = await fetch(`${API}/api/client/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
      signal: ctx.signal
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Ozon Performance auth ${res.status} (проверь client_id/secret): ${text.slice(0, 200)}`)
    let json: { access_token?: string; expires_in?: number }
    try { json = JSON.parse(text) } catch { throw new Error('Ozon Performance вернул не-JSON на /token') }
    if (!json.access_token) throw new Error('Ozon Performance не вернул access_token')
    cachedToken = { value: json.access_token, expiresAt: now + (json.expires_in ?? 1800) * 1000, forId: id }
    return cachedToken.value
  }

  return {
    info(): ConnectorInfo {
      return {
        id: 'ozon_performance',
        label: 'Ozon Performance',
        kind: 'ozon_performance',
        status: 'ready',
        detail: 'Рекламные кампании Ozon (бета). client_id/secret в settings (ozon_perf_client_id).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const clientId = ctx.getSecret('ozon_perf_client_id')
      const clientSecret = ctx.getSecret('ozon_perf_client_secret')
      if (!clientId || !clientSecret) {
        return {
          error: 'no-credentials',
          message: 'Ozon Performance client_id/secret не настроены. Settings → Ozon Performance. ' +
                   'Получить: performance.ozon.ru → настройки → API-доступ (Client ID и Client Secret).'
        }
      }
      try {
        const token = await getToken(clientId, clientSecret, ctx)
        switch (op) {
          case 'list_campaigns': return await listCampaigns(token, ctx)
          case 'list_objects':   return await listObjects(token, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_campaigns, list_objects.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listCampaigns(token: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await apiGet(`${API}/api/client/campaign`, token, ctx) as { list?: Array<Record<string, any>> }
  const campaigns = (json.list ?? []).map(formatCampaign)
  return { count: campaigns.length, campaigns }
}

async function listObjects(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const campaignId = String(args.campaign_id ?? '').trim()
  if (!campaignId) {
    return { error: 'bad-args', message: 'list_objects требует campaign_id (id кампании из list_campaigns).' }
  }
  const json = await apiGet(`${API}/api/client/campaign/${encodeURIComponent(campaignId)}/objects`, token, ctx) as { list?: Array<Record<string, any>> }
  const objects = (json.list ?? []).map(formatObject)
  return { campaign_id: campaignId, count: objects.length, objects }
}

// ----------------------------------------------------------------- helpers

async function apiGet(url: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь ozon_perf_client_id / ozon_perf_client_secret)'
      : ''
    throw new Error(`Ozon Performance ${res.status}${hint} ${url.replace(API, '')}: ${text.slice(0, 250)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('Ozon Performance вернул не-JSON ответ') }
}

// Извлекаем только нужные плоские поля — компактный предсказуемый ответ.

function formatCampaign(c: Record<string, any>): unknown {
  return {
    id: c.id ?? null,
    title: c.title ?? null,
    state: c.state ?? null,                  // CAMPAIGN_STATE_RUNNING | ..._STOPPED | ...
    advObjectType: c.advObjectType ?? null   // SKU | SEARCH_PROMO | ...
  }
}

function formatObject(o: Record<string, any>): unknown {
  return {
    id: o.id ?? null,
    name: o.name ?? null,
    sku: o.sku ?? null
  }
}
