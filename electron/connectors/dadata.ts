/**
 * DaData connector — нормализация и проверка контрагентов/адресов (РФ).
 *
 * Своя реализация поверх официального DaData API (suggestions + cleaner).
 * Чужой код не используется — только публично документированные эндпоинты.
 *
 * Зачем агентству: проверка контрагента по ИНН (реквизиты для КП/договора),
 * подсказка организаций/адресов/банков, стандартизация адреса.
 *
 * Credentials (settings keys):
 *   dadata_api_key  — Token авторизации (хватает для suggestions: find/suggest).
 *   dadata_secret   — секретный ключ, нужен ТОЛЬКО для clean_address (Cleaner API).
 *
 * API:
 *   - Suggestions: https://suggestions.dadata.ru/suggestions/api/4_1/rs/
 *       Authorization: Token {api_key} · POST {query, count}
 *   - Cleaner:     https://cleaner.dadata.ru/api/v1/clean/address
 *       Authorization: Token {api_key} + X-Secret: {secret} · POST ["строка"]
 *
 * Операции (args.op):
 *   find_party     — организация/ИП по ИНН или ОГРН (точно, findById/party).
 *   suggest_party  — подсказка организаций по названию/части ИНН.
 *   suggest_address— подсказка/нормализация адреса.
 *   suggest_bank   — банк по БИК или названию.
 *   clean_address  — полная стандартизация адреса (требует dadata_secret).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const SUGGEST_BASE = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs'
const CLEAN_ADDRESS_URL = 'https://cleaner.dadata.ru/api/v1/clean/address'

function clampCount(raw: unknown, def = 5): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.max(1, Math.min(20, Math.trunc(n)))
}

export function createDaDataConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'dadata',
        label: 'DaData',
        kind: 'dadata',
        requires: ['dadata_api_key'],
        status: 'ready',
        detail: 'Контрагенты по ИНН, подсказки адресов/банков. Token в settings (dadata_api_key).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const apiKey = ctx.getSecret('dadata_api_key')
      if (!apiKey) {
        return {
          error: 'no-token',
          message: 'DaData token не настроен. Settings → коннектор DaData → API key. ' +
                   'Получить: https://dadata.ru/profile/#info (раздел «API-ключ»).'
        }
      }
      try {
        switch (op) {
          case 'find_party':      return await findParty(apiKey, args, ctx)
          case 'suggest_party':   return await suggest(apiKey, 'party', args, ctx, formatParty)
          case 'suggest_address': return await suggest(apiKey, 'address', args, ctx, formatAddress)
          case 'suggest_bank':    return await suggest(apiKey, 'bank', args, ctx, formatBank)
          case 'clean_address':   return await cleanAddress(apiKey, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: find_party, suggest_party, suggest_address, suggest_bank, clean_address.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

interface Suggestion { value?: string; unrestricted_value?: string; data?: Record<string, unknown> }

async function findParty(apiKey: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const query = String(args.query ?? '').trim()
  if (!query) return { error: 'bad-args', message: 'find_party требует query — ИНН или ОГРН.' }
  const body: Record<string, unknown> = { query, count: clampCount(args.count, 1) }
  if (args.kpp) body.kpp = String(args.kpp)
  const json = await postJson(`${SUGGEST_BASE}/findById/party`, apiKey, undefined, body, ctx)
  const items = ((json as { suggestions?: Suggestion[] }).suggestions ?? []).map(formatParty)
  if (items.length === 0) return { found: false, message: `Контрагент по «${query}» не найден.` }
  return { found: true, count: items.length, parties: items }
}

async function suggest(
  apiKey: string,
  kind: 'party' | 'address' | 'bank',
  args: Record<string, unknown>,
  ctx: ConnectorContext,
  fmt: (s: Suggestion) => unknown
): Promise<unknown> {
  const query = String(args.query ?? '').trim()
  if (!query) return { error: 'bad-args', message: `suggest_${kind} требует query.` }
  const json = await postJson(`${SUGGEST_BASE}/suggest/${kind}`, apiKey, undefined, { query, count: clampCount(args.count) }, ctx)
  const items = ((json as { suggestions?: Suggestion[] }).suggestions ?? []).map(fmt)
  return { count: items.length, suggestions: items }
}

async function cleanAddress(apiKey: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const secret = ctx.getSecret('dadata_secret')
  if (!secret) {
    return {
      error: 'no-secret',
      message: 'clean_address требует секретный ключ. Settings → DaData → Secret. ' +
               'Берётся там же где API-ключ (dadata.ru/profile/#info). Подсказки (suggest_*) работают и без него.'
    }
  }
  const query = String(args.query ?? '').trim()
  if (!query) return { error: 'bad-args', message: 'clean_address требует query — строку адреса.' }
  const json = await postJson(CLEAN_ADDRESS_URL, apiKey, secret, [query], ctx)
  const first = Array.isArray(json) ? json[0] as Record<string, unknown> : null
  if (!first) return { cleaned: false, message: 'DaData не вернул результат стандартизации.' }
  return { cleaned: true, result: formatAddress({ value: String(first.result ?? ''), data: first }) }
}

// ----------------------------------------------------------------- helpers

async function postJson(
  url: string,
  apiKey: string,
  secret: string | undefined,
  payload: unknown,
  ctx: ConnectorContext
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Authorization': `Token ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
  if (secret) headers['X-Secret'] = secret
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctx.signal })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 401
      ? ' (проверь dadata_api_key / dadata_secret)'
      : res.status === 429 ? ' (превышен лимит запросов DaData)' : ''
    throw new Error(`DaData ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('DaData вернул не-JSON ответ') }
}

// Извлекаем только нужные поля — компактный предсказуемый ответ вместо
// громоздкого DaData data (защита контекста + удобство для модели).

function formatParty(s: Suggestion): unknown {
  const d = (s.data ?? {}) as Record<string, any>
  return {
    name: d.name?.short_with_opf ?? d.name?.full_with_opf ?? s.value ?? '',
    inn: d.inn ?? null,
    kpp: d.kpp ?? null,
    ogrn: d.ogrn ?? null,
    type: d.type ?? null,                       // LEGAL | INDIVIDUAL
    status: d.state?.status ?? null,            // ACTIVE | LIQUIDATING | ...
    management: d.management?.name ?? null,
    address: d.address?.unrestricted_value ?? d.address?.value ?? null,
    okved: d.okved ?? null
  }
}

function formatAddress(s: Suggestion): unknown {
  const d = (s.data ?? {}) as Record<string, any>
  return {
    value: s.unrestricted_value ?? s.value ?? String(d.result ?? ''),
    postal_code: d.postal_code ?? null,
    region: d.region_with_type ?? d.region ?? null,
    city: d.city_with_type ?? d.city ?? null,
    street: d.street_with_type ?? d.street ?? null,
    house: d.house ?? null,
    geo_lat: d.geo_lat ?? null,
    geo_lon: d.geo_lon ?? null,
    fias_id: d.fias_id ?? null,
    qc: d.qc ?? null                            // качество (0 — точно, иначе сомнительно)
  }
}

function formatBank(s: Suggestion): unknown {
  const d = (s.data ?? {}) as Record<string, any>
  return {
    name: d.name?.payment ?? d.name?.short ?? s.value ?? '',
    bic: d.bic ?? null,
    swift: d.swift ?? null,
    correspondent_account: d.correspondent_account ?? null,
    inn: d.inn ?? null,
    address: d.address?.unrestricted_value ?? d.address?.value ?? null,
    status: d.state?.status ?? null
  }
}
