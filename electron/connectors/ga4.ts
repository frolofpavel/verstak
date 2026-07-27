/**
 * Google Analytics 4 connector — веб-аналитика (трафик, источники, реалтайм).
 *
 * Своя реализация поверх официального GA4 Data API v1beta.
 * Зачем агентству: отчёты клиентам по трафику/конверсиям из GA4, источники
 * визитов, моментальный срез активных пользователей (realtime).
 *
 * Credentials (settings keys):
 *   ga4_access_token — OAuth Bearer token (scope analytics.readonly).
 *   ga4_property_id  — числовой ID ресурса GA4 (Property ID, без префикса).
 *   Нужны ОБА, иначе no-credentials.
 *
 * API:
 *   - Data API v1beta: https://analyticsdata.googleapis.com/v1beta
 *       Authorization: Bearer {token} · Content-Type: application/json · POST
 *       runReport:         POST /properties/{id}:runReport
 *       runRealtimeReport: POST /properties/{id}:runRealtimeReport
 *   Ответ rows[] = [{ dimensionValues:[{value}], metricValues:[{value}] }].
 *
 * Операции (args.op):
 *   run_report   — отчёт за период (date_from, date_to, metrics[], dimensions[]).
 *   get_realtime — активные пользователи прямо сейчас (по экранам).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const BASE = 'https://analyticsdata.googleapis.com/v1beta'

export function createGa4Connector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'ga4',
        label: 'Google Analytics 4',
        kind: 'ga4',
        requires: ['ga4_access_token', 'ga4_property_id'],
        status: 'ready',
        detail: 'GA4 Data API. OAuth token + property_id в settings (ga4_access_token, ga4_property_id).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('ga4_access_token')
      const propertyId = ctx.getSecret('ga4_property_id')
      if (!token || !propertyId) {
        return {
          error: 'no-credentials',
          message: 'GA4 token/property_id не настроены. Settings → Google Analytics 4. ' +
                   'Token: oauth (scope analytics.readonly). Property ID: GA4 → Администратор → Информация о ресурсе.'
        }
      }
      try {
        switch (op) {
          case 'run_report':   return await runReport(token, propertyId, args, ctx)
          case 'get_realtime': return await getRealtime(token, propertyId, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: run_report, get_realtime.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function runReport(
  token: string, propertyId: string, args: Record<string, unknown>, ctx: ConnectorContext
): Promise<unknown> {
  const metrics = toStringArray(args.metrics, ['activeUsers', 'sessions', 'screenPageViews'])
  const dimensions = toStringArray(args.dimensions, ['date'])
  if (metrics.length === 0) return { error: 'bad-args', message: 'run_report требует хотя бы одну метрику (metrics: string[]).' }
  const body = {
    dateRanges: [{ startDate: String(args.date_from ?? '7daysAgo'), endDate: String(args.date_to ?? 'today') }],
    dimensions: dimensions.map(name => ({ name })),
    metrics: metrics.map(name => ({ name }))
  }
  const json = await post(`${BASE}/properties/${propertyId}:runReport`, token, body, ctx)
  return expandRows(json, dimensions, metrics)
}

async function getRealtime(token: string, propertyId: string, ctx: ConnectorContext): Promise<unknown> {
  const dimensions = ['unifiedScreenName']
  const metrics = ['activeUsers']
  const body = {
    metrics: metrics.map(name => ({ name })),
    dimensions: dimensions.map(name => ({ name }))
  }
  const json = await post(`${BASE}/properties/${propertyId}:runRealtimeReport`, token, body, ctx)
  return expandRows(json, dimensions, metrics)
}

// ----------------------------------------------------------------- helpers

function toStringArray(raw: unknown, def: string[]): string[] {
  // Явный массив (даже пустой) возвращаем как есть — пустой metrics:[] должен
  // дойти до валидации bad-args, а не молча подмениться дефолтом. Дефолт — только
  // когда аргумент не передан (undefined) или не массив/строка.
  if (Array.isArray(raw)) {
    return raw.map(v => String(v).trim()).filter(Boolean)
  }
  if (typeof raw === 'string' && raw.trim()) return raw.split(',').map(s => s.trim()).filter(Boolean)
  return def
}

async function post(url: string, token: string, body: unknown, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body),
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь ga4_access_token / scope analytics.readonly / доступ к property)'
      : res.status === 429 ? ' (превышена квота GA4 Data API)' : ''
    throw new Error(`GA4 ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('GA4 вернул не-JSON ответ') }
}

/** GA4 Data API возвращает rows[] = [{ dimensionValues:[{value}], metricValues:[{value}] }].
 *  Разворачиваем в плоские записи: имена колонок = dimensions + metrics. */
function expandRows(json: unknown, dimensions: string[], metrics: string[]): unknown {
  const j = json as {
    rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>
    rowCount?: number
  }
  const rows = (j.rows ?? []).map(row => {
    const rec: Record<string, unknown> = {}
    const dims = row.dimensionValues ?? []
    const mets = row.metricValues ?? []
    dimensions.forEach((name, i) => { rec[name] = dims[i]?.value ?? null })
    metrics.forEach((name, i) => { rec[name] = mets[i]?.value ?? null })
    return rec
  })
  return { rows: rows.length, data: rows, rowCount: j.rowCount ?? rows.length }
}
