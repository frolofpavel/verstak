/**
 * Яндекс.Директ API connector — статистика кампаний и аудит.
 *
 * Источник: V3 Plan раздел 5.5. Пилот — 3 клиента (выбор при Неделе 3).
 *
 * Credentials (settings keys):
 *   yandex_direct_token       — OAuth token (получается через
 *                                oauth.yandex.ru, scope: direct:api)
 *   yandex_direct_login       — login клиента агентства (опционально для
 *                                агентских аккаунтов).
 *
 * API:
 *   - Base URL: https://api.direct.yandex.com/json/v5/
 *   - Версия v5 — текущая стабильная.
 *   - Reports API — асинхронный (job_id → polling), для V1 ждём до 30 сек
 *     синхронно, иначе возвращаем job_id для retry.
 *
 * Headers:
 *   Authorization: Bearer {token}
 *   Accept-Language: ru
 *   Client-Login: {login}  — для агентских аккаунтов
 *
 * Все ответы в JSON. Ошибки в формате { error: { error_code, error_string, ... } }.
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API_BASE = 'https://api.direct.yandex.com/json/v5'
const REPORTS_API = 'https://api.direct.yandex.com/json/v5/reports'

export function createYandexDirectConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'yandex_direct',
        label: 'Яндекс.Директ',
        kind: 'yandex_direct',
        requires: ['yandex_direct_token'],
        status: 'ready',
        detail: 'OAuth token в settings (yandex_direct_token). Reports API — sync polling до 30s.'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('yandex_direct_token')
      if (!token) {
        return {
          error: 'no-token',
          message: 'Yandex.Direct token не настроен. Settings → yandex_direct_token. ' +
                   'Получить: https://oauth.yandex.ru/authorize?response_type=token&client_id=YOUR_ID (нужен Direct API доступ).'
        }
      }
      const login = ctx.getSecret('yandex_direct_login') ?? undefined
      try {
        switch (op) {
          case 'list_campaigns':         return await listCampaigns(token, login, args, ctx)
          case 'list_ads':               return await listAds(token, login, args, ctx)
          case 'get_campaign_stats':     return await getCampaignStats(token, login, args, ctx)
          case 'get_keywords_stats':     return await getKeywordsStats(token, login, args, ctx)
          case 'get_account_stats':      return await getAccountStats(token, login, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_campaigns, list_ads, get_campaign_stats, get_keywords_stats, get_account_stats.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listCampaigns(token: string, login: string | undefined, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const states = (args.states as string[] | undefined) ?? ['ON', 'OFF', 'SUSPENDED']
  return await api(token, login, 'campaigns', 'get', {
    SelectionCriteria: { States: states },
    FieldNames: ['Id', 'Name', 'State', 'Status', 'Type', 'StartDate', 'DailyBudget', 'Funds']
  }, ctx)
}

async function listAds(token: string, login: string | undefined, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const campaignIds = (args.campaign_ids as number[] | undefined) ?? []
  if (campaignIds.length === 0) return { error: 'bad-args', message: 'list_ads требует campaign_ids: number[]' }
  return await api(token, login, 'ads', 'get', {
    SelectionCriteria: { CampaignIds: campaignIds, States: ['ON', 'OFF'] },
    FieldNames: ['Id', 'CampaignId', 'AdGroupId', 'State', 'Status', 'Type']
  }, ctx)
}

async function getCampaignStats(token: string, login: string | undefined, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const campaignIds = (args.campaign_ids as number[] | undefined) ?? []
  if (campaignIds.length === 0) return { error: 'bad-args', message: 'get_campaign_stats требует campaign_ids' }
  const dateFrom = String(args.date_from ?? '')
  const dateTo = String(args.date_to ?? '')
  if (!dateFrom || !dateTo) return { error: 'bad-args', message: 'date_from и date_to обязательны (YYYY-MM-DD)' }
  return await reportRequest(token, login, {
    SelectionCriteria: { Filter: [{ Field: 'CampaignId', Operator: 'IN', Values: campaignIds.map(String) }] },
    FieldNames: ['Date', 'CampaignId', 'CampaignName', 'Impressions', 'Clicks', 'Cost', 'Ctr', 'AvgCpc', 'Conversions'],
    ReportName: `Campaigns_${Date.now()}`,
    ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
    DateRangeType: 'CUSTOM_DATE',
    Format: 'TSV',
    IncludeVAT: 'YES',
    DateFrom: dateFrom,
    DateTo: dateTo
  }, ctx)
}

async function getKeywordsStats(token: string, login: string | undefined, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const campaignId = Number(args.campaign_id ?? 0)
  if (!campaignId) return { error: 'bad-args', message: 'get_keywords_stats требует campaign_id' }
  const period = String(args.period ?? 'LAST_30_DAYS').toUpperCase()
  return await reportRequest(token, login, {
    SelectionCriteria: { Filter: [{ Field: 'CampaignId', Operator: 'EQUALS', Values: [String(campaignId)] }] },
    FieldNames: ['Date', 'Criterion', 'Impressions', 'Clicks', 'Cost', 'Ctr', 'AvgCpc'],
    ReportName: `Keywords_${campaignId}_${Date.now()}`,
    ReportType: 'CRITERIA_PERFORMANCE_REPORT',
    DateRangeType: period,
    Format: 'TSV',
    IncludeVAT: 'YES'
  }, ctx)
}

async function getAccountStats(token: string, login: string | undefined, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const period = String(args.period ?? 'LAST_30_DAYS').toUpperCase()
  return await reportRequest(token, login, {
    SelectionCriteria: {},
    FieldNames: ['Date', 'Impressions', 'Clicks', 'Cost', 'Ctr', 'AvgCpc', 'Conversions'],
    ReportName: `Account_${Date.now()}`,
    ReportType: 'ACCOUNT_PERFORMANCE_REPORT',
    DateRangeType: period,
    Format: 'TSV',
    IncludeVAT: 'YES'
  }, ctx)
}

// ----------------------------------------------------------------- helpers

async function api(
  token: string,
  login: string | undefined,
  service: string,
  method: string,
  params: Record<string, unknown>,
  ctx: ConnectorContext
): Promise<unknown> {
  const url = `${API_BASE}/${service}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept-Language': 'ru',
      'Content-Type': 'application/json',
      ...(login ? { 'Client-Login': login } : {})
    },
    body: JSON.stringify({ method, params }),
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Yandex.Direct ${service}.${method} ${res.status}: ${text.slice(0, 400)}`)
  try {
    const payload = JSON.parse(text) as { result?: unknown; error?: { error_code: string; error_string: string } }
    if (payload.error) throw new Error(`API error ${payload.error.error_code}: ${payload.error.error_string}`)
    return payload.result
  } catch (err) {
    if (err instanceof Error) throw err
    throw new Error('Parse failed')
  }
}

/**
 * Reports API — асинхронный. Стратегия:
 *   1. POST с processingMode=auto → ожидаем status 200 с TSV или 202 с retry header.
 *   2. Если 202 — пробуем ещё раз через 5s, до 30s максимум (6 попыток).
 *   3. Если всё ещё processing — возвращаем job_id для пользователя.
 */
async function reportRequest(
  token: string,
  login: string | undefined,
  params: Record<string, unknown>,
  ctx: ConnectorContext
): Promise<unknown> {
  const body = JSON.stringify({ params })
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept-Language': 'ru',
    'Content-Type': 'application/json',
    'processingMode': 'auto',
    'returnMoneyInMicros': 'false',
    'skipReportHeader': 'true',
    'skipColumnHeader': 'false',
    'skipReportSummary': 'true',
    ...(login ? { 'Client-Login': login } : {})
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(REPORTS_API, { method: 'POST', headers, body, signal: ctx.signal })
    if (res.status === 200) {
      const tsv = await res.text()
      return { format: 'tsv', data: tsvToRecords(tsv) }
    }
    if (res.status === 201 || res.status === 202) {
      // Поллинг — спим 5s до следующей попытки
      await new Promise(r => setTimeout(r, 5000))
      continue
    }
    const text = await res.text()
    throw new Error(`Reports API ${res.status}: ${text.slice(0, 400)}`)
  }
  return { processing: true, message: 'Отчёт ещё генерируется. Повторите запрос через минуту.' }
}

function tsvToRecords(tsv: string): Array<Record<string, string>> {
  const lines = tsv.trim().split('\n')
  if (lines.length < 2) return []
  const headers = lines[0].split('\t')
  return lines.slice(1).map(line => {
    const values = line.split('\t')
    const rec: Record<string, string> = {}
    headers.forEach((h, i) => { rec[h] = values[i] ?? '' })
    return rec
  })
}
