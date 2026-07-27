/**
 * MPSTATS connector — аналитика маркетплейсов (Wildberries).
 *
 * Своя реализация поверх официального MPSTATS API. Только чтение.
 * Чужой код не используется — лишь публично документированные эндпоинты.
 *
 * Зачем агентству: оценка ниши и товаров клиента на WB — объёмы продаж и
 * выручка по категории, динамика продаж/цены конкретного артикула (SKU).
 * Питает аналитику для КП, аудитов карточек и рекомендаций по ассортименту.
 *
 * Credentials (settings keys):
 *   mpstats_token — токен API MPSTATS (Профиль → API). Иначе no-token.
 *
 * API:
 *   Base: https://mpstats.io/api
 *   Auth: header X-Mpstats-TOKEN: {token} + Content-Type: application/json
 *   Документация: https://mpstats.io/api · https://mpstats.io/integrations/docs/description/
 *
 * Операции (args.op) — консервативно, только проверенные по доке эндпоинты:
 *   wb_category  — товары категории WB по path за период (POST /wb/get/category,
 *                  path/d1/d2 в query, пагинация в body). Документирован.
 *   wb_item_sales— динамика продаж/цены артикула WB по sku за период
 *                  (GET /wb/get/item/{sku}/sales?d1&d2). Подтверждён рабочим.
 *
 * Прим.: эндпоинты вида /wb/get/item/{sku}/card и /prices в публичных
 * примерах отдают 405 — намеренно не реализованы (выдуманный путь = баг).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API = 'https://mpstats.io/api'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function createMpStatsConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'mpstats',
        label: 'MPSTATS',
        kind: 'mpstats',
        requires: ['mpstats_token'],
        status: 'ready',
        detail: 'Аналитика WB: категория и продажи артикула. Token в settings (mpstats_token).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('mpstats_token')
      if (!token) {
        return {
          error: 'no-token',
          message: 'MPSTATS token не настроен. Settings → коннектор MPSTATS → token. ' +
                   'Получить: профиль MPSTATS → раздел API (https://mpstats.io/api).'
        }
      }
      try {
        switch (op) {
          case 'wb_category':   return await wbCategory(token, args, ctx)
          case 'wb_item_sales': return await wbItemSales(token, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: wb_category, wb_item_sales.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function wbCategory(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const path = String(args.path ?? '').trim()
  if (!path) return { error: 'bad-args', message: 'wb_category требует path — путь категории WB (например «Женщинам/Платья»).' }
  const dateErr = checkDates(args)
  if (dateErr) return dateErr
  const startRow = Math.max(0, Number(args.start_row ?? 0) || 0)
  const endRow = Math.max(startRow + 1, Math.min(startRow + 50, Number(args.end_row ?? startRow + 50) || startRow + 50))
  const params = new URLSearchParams({ path, d1: String(args.d1 ?? ''), d2: String(args.d2 ?? '') })
  // Пагинация и сортировка — в теле (формат ag-grid, как в доке MPSTATS).
  const body = { startRow, endRow, filterModel: {}, sortModel: [{ colId: 'revenue', sort: 'desc' }] }
  const json = await postJson(`${API}/wb/get/category?${params}`, token, body, ctx) as {
    data?: Array<Record<string, any>>; total?: any
  }
  const items = (json.data ?? []).map(formatCategoryItem)
  return { path, count: items.length, total: json.total ?? null, items }
}

async function wbItemSales(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const sku = String(args.sku ?? '').trim()
  if (!sku) return { error: 'bad-args', message: 'wb_item_sales требует sku — артикул WB.' }
  const dateErr = checkDates(args)
  if (dateErr) return dateErr
  const params = new URLSearchParams({ d1: String(args.d1 ?? ''), d2: String(args.d2 ?? '') })
  const json = await getJson(`${API}/wb/get/item/${encodeURIComponent(sku)}/sales?${params}`, token, ctx)
  // API отдаёт массив дневных срезов; возвращаем плоско ключевые поля + сводку.
  const rows = Array.isArray(json) ? (json as Array<Record<string, any>>).map(formatSalesRow) : []
  return { sku, days: rows.length, sales: rows }
}

// ----------------------------------------------------------------- helpers

function checkDates(args: Record<string, unknown>): { error: string; message: string } | null {
  const d1 = String(args.d1 ?? '').trim()
  const d2 = String(args.d2 ?? '').trim()
  if (!DATE_RE.test(d1) || !DATE_RE.test(d2)) {
    return { error: 'bad-args', message: 'Нужны d1 и d2 в формате YYYY-MM-DD (начало и конец периода).' }
  }
  return null
}

async function getJson(url: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, { headers: authHeaders(token), signal: ctx.signal })
  return parse(res)
}

async function postJson(url: string, token: string, body: unknown, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body), signal: ctx.signal })
  return parse(res)
}

function authHeaders(token: string): Record<string, string> {
  return { 'X-Mpstats-TOKEN': token, 'Content-Type': 'application/json', 'Accept': 'application/json' }
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь mpstats_token)'
      : res.status === 429 ? ' (превышен лимит запросов MPSTATS)' : ''
    throw new Error(`MPSTATS ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('MPSTATS вернул не-JSON ответ') }
}

// Плоские ключевые поля вместо громоздкого ответа MPSTATS (защита контекста).

function formatCategoryItem(d: Record<string, any>): unknown {
  return {
    sku: d.id ?? d.sku ?? null,
    name: d.name ?? null,
    brand: d.brand ?? null,
    seller: d.seller ?? null,
    price: d.final_price ?? d.price ?? null,
    rating: d.rating ?? null,
    comments: d.comments ?? null,
    sales: d.sales ?? null,            // продажи за период (шт)
    revenue: d.revenue ?? null,        // выручка за период
    balance: d.balance ?? null,        // остаток
    url: d.url ?? null
  }
}

function formatSalesRow(d: Record<string, any>): unknown {
  return {
    date: d.data ?? d.date ?? null,
    sales: d.sales ?? null,            // продано за день (шт)
    price: d.price ?? d.final_price ?? null,
    balance: d.balance ?? null,        // остаток на складе
    revenue: d.revenue ?? null
  }
}
