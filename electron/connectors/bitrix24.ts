/**
 * Bitrix24 connector — через входящий webhook (incoming webhook).
 *
 * Источник: V3 Plan раздел 5.4. Пилот клиент — example.
 *
 * Credentials (settings keys):
 *   bitrix24_webhook_url    — полный URL вида
 *                              https://{portal}.bitrix24.ru/rest/{user_id}/{token}/
 *                             (создаётся в Битрикс24: «Разработчикам» →
 *                              «Другое» → «Входящий вебхук»).
 *
 * Безопасность:
 *   - URL содержит token, поэтому хранится в safeStorage.
 *   - READ-ONLY (аудит B5): любой метод с write-глаголом (add/update/delete/
 *     set/import/…) запрещён в chokepoint callMethod → инвариант «все 31
 *     коннектора read-only» соблюдён. Прежний denylist на 5 *.delete оставлен
 *     как доп.слой. Generic call ограничен read-namespace + тем же гейтом.
 *
 * API style: Битрикс REST использует «методы» как путь после webhook,
 * формат crm.deal.list и т.п. Аргументы — JSON body или URL-encoded query.
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const DENIED_METHODS = new Set([
  'crm.deal.delete',
  'crm.lead.delete',
  'crm.contact.delete',
  'crm.company.delete',
  'user.delete'
])

const ALLOWED_PREFIXES = ['crm.', 'tasks.', 'task.', 'user.']
const ALLOWED_EXACT_METHODS = new Set(['profile'])

export function createBitrix24Connector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'bitrix24',
        label: 'Битрикс24',
        kind: 'bitrix24',
        status: 'ready',
        detail: 'Incoming webhook URL в settings (bitrix24_webhook_url). Пилот: example.'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const webhook = (ctx.getSecret('bitrix24_webhook_url') ?? '').trim()
      if (!webhook) {
        return {
          error: 'no-webhook',
          message: 'Webhook URL не настроен. Settings → введи bitrix24_webhook_url.\n' +
                   'Где взять: в Битрикс24 → Разработчикам → Другое → Входящий вебхук → копируй полный URL.'
        }
      }
      const webhookError = validateBitrixWebhookUrl(webhook)
      if (webhookError) {
        return { error: 'invalid-webhook-url', message: webhookError }
      }

      try {
        switch (op) {
          case 'list_deals':         return await listDeals(webhook, args, ctx)
          case 'get_deal':           return await callMethod(webhook, 'crm.deal.get', { id: args.deal_id }, ctx)
          case 'list_leads':         return await listLeads(webhook, args, ctx)
          case 'get_source_report':  return await getSourceReport(webhook, args, ctx)
          case 'call':               return await rawCall(webhook, args, ctx)
          // Аудит B5: write-операции (add_deal/update_deal/add_activity) убраны —
          // коннектор read-only. Запись в чужой CRM нарушала бы инвариант.
          case 'add_deal':
          case 'update_deal':
          case 'add_activity':
            return { error: 'read-only', message: `Коннектор Битрикс24 — read-only. Операция «${op}» (запись в CRM) недоступна.` }
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно (read-only): list_deals, get_deal, list_leads, get_source_report, call.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listDeals(webhook: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const filter: Record<string, unknown> = {}
  if (args.stage) filter.STAGE_ID = args.stage
  if (args.source) filter.SOURCE_ID = args.source
  if (args.period) {
    // period = 'this_month' | 'last_30d' | ISO
    const since = parsePeriod(String(args.period))
    if (since) filter['>=DATE_CREATE'] = since
  }
  const select = (args.select as string[] | undefined) ?? ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'SOURCE_ID', 'DATE_CREATE', 'COMPANY_TITLE', 'ASSIGNED_BY_ID']
  return await callMethod(webhook, 'crm.deal.list', { filter, select, order: { DATE_CREATE: 'DESC' } }, ctx)
}

async function listLeads(webhook: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const filter = (args.filter as Record<string, unknown>) ?? {}
  return await callMethod(webhook, 'crm.lead.list', { filter, order: { DATE_CREATE: 'DESC' } }, ctx)
}

async function getSourceReport(webhook: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  // Простейшая агрегация: list deals за период + groupBy SOURCE_ID на клиенте.
  const since = args.period ? parsePeriod(String(args.period)) : undefined
  const filter: Record<string, unknown> = since ? { '>=DATE_CREATE': since } : {}
  const deals = await callMethod(webhook, 'crm.deal.list', {
    filter, select: ['ID', 'SOURCE_ID', 'OPPORTUNITY', 'STAGE_ID']
  }, ctx) as { result?: Array<{ SOURCE_ID?: string; OPPORTUNITY?: string; STAGE_ID?: string }> }
  const bySource: Record<string, { count: number; total: number; won: number }> = {}
  for (const d of deals.result ?? []) {
    const src = d.SOURCE_ID ?? 'UNKNOWN'
    const opp = parseFloat(d.OPPORTUNITY ?? '0') || 0
    if (!bySource[src]) bySource[src] = { count: 0, total: 0, won: 0 }
    bySource[src].count++
    bySource[src].total += opp
    if (d.STAGE_ID && /WON|SUCCESS/i.test(d.STAGE_ID)) bySource[src].won++
  }
  return { period: args.period, sources: bySource, total_deals: deals.result?.length ?? 0 }
}

async function rawCall(webhook: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const method = String(args.method ?? '')
  if (!method) return { error: 'bad-args', message: 'call требует method (например crm.deal.list)' }
  const isAllowed = ALLOWED_EXACT_METHODS.has(method) || ALLOWED_PREFIXES.some(p => method.startsWith(p))
  if (!isAllowed) return { error: 'blocked', message: `Метод «${method}» не в allowed prefixes (${ALLOWED_PREFIXES.join(', ')}).` }
  if (DENIED_METHODS.has(method)) return { error: 'blocked', message: `Метод «${method}» в denylist.` }
  // Аудит B5: read-only — write-глаголы блокируем чисто (а не через throw в callMethod).
  const verb = method.split('.').pop()?.toLowerCase() ?? ''
  if (WRITE_VERBS.has(verb)) return { error: 'read-only', message: `Метод «${method}» пишет в CRM (глагол «${verb}») — коннектор read-only.` }
  const params = (args.params as Record<string, unknown>) ?? {}
  return await callMethod(webhook, method, params, ctx)
}

// ----------------------------------------------------------------- helpers

// Аудит B5: инвариант «все 31 коннектора read-only». Bitrix умел писать в CRM
// (crm.deal.add/update, crm.activity.add), denylist ловил только 5 *.delete.
// Гейт по write-глаголу в единственном chokepoint делает ВЕСЬ коннектор
// read-only разом — независимо от op и от generic call.
const WRITE_VERBS = new Set([
  'add', 'update', 'delete', 'set', 'import', 'register', 'unregister', 'bind', 'unbind', 'start', 'finish', 'save',
  // Мутирующие методы Bitrix, чей последний сегмент — НЕ add/update/delete:
  // задачи (tasks.task.*) и общие модульные операции под allowed-префиксами.
  'create', 'complete', 'renew', 'defer', 'approve', 'disapprove', 'delegate', 'pause',
  'send', 'attach', 'move', 'copy', 'rename', 'upload', 'uploadfile', 'commit',
  'close', 'cancel', 'archive', 'restore', 'merge', 'transfer', 'expose',
  'startwatch', 'stopwatch', 'mute', 'unmute', 'pin', 'unpin',
])

function validateBitrixWebhookUrl(webhook: string): string | null {
  let url: URL
  try {
    url = new URL(webhook)
  } catch {
    if (/^(y0__|AQVN)/i.test(webhook)) {
      return '\u0412 \u043f\u043e\u043b\u0435 \u0411\u0438\u0442\u0440\u0438\u043a\u044124 \u0432\u0441\u0442\u0430\u0432\u043b\u0435\u043d \u0442\u043e\u043a\u0435\u043d \u042f\u043d\u0434\u0435\u043a\u0441\u0430, \u0430 \u043d\u0443\u0436\u0435\u043d \u043f\u043e\u043b\u043d\u044b\u0439 URL \u0432\u0445\u043e\u0434\u044f\u0449\u0435\u0433\u043e webhook \u0438\u0437 \u0411\u0438\u0442\u0440\u0438\u043a\u044124 \u0432\u0438\u0434\u0430 https://...bitrix24.ru/rest/USER_ID/TOKEN/'
    }
    return '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u044b\u0439 Bitrix24 webhook URL. \u041d\u0443\u0436\u0435\u043d \u043f\u043e\u043b\u043d\u044b\u0439 URL \u0432\u0438\u0434\u0430 https://...bitrix24.ru/rest/USER_ID/TOKEN/'
  }
  if (!/^https?:$/.test(url.protocol)) {
    return '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u044b\u0439 Bitrix24 webhook URL. \u0410\u0434\u0440\u0435\u0441 \u0434\u043e\u043b\u0436\u0435\u043d \u043d\u0430\u0447\u0438\u043d\u0430\u0442\u044c\u0441\u044f \u0441 https://'
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const restIndex = parts.findIndex(part => part.toLowerCase() === 'rest')
  if (restIndex < 0 || parts.length < restIndex + 3) {
    return '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u044b\u0439 Bitrix24 webhook URL. \u0421\u043a\u043e\u043f\u0438\u0440\u0443\u0439 \u043f\u043e\u043b\u043d\u044b\u0439 \u0432\u0445\u043e\u0434\u044f\u0449\u0438\u0439 webhook, \u0432 \u043d\u0451\u043c \u0434\u043e\u043b\u0436\u0435\u043d \u0431\u044b\u0442\u044c \u043f\u0443\u0442\u044c /rest/USER_ID/TOKEN/'
  }
  return null
}

async function callMethod(webhook: string, method: string, params: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  if (DENIED_METHODS.has(method)) {
    throw new Error(`Method ${method} blocked by denylist`)
  }
  const verb = method.split('.').pop()?.toLowerCase() ?? ''
  if (WRITE_VERBS.has(verb)) {
    throw new Error(`Bitrix24 read-only: метод ${method} пишет в CRM (глагол «${verb}») и запрещён`)
  }
  const url = `${webhook.replace(/\/+$/, '')}/${method}.json`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Bitrix24 ${method} ${res.status}: ${text.slice(0, 400)}`)
  try { return JSON.parse(text) } catch { return { _raw: text } }
}

function parsePeriod(period: string): string | null {
  // Возвращает ISO date string для filter['>=DATE_CREATE']
  const now = new Date()
  if (period === 'this_month') {
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  }
  if (period === 'last_30d') {
    return new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString()
  }
  if (period === 'last_7d') {
    return new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()
  }
  // ISO
  const d = new Date(period)
  if (!isNaN(d.getTime())) return d.toISOString()
  return null
}
