/**
 * Контур.Фокус connector — проверка контрагентов по ИНН/ОГРН (РФ).
 *
 * Своя реализация поверх официального Focus API 3.0 (https://focus-api.kontur.ru/).
 * Чужой код не используется — только публично документированные эндпоинты.
 *
 * Зачем агентству: due-diligence клиента/поставщика перед сделкой — реквизиты
 * для КП/договора (наименование, статус, адрес, руководитель) и быстрая
 * риск-аналитика (арбитражи, блокировки счетов, реестр недобросовестных,
 * массовый адрес/руководитель) одним запросом.
 *
 * Credentials (settings keys):
 *   kontur_focus_api_key — ключ доступа к Focus API 3.0 (передаётся в query ?key=).
 *
 * API:
 *   - Base: https://focus-api.kontur.ru/api3 · метод GET · ключ в ?key={key}
 *   - Ответ — массив объектов по запрошенным ИНН/ОГРН (можно несколько через запятую).
 *   - /req?key=&inn= (или &ogrn=) — реквизиты (UL — юрлицо / IP — ИП).
 *   - /analytics?key=&inn= — маркеры риска (арбитражи, блокировки, РНП и т.п.).
 *
 * Операции (args.op):
 *   req       — реквизиты контрагента по ИНН или ОГРН (наименование, статус, адрес, руководитель).
 *   analytics — риск-аналитика по ИНН/ОГРН (плоский набор основных флагов риска).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API3 = 'https://focus-api.kontur.ru/api3'

export function createKonturFocusConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'kontur_focus',
        label: 'Контур.Фокус',
        kind: 'kontur_focus',
        requires: ['kontur_focus_api_key'],
        status: 'ready',
        detail: 'Проверка контрагентов по ИНН/ОГРН: реквизиты + риск-аналитика. Ключ в settings (kontur_focus_api_key).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const key = ctx.getSecret('kontur_focus_api_key')
      if (!key) {
        return {
          error: 'no-token',
          message: 'Контур.Фокус ключ не настроен. Settings → коннектор Контур.Фокус → API key. ' +
                   'Получить: https://focus-api.kontur.ru/ (заявка на доступ к Focus API 3.0).'
        }
      }
      try {
        switch (op) {
          case 'req':       return await req(key, args, ctx)
          case 'analytics': return await analytics(key, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: req, analytics.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function req(key: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const id = requireId(args)
  if (typeof id !== 'object' || id === null || !('param' in id)) return id  // bad-args объект
  const url = `${API3}/req?key=${encodeURIComponent(key)}&${id.param}=${encodeURIComponent(id.value)}`
  const json = await get(url, ctx)
  const rows = Array.isArray(json) ? json : []
  const items = rows.map(formatReq)
  if (items.length === 0) return { found: false, message: `Контрагент по «${id.value}» не найден.` }
  return { found: true, count: items.length, parties: items }
}

async function analytics(key: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const id = requireId(args)
  if (typeof id !== 'object' || id === null || !('param' in id)) return id
  const url = `${API3}/analytics?key=${encodeURIComponent(key)}&${id.param}=${encodeURIComponent(id.value)}`
  const json = await get(url, ctx)
  const rows = Array.isArray(json) ? json : []
  const items = rows.map(formatAnalytics)
  if (items.length === 0) return { found: false, message: `Аналитика по «${id.value}» не найдена.` }
  return { found: true, count: items.length, analytics: items }
}

// ----------------------------------------------------------------- helpers

/** Принимает inn ИЛИ ogrn (один обязателен). Возвращает {param,value} либо bad-args объект. */
function requireId(args: Record<string, unknown>): { param: 'inn' | 'ogrn'; value: string } | { error: string; message: string } {
  const inn = String(args.inn ?? '').trim()
  const ogrn = String(args.ogrn ?? '').trim()
  if (inn) return { param: 'inn', value: inn }
  if (ogrn) return { param: 'ogrn', value: ogrn }
  return { error: 'bad-args', message: 'Нужен inn или ogrn (один обязателен).' }
}

async function get(url: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: ctx.signal })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь kontur_focus_api_key и доступ к Focus API 3.0)'
      : res.status === 429 ? ' (превышен лимит запросов Контур.Фокус)' : ''
    throw new Error(`Kontur.Focus ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('Контур.Фокус вернул не-JSON ответ') }
}

// Извлекаем только нужные поля — компактный предсказуемый ответ вместо
// громоздкого объекта Focus API (защита контекста + удобство для модели).
// UL — юрлицо, IP — индивидуальный предприниматель; в ответе ровно один из них.

function formatReq(row: Record<string, any>): unknown {
  const ul = row.UL as Record<string, any> | undefined
  const ip = row.IP as Record<string, any> | undefined
  const base = {
    inn: row.inn ?? ul?.inn ?? ip?.inn ?? null,
    ogrn: row.ogrn ?? ul?.ogrn ?? ip?.ogrnip ?? null,
    focusHref: row.focusHref ?? null
  }
  if (ul) {
    const head = Array.isArray(ul.heads) ? ul.heads[0] : ul.head
    return {
      ...base,
      type: 'UL',
      name: ul.legalName?.short ?? ul.legalName?.full ?? null,
      fullName: ul.legalName?.full ?? null,
      kpp: ul.kpp ?? null,
      status: ul.status?.statusString ?? ul.status ?? null,
      address: formatAddress(ul.legalAddress),
      manager: head ? { fio: head.fio ?? null, position: head.position ?? null } : null
    }
  }
  if (ip) {
    return {
      ...base,
      type: 'IP',
      name: ip.fio ?? null,
      status: ip.status?.statusString ?? ip.status ?? null,
      okvedName: ip.okved?.name ?? null
    }
  }
  return { ...base, type: null, message: 'Ни UL, ни IP в ответе — возможно, неверный ИНН/ОГРН.' }
}

/** legalAddress может прийти как parsedAddressRF (части) или как строка/объект с readableAddress. */
function formatAddress(a: any): string | null {
  if (!a) return null
  if (typeof a === 'string') return a
  const p = a.parsedAddressRF as Record<string, any> | undefined
  if (p) {
    const parts = [p.regionName, p.city, p.settlement, p.street, p.house]
      .filter((x: unknown) => typeof x === 'string' && x.length > 0)
    if (parts.length > 0) return parts.join(', ')
  }
  return a.readableAddress ?? a.address ?? a.value ?? null
}

function formatAnalytics(row: Record<string, any>): unknown {
  const brief = row.briefReport?.summary ?? row.briefReport ?? {}
  return {
    inn: row.inn ?? null,
    ogrn: row.ogrn ?? null,
    focusHref: row.focusHref ?? null,
    isMSP: row.isMSP ?? null,                          // субъект малого/среднего предпринимательства
    isRNP: row.isRNP ?? null,                          // реестр недобросовестных поставщиков
    hasArbitration: row.hasArbitration ?? null,        // есть арбитражные дела
    hasBlockedAccounts: row.hasBlockedAccounts ?? null,// блокировки счетов
    hasNegativeListsInfo: row.hasNegativeListsInfo ?? null,
    statusBlockFns: row.statusBlockFns ?? null,        // блокировка операций ФНС
    hasMassAddress: row.hasMassAddress ?? null,        // адрес массовой регистрации
    hasMassHead: row.hasMassHead ?? null,              // массовый руководитель
    hasMassFounder: row.hasMassFounder ?? null,        // массовый учредитель
    greenStatements: brief.greenStatements ?? null,    // зелёные индикаторы (всё в порядке)
    yellowStatements: brief.yellowStatements ?? null,  // жёлтые (обратить внимание)
    redStatements: brief.redStatements ?? null         // красные (риск)
  }
}
