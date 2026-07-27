/**
 * amoCRM connector — сделки, контакты, воронки (CRM v4).
 *
 * Своя реализация поверх официального amoCRM API v4.
 * Зачем агентству: смотреть сделки/контакты клиента прямо в чате, выгружать
 * воронки и статусы для отчётов, подтягивать карточку сделки к КП/звонку.
 *
 * Credentials (settings keys):
 *   amocrm_subdomain     — поддомен аккаунта (напр. mycompany — без .amocrm.ru).
 *   amocrm_access_token  — long-lived токен интеграции (private integration).
 *   Без любого из двух — no-credentials.
 *
 * API:
 *   - Base: https://{subdomain}.amocrm.ru/api/v4
 *       Authorization: Bearer {token} · Content-Type: application/json · GET
 *   - Данные приходят в _embedded. Пустой ответ / 204 — пустой список.
 *
 * Операции (args.op):
 *   list_leads     — сделки (page, limit ≤ 250).
 *   list_contacts  — контакты (page, limit ≤ 250).
 *   list_pipelines — воронки со статусами.
 *   get_lead       — карточка сделки по lead_id (с контактами).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

function clampLimit(raw: unknown, def = 50): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.max(1, Math.min(250, Math.trunc(n)))
}

function clampPage(raw: unknown, def = 1): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.max(1, Math.trunc(n))
}

export function createAmoCrmConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'amocrm',
        label: 'amoCRM',
        kind: 'amocrm',
        requires: ['amocrm_subdomain', 'amocrm_access_token'],
        status: 'ready',
        detail: 'Сделки, контакты, воронки. Поддомен + long-lived токен в settings (amocrm_subdomain, amocrm_access_token).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const subdomain = ctx.getSecret('amocrm_subdomain')
      const token = ctx.getSecret('amocrm_access_token')
      if (!subdomain || !token) {
        return {
          error: 'no-credentials',
          message: 'amoCRM не настроен. Settings → коннектор amoCRM → поддомен (amocrm_subdomain) ' +
                   'и long-lived токен интеграции (amocrm_access_token).'
        }
      }
      const base = `https://${subdomain}.amocrm.ru/api/v4`
      try {
        switch (op) {
          case 'list_leads':     return await listLeads(base, token, args, ctx)
          case 'list_contacts':  return await listContacts(base, token, args, ctx)
          case 'list_pipelines': return await listPipelines(base, token, ctx)
          case 'get_lead':       return await getLead(base, token, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_leads, list_contacts, list_pipelines, get_lead.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listLeads(base: string, token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const params = new URLSearchParams({
    page: String(clampPage(args.page)),
    limit: String(clampLimit(args.limit))
  })
  const json = await get(`${base}/leads?${params}`, token, ctx)
  const items = embedded(json, 'leads').map(formatLead)
  return { count: items.length, leads: items }
}

async function listContacts(base: string, token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const params = new URLSearchParams({
    page: String(clampPage(args.page)),
    limit: String(clampLimit(args.limit))
  })
  const json = await get(`${base}/contacts?${params}`, token, ctx)
  const items = embedded(json, 'contacts').map(formatContact)
  return { count: items.length, contacts: items }
}

async function listPipelines(base: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${base}/leads/pipelines`, token, ctx)
  const items = embedded(json, 'pipelines').map(formatPipeline)
  return { count: items.length, pipelines: items }
}

async function getLead(base: string, token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const id = String(args.lead_id ?? '').trim()
  if (!id) return { error: 'bad-args', message: 'get_lead требует lead_id.' }
  const json = await get(`${base}/leads/${encodeURIComponent(id)}?with=contacts`, token, ctx)
  return formatLead(json as Record<string, any>)
}

// ----------------------------------------------------------------- helpers

async function get(url: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    signal: ctx.signal
  })
  // amoCRM возвращает 204 (No Content) на пустых выборках — это не ошибка.
  if (res.status === 204) return {}
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь amocrm_access_token — нужен long-lived токен интеграции)'
      : ''
    throw new Error(`amoCRM ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  if (!text) return {}
  try { return JSON.parse(text) } catch { throw new Error('amoCRM вернул не-JSON ответ') }
}

/** Достаём массив из _embedded.{key}; пусто — []. */
function embedded(json: unknown, key: string): Array<Record<string, any>> {
  const j = json as { _embedded?: Record<string, unknown> }
  const arr = j._embedded?.[key]
  return Array.isArray(arr) ? arr as Array<Record<string, any>> : []
}

// Извлекаем только нужные поля — компактный предсказуемый ответ вместо
// громоздкого amoCRM объекта (защита контекста + удобство для модели).

function formatLead(l: Record<string, any>): unknown {
  return {
    id: l.id ?? null,
    name: l.name ?? null,
    price: l.price ?? null,
    status_id: l.status_id ?? null,
    pipeline_id: l.pipeline_id ?? null,
    responsible_user_id: l.responsible_user_id ?? null,
    created_at: l.created_at ?? null,
    updated_at: l.updated_at ?? null
  }
}

function formatContact(c: Record<string, any>): unknown {
  return {
    id: c.id ?? null,
    name: c.name ?? null,
    responsible_user_id: c.responsible_user_id ?? null,
    created_at: c.created_at ?? null
  }
}

function formatPipeline(p: Record<string, any>): unknown {
  const statuses = Array.isArray(p._embedded?.statuses)
    ? (p._embedded.statuses as Array<Record<string, any>>).map(s => ({ id: s.id ?? null, name: s.name ?? null }))
    : []
  return {
    id: p.id ?? null,
    name: p.name ?? null,
    statuses
  }
}
