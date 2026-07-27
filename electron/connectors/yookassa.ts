/**
 * ЮКасса connector — платежи и возвраты (онлайн-эквайринг РФ).
 *
 * Своя реализация поверх официального YooKassa API v3.
 * Чужой код не используется — только публично документированные эндпоинты.
 *
 * Зачем агентству: сверка оплат клиентов (кто заплатил, на какую сумму,
 * статус платежа), мониторинг возвратов, выгрузка истории для отчётов.
 *
 * БЕЗОПАСНОСТЬ: коннектор ТОЛЬКО ЧИТАЕТ (GET). Создание платежей/возвратов —
 * это движение денег, поэтому намеренно не реализовано.
 *
 * Credentials (settings keys):
 *   yookassa_shop_id     — идентификатор магазина (shopId из ЛК ЮКассы).
 *   yookassa_secret_key  — секретный ключ API (live_... / test_...).
 *   Оба обязательны, иначе no-credentials.
 *
 * API:
 *   - Base: https://api.yookassa.ru/v3
 *   - Auth: Basic — Authorization: Basic base64(shop_id:secret_key).
 *     + Content-Type: application/json
 *
 * Операции (args.op):
 *   list_payments — последние платежи (опц. status, created_at_gte).
 *   get_payment   — один платёж по payment_id.
 *   list_refunds  — последние возвраты.
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const BASE = 'https://api.yookassa.ru/v3'

export function createYooKassaConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'yookassa',
        label: 'ЮКасса',
        kind: 'yookassa',
        requires: ['yookassa_shop_id', 'yookassa_secret_key'],
        status: 'ready',
        detail: 'Платежи и возвраты (только чтение). shopId + секретный ключ в settings (yookassa_shop_id, yookassa_secret_key).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const shopId = ctx.getSecret('yookassa_shop_id')
      const secretKey = ctx.getSecret('yookassa_secret_key')
      if (!shopId || !secretKey) {
        return {
          error: 'no-credentials',
          message: 'ЮКасса не настроена. Settings → коннектор ЮКасса → shopId + секретный ключ ' +
                   '(yookassa_shop_id, yookassa_secret_key). Берутся в ЛК: yookassa.ru → Настройки → API.'
        }
      }
      const auth = 'Basic ' + Buffer.from(`${shopId}:${secretKey}`).toString('base64')
      try {
        switch (op) {
          case 'list_payments': return await listPayments(auth, args, ctx)
          case 'get_payment':   return await getPayment(auth, args, ctx)
          case 'list_refunds':  return await listRefunds(auth, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_payments, get_payment, list_refunds.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listPayments(auth: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const params = new URLSearchParams({ limit: '10' })
  if (args.status) params.set('status', String(args.status))
  if (args.created_at_gte) params.set('created_at.gte', String(args.created_at_gte))
  const json = await get(`${BASE}/payments?${params}`, auth, ctx) as { items?: Array<Record<string, any>>; next_cursor?: string }
  const payments = (json.items ?? []).map(formatPayment)
  return { count: payments.length, payments }
}

async function getPayment(auth: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const id = String(args.payment_id ?? '').trim()
  if (!id) return { error: 'bad-args', message: 'get_payment требует payment_id.' }
  const json = await get(`${BASE}/payments/${encodeURIComponent(id)}`, auth, ctx) as Record<string, any>
  return formatPayment(json)
}

async function listRefunds(auth: string, _args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const params = new URLSearchParams({ limit: '10' })
  const json = await get(`${BASE}/refunds?${params}`, auth, ctx) as { items?: Array<Record<string, any>>; next_cursor?: string }
  const refunds = (json.items ?? []).map(formatRefund)
  return { count: refunds.length, refunds }
}

// ----------------------------------------------------------------- helpers

async function get(url: string, auth: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь yookassa_shop_id / yookassa_secret_key)'
      : ''
    throw new Error(`YooKassa ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('YooKassa вернула не-JSON ответ') }
}

// Извлекаем только нужные поля — компактный предсказуемый ответ вместо
// громоздкого объекта платежа (защита контекста + удобство для модели).

function formatPayment(p: Record<string, any>): unknown {
  return {
    id: p.id ?? null,
    status: p.status ?? null,
    amount: p.amount ? { value: p.amount.value ?? null, currency: p.amount.currency ?? null } : null,
    description: p.description ?? null,
    created_at: p.created_at ?? null,
    captured_at: p.captured_at ?? null,
    paid: p.paid ?? null,
    refunded_amount: p.refunded_amount
      ? { value: p.refunded_amount.value ?? null, currency: p.refunded_amount.currency ?? null }
      : null,
    payment_method: p.payment_method ? { type: p.payment_method.type ?? null } : null
  }
}

function formatRefund(r: Record<string, any>): unknown {
  return {
    id: r.id ?? null,
    status: r.status ?? null,
    amount: r.amount ? { value: r.amount.value ?? null, currency: r.amount.currency ?? null } : null,
    created_at: r.created_at ?? null,
    payment_id: r.payment_id ?? null
  }
}
