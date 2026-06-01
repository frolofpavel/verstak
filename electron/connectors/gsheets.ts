/**
 * Google Sheets connector — service account auth, no external deps.
 *
 * Источник: V3 Plan раздел 5.1. Реализация без googleapis npm пакета —
 * минимальный JWT (RS256) + fetch для всего API.
 *
 * Credentials: service account JSON. Хранится в settings под ключом 'gsheets_service_account_json',
 * шифруется через safeStorage.
 *
 * Безопасность:
 *  - access_token кешируется на 50 минут (Google даёт 60), чтобы не
 *    дёргать oauth на каждый запрос.
 *  - НЕТ whitelist spreadsheet_id в V1 — добавим в следующей версии при
 *    необходимости multi-user изоляции.
 *  - update/append логируются (через emitActivity в tool-handlers выше).
 */

import { createSign } from 'crypto'
import type { Connector, ConnectorInfo, ConnectorContext } from './types'

interface ServiceAccount {
  client_email: string
  private_key: string
  token_uri?: string
}

// Кеш access_token в памяти модуля. Per-process, переживает между запросами.
let cachedToken: { token: string; expiresAt: number } | null = null

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const TOKEN_TTL_MS = 50 * 60 * 1000  // refresh за 10 минут до фактического expiry

export function createGSheetsConnector(): Connector {
  return {
    info(): ConnectorInfo {
      // Status вычисляется в момент list — есть ли creds в settings.
      // ConnectorRegistry дёргает info() в list, актуальный
      // статус. Но info() синхронный, поэтому проверку делаем на месте запроса.
      return {
        id: 'gsheets',
        label: 'Google Sheets',
        kind: 'gsheets',
        status: 'ready',
        detail: 'Service account JSON в settings (gsheets_service_account_json)'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const sa = loadServiceAccount(ctx)
      if (!sa) {
        return {
          error: 'no-credentials',
          message: 'Google Sheets credentials не настроены. Открой Settings → введи service account JSON в поле "Google Sheets".'
        }
      }
      try {
        switch (op) {
          case 'read_sheet':       return await readSheet(sa, args, ctx)
          case 'read_as_records':  return await readAsRecords(sa, args, ctx)
          case 'get_row':          return await getRow(sa, args, ctx)
          case 'append_row':       return await appendRow(sa, args, ctx)
          case 'append_rows':      return await appendRows(sa, args, ctx)
          case 'update_cell':      return await updateCell(sa, args, ctx)
          case 'update_row':       return await updateRow(sa, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная операция «${op}». Доступно: read_sheet, read_as_records, get_row, append_row, append_rows, update_cell, update_row.`
            }
        }
      } catch (err) {
        return {
          error: 'request-failed',
          message: err instanceof Error ? err.message : String(err),
          op
        }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

interface BaseArgs { spreadsheet_id: string; sheet_name: string }

async function readSheet(sa: ServiceAccount, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const { spreadsheet_id, sheet_name } = requireBase(args)
  const range = String(args.range ?? '')
  const a1 = range ? `${sheet_name}!${range}` : sheet_name
  const token = await getAccessToken(sa, ctx)
  const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(a1)}`
  const res = await fetchJson(url, { method: 'GET', headers: authHeader(token) }, ctx)
  return { values: (res as { values?: string[][] }).values ?? [] }
}

async function readAsRecords(sa: ServiceAccount, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const { spreadsheet_id, sheet_name } = requireBase(args)
  const headersRow = Number(args.headers_row ?? 1)
  const token = await getAccessToken(sa, ctx)
  const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(sheet_name)}`
  const res = await fetchJson(url, { method: 'GET', headers: authHeader(token) }, ctx) as { values?: string[][] }
  const values = res.values ?? []
  if (values.length < headersRow) return { records: [], headers: [] }
  const headers = (values[headersRow - 1] ?? []).map(h => (h ?? '').trim())
  const records = values.slice(headersRow).map(row => {
    const rec: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i]
      if (key) rec[key] = (row[i] ?? '')
    }
    return rec
  })
  return { headers, records, total: records.length }
}

async function getRow(sa: ServiceAccount, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  // args.where = { column, value } — поиск по точному совпадению значения в указанной колонке
  const where = args.where as { column?: string; value?: string } | undefined
  if (!where || !where.column) {
    return { error: 'bad-args', message: 'get_row требует where: { column, value }' }
  }
  const result = await readAsRecords(sa, args, ctx) as { records: Record<string, string>[]; headers: string[] }
  const hit = result.records.find(r => r[where.column!] === where.value)
  return { row: hit ?? null, found: !!hit }
}

async function appendRow(sa: ServiceAccount, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  return appendRows(sa, { ...args, rows: [args.values] }, ctx)
}

async function appendRows(sa: ServiceAccount, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const { spreadsheet_id, sheet_name } = requireBase(args)
  const rows = (args.rows as Array<Record<string, unknown>> | undefined) ?? []
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: 'bad-args', message: 'append_rows требует rows: array of {column: value}' }
  }
  // Получаем headers из первой строки таблицы чтобы знать колонки
  const meta = await readAsRecords(sa, { ...args, headers_row: 1 }, ctx) as { headers: string[] }
  const headers = meta.headers
  const values2d = rows.map(r => headers.map(h => String(r[h] ?? '')))
  const token = await getAccessToken(sa, ctx)
  const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(sheet_name)}:append`
    + `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
  const res = await fetchJson(url, {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: values2d })
  }, ctx)
  return { appended: rows.length, response: res }
}

async function updateCell(sa: ServiceAccount, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const { spreadsheet_id, sheet_name } = requireBase(args)
  const row = Number(args.row)
  const column = String(args.column ?? '')
  const value = String(args.value ?? '')
  if (!row || !column) return { error: 'bad-args', message: 'update_cell требует row (1-based) и column (e.g. "A")' }
  const a1 = `${sheet_name}!${column}${row}`
  const token = await getAccessToken(sa, ctx)
  const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(a1)}?valueInputOption=USER_ENTERED`
  await fetchJson(url, {
    method: 'PUT',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[value]] })
  }, ctx)
  return { ok: true, cell: a1, value }
}

async function updateRow(sa: ServiceAccount, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const { spreadsheet_id, sheet_name } = requireBase(args)
  const rowIndex = Number(args.row_index)  // 1-based, INCLUDING headers row
  const patch = args.patch as Record<string, unknown> | undefined
  if (!rowIndex || !patch) return { error: 'bad-args', message: 'update_row требует row_index и patch: {column: value}' }
  const meta = await readAsRecords(sa, { ...args, headers_row: 1 }, ctx) as { headers: string[] }
  const headers = meta.headers
  // Читаем текущие значения этой строки чтобы patch только определённые колонки
  const token = await getAccessToken(sa, ctx)
  const readUrl = `${SHEETS_BASE}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(sheet_name)}!A${rowIndex}:${columnLetter(headers.length)}${rowIndex}`
  const cur = await fetchJson(readUrl, { method: 'GET', headers: authHeader(token) }, ctx) as { values?: string[][] }
  const currentRow = cur.values?.[0] ?? new Array(headers.length).fill('')
  // Применяем patch по именам колонок
  const newRow = headers.map((h, i) => h in patch ? String(patch[h] ?? '') : (currentRow[i] ?? ''))
  const writeUrl = `${SHEETS_BASE}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(sheet_name)}!A${rowIndex}:${columnLetter(headers.length)}${rowIndex}?valueInputOption=USER_ENTERED`
  await fetchJson(writeUrl, {
    method: 'PUT',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [newRow] })
  }, ctx)
  return { ok: true, row_index: rowIndex, patched: Object.keys(patch) }
}

// ----------------------------------------------------------------- helpers

function requireBase(args: Record<string, unknown>): BaseArgs {
  const spreadsheet_id = String(args.spreadsheet_id ?? '')
  const sheet_name = String(args.sheet_name ?? '')
  if (!spreadsheet_id || !sheet_name) {
    throw new Error('Аргументы spreadsheet_id и sheet_name обязательны')
  }
  return { spreadsheet_id, sheet_name }
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

async function fetchJson(url: string, init: RequestInit, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: ctx.signal })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Sheets API ${res.status}: ${text.slice(0, 400)}`)
  }
  try { return text ? JSON.parse(text) : {} } catch { return { _raw: text } }
}

function loadServiceAccount(ctx: ConnectorContext): ServiceAccount | null {
  const raw = ctx.getSecret('gsheets_service_account_json')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed.client_email || !parsed.private_key) return null
    return {
      client_email: String(parsed.client_email),
      private_key: String(parsed.private_key).replace(/\\n/g, '\n'),
      token_uri: parsed.token_uri ?? 'https://oauth2.googleapis.com/token'
    }
  } catch {
    return null
  }
}

async function getAccessToken(sa: ServiceAccount, ctx: ConnectorContext): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token
  // Сборка JWT и обмен на access_token (Service Account flow).
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: sa.token_uri,
    exp: now + 3600,
    iat: now
  }
  const encHeader = base64url(JSON.stringify(header))
  const encClaims = base64url(JSON.stringify(claims))
  const signingInput = `${encHeader}.${encClaims}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(sa.private_key)
  const jwt = `${signingInput}.${base64urlBuf(signature)}`
  const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    signal: ctx.signal
  })
  const payload = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!payload.access_token) {
    throw new Error(`oauth: ${payload.error}: ${payload.error_description ?? 'no access_token returned'}`)
  }
  cachedToken = {
    token: payload.access_token,
    expiresAt: Date.now() + Math.min((payload.expires_in ?? 3600) * 1000 - 60_000, TOKEN_TTL_MS)
  }
  return payload.access_token
}

function base64url(str: string): string {
  return base64urlBuf(Buffer.from(str, 'utf8'))
}
function base64urlBuf(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function columnLetter(n: number): string {
  // 1 → A, 26 → Z, 27 → AA, ...
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s || 'A'
}
