/**
 * Яндекс.Вебмастер connector — SEO-данные сайтов (ИКС, проблемы, запросы).
 *
 * Своя реализация поверх официального Webmaster API v4.
 * Зачем агентству: SEO-мониторинг клиентских сайтов — ИКС (SQI), проблемы
 * индексации, топ поисковых запросов с показами/кликами.
 *
 * Credentials (settings keys):
 *   yandex_webmaster_token — OAuth token (oauth.yandex.ru, scope webmaster:verify/hostinfo).
 *
 * API:
 *   - Base: https://api.webmaster.yandex.net/v4/  · Auth: `Authorization: OAuth {token}`
 *   - user_id берём из /v4/user и кэшируем.
 *
 * Операции (args.op):
 *   list_hosts  — сайты аккаунта (host_id для остальных операций).
 *   get_summary — ИКС (SQI) и сводка проблем сайта (host_id).
 *   get_queries — топ поисковых запросов сайта: показы/клики (host_id).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const BASE = 'https://api.webmaster.yandex.net/v4'

export function createYandexWebmasterConnector(): Connector {
  let cachedUserId: number | null = null

  async function getUserId(token: string, ctx: ConnectorContext): Promise<number> {
    if (cachedUserId) return cachedUserId
    const u = await get(`${BASE}/user`, token, ctx) as { user_id?: number }
    if (!u.user_id) throw new Error('Webmaster /user не вернул user_id')
    cachedUserId = u.user_id
    return u.user_id
  }

  return {
    info(): ConnectorInfo {
      return {
        id: 'yandex_webmaster',
        label: 'Яндекс.Вебмастер',
        kind: 'yandex_webmaster',
        requires: ['yandex_webmaster_token'],
        status: 'ready',
        detail: 'SEO: ИКС, проблемы, запросы. OAuth token в settings (yandex_webmaster_token).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('yandex_webmaster_token')
      if (!token) {
        return {
          error: 'no-token',
          message: 'Yandex.Webmaster token не настроен. Settings → Яндекс.Вебмастер. ' +
                   'Получить: oauth.yandex.ru, scope webmaster:hostinfo.'
        }
      }
      try {
        const userId = await getUserId(token, ctx)
        switch (op) {
          case 'list_hosts':  return await listHosts(token, userId, ctx)
          case 'get_summary': return await getSummary(token, userId, args, ctx)
          case 'get_queries': return await getQueries(token, userId, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_hosts, get_summary, get_queries.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listHosts(token: string, userId: number, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${BASE}/user/${userId}/hosts`, token, ctx) as { hosts?: Array<Record<string, any>> }
  const hosts = (json.hosts ?? []).map(h => ({
    host_id: h.host_id,
    url: h.unicode_host_url ?? h.ascii_host_url,
    verified: h.verified,
    main_mirror: h.main_mirror?.unicode_host_url ?? null
  }))
  return { count: hosts.length, hosts }
}

async function getSummary(token: string, userId: number, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const hostId = requireHost(args)
  if (typeof hostId !== 'string') return hostId
  const json = await get(`${BASE}/user/${userId}/hosts/${encodeURIComponent(hostId)}/summary`, token, ctx) as Record<string, any>
  return { sqi: json.sqi ?? null, site_problems: json.site_problems ?? {} }
}

async function getQueries(token: string, userId: number, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const hostId = requireHost(args)
  if (typeof hostId !== 'string') return hostId
  const params = new URLSearchParams()
  params.append('order_by', 'TOTAL_SHOWS')
  params.append('query_indicator', 'TOTAL_SHOWS')
  params.append('query_indicator', 'TOTAL_CLICKS')
  const url = `${BASE}/user/${userId}/hosts/${encodeURIComponent(hostId)}/search-queries/popular?${params}`
  const json = await get(url, token, ctx) as { queries?: Array<Record<string, any>> }
  const queries = (json.queries ?? []).slice(0, 50).map(q => ({
    query: q.query_text,
    shows: q.indicators?.TOTAL_SHOWS ?? null,
    clicks: q.indicators?.TOTAL_CLICKS ?? null
  }))
  return { count: queries.length, queries }
}

// ----------------------------------------------------------------- helpers

function requireHost(args: Record<string, unknown>): string | { error: string; message: string } {
  const h = String(args.host_id ?? '').trim()
  if (!h) return { error: 'bad-args', message: 'Нужен host_id (из list_hosts).' }
  return h
}

async function get(url: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'Authorization': `OAuth ${token}`, 'Accept': 'application/json' },
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (проверь yandex_webmaster_token / scope)' : ''
    throw new Error(`Webmaster ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('Webmaster вернул не-JSON ответ') }
}
