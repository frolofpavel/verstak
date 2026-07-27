/**
 * UniSender connector — email/SMS-рассылки (РФ): списки, кампании, статистика.
 *
 * Своя реализация поверх официального UniSender API (api.unisender.com/ru/api).
 * Чужой код не используется — только публично документированные методы.
 *
 * Зачем агентству: у многих клиентов рассылки идут через UniSender —
 * отчёты по кампаниям (доставка/открытия/клики), список адресных баз,
 * перечень отправленных рассылок для сводки клиенту.
 *
 * Credentials (settings keys):
 *   unisender_api_key — API-ключ (личный кабинет → Настройки → API и интеграции).
 *
 * API:
 *   База: https://api.unisender.com/ru/api · метод в пути: /{method}
 *   Авторизация query-параметрами: ?format=json&api_key={key}&...  (метод GET).
 *   Ответ — {result: ...} при успехе ИЛИ {error: ..., code: ...} при ошибке.
 *
 * Операции (args.op):
 *   get_lists          — адресные базы аккаунта (getLists).
 *   get_campaigns      — отправленные рассылки за период (getCampaigns, нужен from).
 *   get_campaign_stats — сводная статистика по кампании (getCampaignCommonStats, campaign_id).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API_BASE = 'https://api.unisender.com/ru/api'

export function createUniSenderConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'unisender',
        label: 'UniSender',
        kind: 'unisender',
        requires: ['unisender_api_key'],
        status: 'ready',
        detail: 'Email/SMS-рассылки: списки, кампании, статистика. API-ключ в settings (unisender_api_key).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const apiKey = ctx.getSecret('unisender_api_key')
      if (!apiKey) {
        return {
          error: 'no-token',
          message: 'UniSender API-ключ не настроен. Settings → коннектор UniSender → API key. ' +
                   'Получить: личный кабинет UniSender → Настройки → API и интеграции.'
        }
      }
      try {
        switch (op) {
          case 'get_lists':          return await getLists(apiKey, ctx)
          case 'get_campaigns':      return await getCampaigns(apiKey, args, ctx)
          case 'get_campaign_stats': return await getCampaignStats(apiKey, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: get_lists, get_campaigns, get_campaign_stats.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function getLists(apiKey: string, ctx: ConnectorContext): Promise<unknown> {
  const result = await call('getLists', apiKey, {}, ctx) as Array<Record<string, any>>
  const lists = (Array.isArray(result) ? result : []).map(formatList)
  return { count: lists.length, lists }
}

async function getCampaigns(apiKey: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  // getCampaigns требует обязательный from (datetime UTC). По умолчанию — за 30 дней.
  const params: Record<string, string> = { from: String(args.from ?? daysAgoUTC(30)) }
  if (args.to) params.to = String(args.to)
  params.limit = String(clampLimit(args.limit))
  if (args.offset != null) params.offset = String(Math.max(0, Number(args.offset) || 0))
  const result = await call('getCampaigns', apiKey, params, ctx) as Array<Record<string, any>>
  const campaigns = (Array.isArray(result) ? result : []).map(formatCampaign)
  return { count: campaigns.length, campaigns }
}

async function getCampaignStats(apiKey: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const campaignId = String(args.campaign_id ?? '').trim()
  if (!campaignId) return { error: 'bad-args', message: 'get_campaign_stats требует campaign_id (id рассылки из get_campaigns).' }
  const result = await call('getCampaignCommonStats', apiKey, { campaign_id: campaignId }, ctx)
  return result
}

// ----------------------------------------------------------------- helpers

async function call(
  method: string,
  apiKey: string,
  params: Record<string, string>,
  ctx: ConnectorContext
): Promise<unknown> {
  const qs = new URLSearchParams({ format: 'json', api_key: apiKey, ...params })
  const res = await fetch(`${API_BASE}/${method}?${qs}`, {
    headers: { 'Accept': 'application/json' },
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (проверь unisender_api_key)' : ''
    throw new Error(`UniSender ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new Error('UniSender вернул не-JSON ответ') }
  const body = json as { result?: unknown; error?: string; code?: string }
  // UniSender отдаёт {error, code} даже при HTTP 200 — это тоже ошибка.
  if (body.error) {
    const code = body.code ? ` [${body.code}]` : ''
    const hint = body.code === 'invalid_api_key' ? ' (проверь unisender_api_key)' : ''
    throw new Error(`UniSender ${method}: ${body.error}${code}${hint}`)
  }
  return body.result
}

function clampLimit(raw: unknown, def = 100): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.max(1, Math.min(10000, Math.trunc(n)))
}

function daysAgoUTC(n: number): string {
  // Формат UniSender: "YYYY-MM-DD HH:MM:SS" (UTC).
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
}

// Извлекаем только нужные плоские поля — компактный предсказуемый ответ
// вместо громоздких объектов UniSender (защита контекста + удобство для модели).

function formatList(l: Record<string, any>): unknown {
  return {
    id: l.id ?? null,
    title: l.title ?? null
  }
}

function formatCampaign(c: Record<string, any>): unknown {
  // У UniSender кампания идентифицируется темой письма (subject) и message_id —
  // отдельного name в ответе getCampaigns нет.
  return {
    id: c.id ?? null,
    status: c.status ?? null,
    start_time: c.start_time ?? null,
    subject: c.subject ?? null,
    message_id: c.message_id ?? null,
    list_id: c.list_id ?? null
  }
}
