/**
 * Ozon Seller connector — товары, остатки, аналитика и финансы продавца.
 *
 * Своя реализация поверх официального Ozon Seller API (Seller API).
 * Зачем агентству: контроль ассортимента и остатков клиента-продавца на Ozon,
 * отчёты по продажам (выручка/заказы) и сверка финансовых операций.
 *
 * Credentials (settings keys):
 *   ozon_client_id — Client-Id продавца (Seller → Настройки → API-ключи).
 *   ozon_api_key   — Api-Key (там же). Оба обязательны.
 *
 * API:
 *   - Base: https://api-seller.ozon.ru
 *     Все запросы POST, заголовки на каждый запрос:
 *       Client-Id: {client_id} · Api-Key: {api_key} · Content-Type: application/json
 *
 * Операции (args.op):
 *   list_products    — список товаров (product_id / offer_id).
 *   get_stocks       — остатки по складам (present / reserved / type).
 *   get_analytics    — выручка и заказы по дням (date_from, date_to обязательны).
 *   get_transactions — финансовые операции за период (date_from, date_to обязательны).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const BASE = 'https://api-seller.ozon.ru'

export function createOzonConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'ozon',
        label: 'Ozon Seller',
        kind: 'ozon',
        status: 'ready',
        detail: 'Товары, остатки, аналитика и финансы продавца. Client-Id + Api-Key в settings (ozon_client_id, ozon_api_key).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const clientId = ctx.getSecret('ozon_client_id')
      const apiKey = ctx.getSecret('ozon_api_key')
      if (!clientId || !apiKey) {
        return {
          error: 'no-credentials',
          message: 'Ozon Seller credentials не настроены. Settings → коннектор Ozon Seller → Client-Id и Api-Key. ' +
                   'Получить: Seller → Настройки → API-ключи (нужны оба: ozon_client_id, ozon_api_key).'
        }
      }
      try {
        switch (op) {
          case 'list_products':    return await listProducts(clientId, apiKey, ctx)
          case 'get_stocks':       return await getStocks(clientId, apiKey, ctx)
          case 'get_analytics':    return await getAnalytics(clientId, apiKey, args, ctx)
          case 'get_transactions': return await getTransactions(clientId, apiKey, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_products, get_stocks, get_analytics, get_transactions.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listProducts(clientId: string, apiKey: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await postJson(`${BASE}/v3/product/list`, clientId, apiKey, {
    filter: { visibility: 'ALL' }, last_id: '', limit: 100
  }, ctx) as { result?: { items?: Array<Record<string, any>> } }
  const items = (json.result?.items ?? []).map(formatProduct)
  return { count: items.length, items }
}

async function getStocks(clientId: string, apiKey: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await postJson(`${BASE}/v4/product/info/stocks`, clientId, apiKey, {
    filter: { visibility: 'ALL' }, limit: 100, last_id: ''
  }, ctx) as { result?: { items?: Array<Record<string, any>> } }
  const items = (json.result?.items ?? []).map(formatStock)
  return { count: items.length, items }
}

async function getAnalytics(clientId: string, apiKey: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const dateFrom = String(args.date_from ?? '').trim()
  const dateTo = String(args.date_to ?? '').trim()
  if (!dateFrom || !dateTo) {
    return { error: 'bad-args', message: 'get_analytics требует date_from и date_to (YYYY-MM-DD).' }
  }
  const json = await postJson(`${BASE}/v1/analytics/data`, clientId, apiKey, {
    date_from: dateFrom,
    date_to: dateTo,
    metrics: ['revenue', 'ordered_units'],
    dimension: ['day'],
    limit: 100
  }, ctx) as { result?: { data?: Array<{ dimensions?: Array<{ id?: string; name?: string }>; metrics?: number[] }> } }
  const rows = (json.result?.data ?? []).map(formatAnalyticsRow)
  return { count: rows.length, rows }
}

async function getTransactions(clientId: string, apiKey: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const dateFrom = String(args.date_from ?? '').trim()
  const dateTo = String(args.date_to ?? '').trim()
  if (!dateFrom || !dateTo) {
    return { error: 'bad-args', message: 'get_transactions требует date_from и date_to (YYYY-MM-DD).' }
  }
  // 2.0.1 bug: раньше брали только page:1 (100 операций) — при сверке финансов
  // хвост молча терялся. Пагинируем по page_count (кап 50 стр = 5000 операций).
  const filter = {
    date: { from: `${dateFrom}T00:00:00.000Z`, to: `${dateTo}T23:59:59.999Z` },
    transaction_type: 'all'
  }
  const MAX_PAGES = 50
  const operations: Array<ReturnType<typeof formatTransaction>> = []
  let truncated = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await postJson(`${BASE}/v3/finance/transaction/list`, clientId, apiKey, {
      filter, page, page_size: 100
    }, ctx) as { result?: { operations?: Array<Record<string, any>>; page_count?: number } }
    const ops = json.result?.operations ?? []
    operations.push(...ops.map(formatTransaction))
    const pageCount = json.result?.page_count ?? 1
    if (page >= pageCount) break
    if (page === MAX_PAGES) truncated = true
  }
  return { count: operations.length, operations, ...(truncated ? { truncated: true, note: `Показаны первые ${MAX_PAGES}×100 операций — сузь период для полноты.` } : {}) }
}

// ----------------------------------------------------------------- helpers

async function postJson(
  url: string,
  clientId: string,
  apiKey: string,
  payload: unknown,
  ctx: ConnectorContext
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Client-Id': clientId,
      'Api-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь ozon_client_id / ozon_api_key)'
      : res.status === 429 ? ' (превышен лимит запросов Ozon)' : ''
    throw new Error(`Ozon ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('Ozon вернул не-JSON ответ') }
}

// Извлекаем только нужные поля — компактный предсказуемый ответ вместо
// громоздкого Ozon result (защита контекста + удобство для модели).

function formatProduct(p: Record<string, any>): unknown {
  return {
    product_id: p.product_id ?? null,
    offer_id: p.offer_id ?? null
  }
}

function formatStock(s: Record<string, any>): unknown {
  return {
    offer_id: s.offer_id ?? null,
    product_id: s.product_id ?? null,
    stocks: Array.isArray(s.stocks)
      ? s.stocks.map((st: Record<string, any>) => ({
          present: st.present ?? null,
          reserved: st.reserved ?? null,
          type: st.type ?? null
        }))
      : []
  }
}

function formatAnalyticsRow(row: { dimensions?: Array<{ id?: string; name?: string }>; metrics?: number[] }): unknown {
  const dims = row.dimensions ?? []
  const mets = row.metrics ?? []
  return {
    date: dims[0]?.id ?? dims[0]?.name ?? null,
    revenue: mets[0] ?? null,
    ordered_units: mets[1] ?? null
  }
}

function formatTransaction(t: Record<string, any>): unknown {
  return {
    operation_id: t.operation_id ?? null,
    operation_type: t.operation_type ?? null,
    amount: t.amount ?? null,
    operation_date: t.operation_date ?? null
  }
}
