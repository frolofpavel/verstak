/**
 * Notion connector — поиск страниц, чтение баз и страниц рабочего пространства.
 *
 * Своя реализация поверх официального Notion API (v1). Авторизация — Bearer
 * integration token (internal integration). Чужой код не используется, только
 * публично документированные эндпоинты.
 *
 * Зачем агентству: у клиентов и внутри агентства в Notion живут базы задач,
 * контент-планы, базы клиентов и брифы. Агент может найти страницу по запросу,
 * выгрузить строки базы (задачи/лиды/контент) и прочитать конкретную страницу
 * для контекста — без ручного экспорта.
 *
 * Credentials (settings keys):
 *   notion_token — Internal integration token (secret_..., ntn_...).
 *                  notion.so/my-integrations → New integration → Internal.
 *                  Не забыть «Connect» интеграцию к нужным страницам/базам.
 *
 * API:
 *   Base: https://api.notion.com/v1
 *   Auth: Authorization: Bearer {token}
 *         Notion-Version: 2022-06-28
 *         Content-Type: application/json
 *
 * Операции (args.op):
 *   search        — POST /search — найти страницы/базы по запросу (query опц.).
 *   query_database— POST /databases/{id}/query — строки базы (database_id обяз.).
 *   get_page      — GET  /pages/{id} — одна страница с её properties (page_id обяз.).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

export function createNotionConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'notion',
        label: 'Notion',
        kind: 'notion',
        requires: ['notion_token'],
        status: 'ready',
        detail: 'Поиск страниц, чтение баз и страниц. Integration token в settings (notion_token).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('notion_token')
      if (!token) {
        return {
          error: 'no-token',
          message: 'Notion token не настроен. Settings → коннектор Notion → token. ' +
                   'Получить: notion.so/my-integrations (Internal integration) и подключить её к нужным страницам.'
        }
      }
      try {
        switch (op) {
          case 'search':         return await search(token, args, ctx)
          case 'query_database': return await queryDatabase(token, args, ctx)
          case 'get_page':       return await getPage(token, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: search, query_database, get_page.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function search(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query : ''
  const json = await postJson(`${API}/search`, token, { query, page_size: 20 }, ctx) as { results?: Array<Record<string, any>> }
  const results = (json.results ?? []).map(formatSearchHit)
  return { count: results.length, results }
}

async function queryDatabase(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const databaseId = String(args.database_id ?? '').trim()
  if (!databaseId) return { error: 'bad-args', message: 'query_database требует database_id (id базы из URL Notion).' }
  const json = await postJson(`${API}/databases/${encodeURIComponent(databaseId)}/query`, token, { page_size: 50 }, ctx) as {
    results?: Array<Record<string, any>>
  }
  const results = (json.results ?? []).map(formatRow)
  return { count: results.length, results }
}

async function getPage(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const pageId = String(args.page_id ?? '').trim()
  if (!pageId) return { error: 'bad-args', message: 'get_page требует page_id (id страницы из URL Notion).' }
  const json = await get(`${API}/pages/${encodeURIComponent(pageId)}`, token, ctx) as Record<string, any>
  return formatRow(json)
}

// ----------------------------------------------------------------- helpers

async function postJson(url: string, token: string, body: unknown, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
    signal: ctx.signal
  })
  return parse(res)
}

async function get(url: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, { headers: headers(token), signal: ctx.signal })
  return parse(res)
}

function headers(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь notion_token и что интеграция подключена к странице/базе)'
      : res.status === 429 ? ' (превышен лимит запросов Notion)' : ''
    throw new Error(`Notion ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('Notion вернул не-JSON ответ') }
}

// Достаём только нужные плоские поля — компактный предсказуемый ответ вместо
// громоздкого page object Notion (защита контекста + удобство для модели).

function formatSearchHit(r: Record<string, any>): unknown {
  return {
    id: r.id ?? null,
    object: r.object ?? null,          // page | database
    title: extractTitle(r),
    url: r.url ?? null
  }
}

function formatRow(r: Record<string, any>): unknown {
  return {
    id: r.id ?? null,
    url: r.url ?? null,
    properties: compactProperties(r.properties)
  }
}

// Title страницы лежит в properties — у свойства с type === 'title',
// массив rich text, текст в plain_text. У базы заголовок — в r.title[].
function extractTitle(r: Record<string, any>): string {
  const props = r.properties as Record<string, any> | undefined
  if (props) {
    for (const key of Object.keys(props)) {
      const p = props[key]
      if (p && p.type === 'title' && Array.isArray(p.title)) {
        const text = p.title.map((t: any) => t?.plain_text ?? '').join('').trim()
        if (text) return text
      }
    }
  }
  if (Array.isArray(r.title)) {
    const text = r.title.map((t: any) => t?.plain_text ?? '').join('').trim()
    if (text) return text
  }
  return ''
}

// Сводим properties Notion к плоским значениям по типам — чтобы не тащить
// в контекст полную обвязку каждого свойства (annotations, ids, и т.п.).
function compactProperties(props: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!props || typeof props !== 'object') return out
  for (const [key, raw] of Object.entries(props as Record<string, any>)) {
    out[key] = compactValue(raw)
  }
  return out
}

function compactValue(p: any): unknown {
  if (!p || typeof p !== 'object') return p ?? null
  switch (p.type) {
    case 'title':       return richText(p.title)
    case 'rich_text':   return richText(p.rich_text)
    case 'number':      return p.number ?? null
    case 'checkbox':    return p.checkbox ?? null
    case 'select':      return p.select?.name ?? null
    case 'status':      return p.status?.name ?? null
    case 'multi_select':return Array.isArray(p.multi_select) ? p.multi_select.map((s: any) => s?.name ?? '') : []
    case 'date':        return p.date?.start ?? null
    case 'url':         return p.url ?? null
    case 'email':       return p.email ?? null
    case 'phone_number':return p.phone_number ?? null
    case 'people':      return Array.isArray(p.people) ? p.people.map((u: any) => u?.name ?? u?.id ?? '') : []
    case 'created_time':return p.created_time ?? null
    case 'last_edited_time': return p.last_edited_time ?? null
    default:            return p.type ?? null
  }
}

function richText(arr: unknown): string {
  if (!Array.isArray(arr)) return ''
  return arr.map((t: any) => t?.plain_text ?? '').join('')
}
