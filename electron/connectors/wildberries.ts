/**
 * Wildberries connector — статистика продаж/заказов/остатков продавца (РФ).
 *
 * Своя реализация поверх официального Wildberries Statistics API.
 * Зачем агентству: отчёты клиентам-продавцам WB по продажам, заказам и остаткам
 * на складах (выручка, ходовые артикулы, что заканчивается на складе).
 *
 * Credentials (settings keys):
 *   wildberries_token — токен из ЛК WB (Профиль → Настройки → Доступ к API,
 *                       категория «Статистика»). Передаётся как есть, без Bearer.
 *
 * API:
 *   - Statistics: https://statistics-api.wildberries.ru
 *       Authorization: {token} (БЕЗ префикса Bearer) · GET с ?dateFrom=YYYY-MM-DD
 *
 * Операции (args.op):
 *   get_sales  — продажи с даты (args.date_from, по умолчанию 7 дней назад).
 *   get_orders — заказы с даты.
 *   get_stocks — остатки на складах с даты последнего изменения.
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const STAT_BASE = 'https://statistics-api.wildberries.ru'
const MAX_ITEMS = 200

export function createWildberriesConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'wildberries',
        label: 'Wildberries',
        kind: 'wildberries',
        requires: ['wildberries_token'],
        status: 'ready',
        detail: 'Статистика продаж/заказов/остатков WB. Token в settings (wildberries_token).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('wildberries_token')
      if (!token) {
        return {
          error: 'no-token',
          message: 'Wildberries token не настроен. Settings → Wildberries. ' +
                   'Получить: ЛК WB → Профиль → Настройки → Доступ к API → категория «Статистика».'
        }
      }
      try {
        switch (op) {
          case 'get_sales':  return await getSales(token, args, ctx)
          case 'get_orders': return await getOrders(token, args, ctx)
          case 'get_stocks': return await getStocks(token, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: get_sales, get_orders, get_stocks.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function getSales(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const dateFrom = resolveDateFrom(args)
  if (typeof dateFrom !== 'string') return dateFrom
  const params = new URLSearchParams({ dateFrom })
  const json = await get(`${STAT_BASE}/api/v1/supplier/sales?${params}`, token, ctx)
  const items = asArray(json).slice(0, MAX_ITEMS).map(formatSale)
  return { count: items.length, sales: items }
}

async function getOrders(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const dateFrom = resolveDateFrom(args)
  if (typeof dateFrom !== 'string') return dateFrom
  const params = new URLSearchParams({ dateFrom })
  const json = await get(`${STAT_BASE}/api/v1/supplier/orders?${params}`, token, ctx)
  const items = asArray(json).slice(0, MAX_ITEMS).map(formatOrder)
  return { count: items.length, orders: items }
}

async function getStocks(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const dateFrom = resolveDateFrom(args)
  if (typeof dateFrom !== 'string') return dateFrom
  const params = new URLSearchParams({ dateFrom })
  const json = await get(`${STAT_BASE}/api/v1/supplier/stocks?${params}`, token, ctx)
  const items = asArray(json).slice(0, MAX_ITEMS).map(formatStock)
  return { count: items.length, stocks: items }
}

// ----------------------------------------------------------------- helpers

/** Дата начала выборки: args.date_from (YYYY-MM-DD) или 7 дней назад по умолчанию. */
function resolveDateFrom(args: Record<string, unknown>): string | { error: string; message: string } {
  const raw = String(args.date_from ?? '').trim()
  if (!raw) return daysAgo(7)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { error: 'bad-args', message: 'date_from должен быть в формате YYYY-MM-DD.' }
  }
  return raw
}

/** N дней назад в формате YYYY-MM-DD (UTC). */
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

function asArray(json: unknown): Array<Record<string, any>> {
  return Array.isArray(json) ? json as Array<Record<string, any>> : []
}

async function get(url: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'Authorization': token, 'Accept': 'application/json' },
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (проверь wildberries_token, категория «Статистика»)' : ''
    throw new Error(`Wildberries ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('Wildberries вернул не-JSON ответ') }
}

// Извлекаем только нужные поля — компактный предсказуемый ответ вместо
// громоздкого ответа WB (защита контекста + удобство для модели).

function formatSale(r: Record<string, any>): unknown {
  return {
    date: r.date ?? null,
    lastChangeDate: r.lastChangeDate ?? null,
    supplierArticle: r.supplierArticle ?? null,
    techSize: r.techSize ?? null,
    barcode: r.barcode ?? null,
    totalPrice: r.totalPrice ?? null,
    discountPercent: r.discountPercent ?? null,
    isRealization: r.isRealization ?? null,
    saleID: r.saleID ?? null,
    subject: r.subject ?? null,
    category: r.category ?? null,
    brand: r.brand ?? null,
    finishedPrice: r.finishedPrice ?? null
  }
}

function formatOrder(r: Record<string, any>): unknown {
  return {
    date: r.date ?? null,
    supplierArticle: r.supplierArticle ?? null,
    barcode: r.barcode ?? null,
    totalPrice: r.totalPrice ?? null,
    discountPercent: r.discountPercent ?? null,
    subject: r.subject ?? null,
    category: r.category ?? null,
    brand: r.brand ?? null,
    oblast: r.oblast ?? null
  }
}

function formatStock(r: Record<string, any>): unknown {
  return {
    lastChangeDate: r.lastChangeDate ?? null,
    supplierArticle: r.supplierArticle ?? null,
    barcode: r.barcode ?? null,
    quantity: r.quantity ?? null,
    warehouseName: r.warehouseName ?? null,
    subject: r.subject ?? null,
    category: r.category ?? null,
    brand: r.brand ?? null
  }
}
