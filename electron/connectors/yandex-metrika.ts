/**
 * Яндекс.Метрика connector — веб-аналитика (трафик, источники, цели).
 *
 * Своя реализация поверх официального Metrika API (Management + Reporting).
 * Зачем агентству: отчёты клиентам по трафику/конверсиям, источники визитов.
 *
 * Credentials (settings keys):
 *   yandex_metrika_token — OAuth token (oauth.yandex.ru, scope metrika:read).
 *
 * API:
 *   - Management: https://api-metrika.yandex.net/management/v1/  (счётчики, цели)
 *   - Reporting:  https://api-metrika.yandex.net/stat/v1/data    (метрики по периоду)
 *   Auth-заголовок Метрики — `Authorization: OAuth {token}` (НЕ Bearer).
 *
 * Операции (args.op):
 *   list_counters — счётчики аккаунта.
 *   get_traffic   — визиты/посетители/просмотры/отказы по дням (counter, date1, date2).
 *   get_sources   — трафик по источникам за период.
 *   list_goals    — цели счётчика (для отчётов по конверсиям).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const MGMT_BASE = 'https://api-metrika.yandex.net/management/v1'
const STAT_URL = 'https://api-metrika.yandex.net/stat/v1/data'

export function createYandexMetrikaConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'yandex_metrika',
        label: 'Яндекс.Метрика',
        kind: 'yandex_metrika',
        requires: ['yandex_metrika_token'],
        status: 'ready',
        detail: 'Веб-аналитика. OAuth token в settings (yandex_metrika_token).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('yandex_metrika_token')
      if (!token) {
        return {
          error: 'no-token',
          message: 'Yandex.Metrika token не настроен. Settings → Яндекс.Метрика. ' +
                   'Получить: oauth.yandex.ru, scope metrika:read.'
        }
      }
      try {
        switch (op) {
          case 'list_counters': return await listCounters(token, ctx)
          case 'get_traffic':   return await getTraffic(token, args, ctx)
          case 'get_sources':   return await getSources(token, args, ctx)
          case 'list_goals':    return await listGoals(token, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_counters, get_traffic, get_sources, list_goals.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listCounters(token: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${MGMT_BASE}/counters`, token, ctx) as { counters?: Array<Record<string, any>> }
  const counters = (json.counters ?? []).map(c => ({
    id: c.id, name: c.name, site: c.site, status: c.status
  }))
  return { count: counters.length, counters }
}

async function getTraffic(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const counter = requireCounter(args)
  if (typeof counter !== 'string') return counter
  const params = new URLSearchParams({
    ids: counter,
    metrics: 'ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate,ym:s:avgVisitDurationSeconds',
    dimensions: 'ym:s:date',
    date1: String(args.date1 ?? '7daysAgo'),
    date2: String(args.date2 ?? 'today'),
    sort: 'ym:s:date',
    limit: '100'
  })
  const json = await get(`${STAT_URL}?${params}`, token, ctx)
  return summarizeStat(json, ['date', 'visits', 'users', 'pageviews', 'bounceRate', 'avgVisitDurationSeconds'])
}

async function getSources(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const counter = requireCounter(args)
  if (typeof counter !== 'string') return counter
  const params = new URLSearchParams({
    ids: counter,
    metrics: 'ym:s:visits,ym:s:users,ym:s:bounceRate',
    dimensions: 'ym:s:lastTrafficSource',
    date1: String(args.date1 ?? '30daysAgo'),
    date2: String(args.date2 ?? 'today'),
    sort: '-ym:s:visits',
    limit: '20'
  })
  const json = await get(`${STAT_URL}?${params}`, token, ctx)
  return summarizeStat(json, ['source', 'visits', 'users', 'bounceRate'])
}

async function listGoals(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const counter = requireCounter(args)
  if (typeof counter !== 'string') return counter
  const json = await get(`${MGMT_BASE}/counter/${counter}/goals`, token, ctx) as { goals?: Array<Record<string, any>> }
  const goals = (json.goals ?? []).map(g => ({ id: g.id, name: g.name, type: g.type }))
  return { count: goals.length, goals }
}

// ----------------------------------------------------------------- helpers

function requireCounter(args: Record<string, unknown>): string | { error: string; message: string } {
  const c = String(args.counter ?? args.counter_id ?? '').trim()
  if (!c) return { error: 'bad-args', message: 'Нужен counter (id счётчика). Получи через list_counters.' }
  return c
}

async function get(url: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'Authorization': `OAuth ${token}`, 'Accept': 'application/json' },
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (проверь yandex_metrika_token / scope metrika:read)' : ''
    throw new Error(`Metrika ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('Metrika вернула не-JSON ответ') }
}

/** Reporting API возвращает { data: [{ dimensions:[{name}], metrics:[n,...] }], totals }.
 *  Разворачиваем в плоские записи по переданным именам колонок. */
function summarizeStat(json: unknown, columns: string[]): unknown {
  const j = json as { data?: Array<{ dimensions?: Array<{ name?: string }>; metrics?: number[] }>; totals?: number[][] }
  const rows = (j.data ?? []).map(row => {
    const rec: Record<string, unknown> = {}
    const dims = row.dimensions ?? []
    const mets = row.metrics ?? []
    let di = 0, mi = 0
    for (const col of columns) {
      // первая колонка(и) — измерения (date/source), остальные — метрики
      if (di < dims.length && (col === 'date' || col === 'source')) {
        rec[col] = dims[di]?.name ?? null; di++
      } else {
        rec[col] = mets[mi] ?? null; mi++
      }
    }
    return rec
  })
  return { rows: rows.length, data: rows, totals: j.totals?.[0] ?? null }
}
