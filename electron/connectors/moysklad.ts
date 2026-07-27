/**
 * МойСклад connector — товары, заказы покупателей, складские остатки (РФ).
 *
 * Своя реализация поверх официального МойСклад JSON API 1.2.
 * Чужой код не используется — только публично документированные эндпоинты.
 * Сверено по https://dev.moysklad.ru/doc/api/remap/1.2/ (формат rows[], поля).
 *
 * Зачем агентству: у клиентов товарка — остатки и заказы нужны для отчётов,
 * сверки наличия под рекламу, выгрузки ассортимента. Только чтение.
 *
 * Credentials (settings keys):
 *   moysklad_token — Bearer access token (Профиль → Настройки → Токен доступа).
 *
 * API:
 *   Base: https://api.moysklad.ru/api/remap/1.2
 *   Auth: Authorization: Bearer {token} · Accept: application/json;charset=utf-8
 *   Списки/отчёты приходят в конверте { meta, rows: [...] }.
 *
 * Операции (args.op):
 *   list_products — товары (GET /entity/product?limit=100).
 *   list_orders   — заказы покупателей (GET /entity/customerorder?limit=100).
 *   get_stock     — остатки по складам (GET /report/stock/all?limit=100).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const BASE = 'https://api.moysklad.ru/api/remap/1.2'

export function createMoySkladConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'moysklad',
        label: 'МойСклад',
        kind: 'moysklad',
        requires: ['moysklad_token'],
        status: 'ready',
        detail: 'Товары, заказы, остатки. Bearer token в settings (moysklad_token).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('moysklad_token')
      if (!token) {
        return {
          error: 'no-token',
          message: 'МойСклад token не настроен. Settings → коннектор МойСклад → token. ' +
                   'Получить: Профиль → Настройки → Токен доступа (online.moysklad.ru).'
        }
      }
      try {
        switch (op) {
          case 'list_products': return await listProducts(token, ctx)
          case 'list_orders':   return await listOrders(token, ctx)
          case 'get_stock':     return await getStock(token, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_products, list_orders, get_stock.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listProducts(token: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${BASE}/entity/product?limit=100`, token, ctx)
  const rows = ((json as { rows?: Array<Record<string, any>> }).rows) ?? []
  return { count: rows.length, products: rows.map(formatProduct) }
}

async function listOrders(token: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${BASE}/entity/customerorder?limit=100`, token, ctx)
  const rows = ((json as { rows?: Array<Record<string, any>> }).rows) ?? []
  return { count: rows.length, orders: rows.map(formatOrder) }
}

async function getStock(token: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${BASE}/report/stock/all?limit=100`, token, ctx)
  const rows = ((json as { rows?: Array<Record<string, any>> }).rows) ?? []
  return { count: rows.length, stock: rows.map(formatStock) }
}

// ----------------------------------------------------------------- helpers

async function get(url: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json;charset=utf-8'
    },
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь moysklad_token — Профиль → Настройки → Токен доступа)'
      : res.status === 429 ? ' (превышен лимит запросов МойСклад)' : ''
    throw new Error(`МойСклад ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('МойСклад вернул не-JSON ответ') }
}

// Извлекаем только нужные плоские поля — компактный предсказуемый ответ
// вместо громоздкого объекта МойСклад (защита контекста + удобство модели).

function formatProduct(r: Record<string, any>): unknown {
  return {
    id: r.id ?? null,
    name: r.name ?? '',
    code: r.code ?? null,
    article: r.article ?? null
  }
}

function formatOrder(r: Record<string, any>): unknown {
  return {
    id: r.id ?? null,
    name: r.name ?? '',
    moment: r.moment ?? null,           // дата документа
    sum: r.sum ?? null                  // сумма заказа (в копейках)
  }
}

function formatStock(r: Record<string, any>): unknown {
  return {
    name: r.name ?? '',
    article: r.article ?? r.code ?? null,   // в отчёте остатков артикул не всегда есть — fallback на code
    stock: r.stock ?? null,                 // физический остаток
    reserve: r.reserve ?? null,             // резерв
    quantity: r.quantity ?? null            // доступно
  }
}
