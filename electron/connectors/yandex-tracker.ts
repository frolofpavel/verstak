/**
 * Яндекс.Трекер connector — задачи и очереди (таск-трекер команд).
 *
 * Своя реализация поверх официального Yandex Tracker API v2.
 * Зачем агентству: единая выгрузка задач команды/клиента в чат — что в работе,
 * по кому, в каком статусе. Без переключения в веб-интерфейс Трекера.
 *
 * Credentials (settings keys, нужны ОБА, иначе no-credentials):
 *   yandex_tracker_token  — OAuth token (oauth.yandex.ru, доступ к Tracker API).
 *   yandex_tracker_org_id — ID организации (заголовок X-Org-ID).
 *
 * API:
 *   Base: https://api.tracker.yandex.net/v2
 *   Auth: Authorization: OAuth {token} + X-Org-ID: {org_id} + Content-Type: application/json
 *
 * Операции (args.op):
 *   list_queues — GET /queues → очереди аккаунта [{id, key, name}].
 *   list_issues — POST /issues/_search {filter:{queue}} (?perPage=50) → задачи очереди.
 *   get_issue   — GET /issues/{key} → плоско одна задача.
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const BASE = 'https://api.tracker.yandex.net/v2'

export function createYandexTrackerConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'yandex_tracker',
        label: 'Яндекс.Трекер',
        kind: 'yandex_tracker',
        requires: ['yandex_tracker_token', 'yandex_tracker_org_id'],
        status: 'ready',
        detail: 'Задачи и очереди Трекера. OAuth token + org_id в settings (yandex_tracker_token / yandex_tracker_org_id).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('yandex_tracker_token')
      const orgId = ctx.getSecret('yandex_tracker_org_id')
      if (!token || !orgId) {
        return {
          error: 'no-credentials',
          message: 'Yandex.Tracker не настроен. Settings → Янд.Трекер: нужны token и org_id. ' +
                   'Token: oauth.yandex.ru (доступ к Tracker API). org_id: ID организации в Трекере.'
        }
      }
      try {
        switch (op) {
          case 'list_queues': return await listQueues(token, orgId, ctx)
          case 'list_issues': return await listIssues(token, orgId, args, ctx)
          case 'get_issue':   return await getIssue(token, orgId, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_queues, list_issues, get_issue.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listQueues(token: string, orgId: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${BASE}/queues`, token, orgId, ctx)
  const arr = Array.isArray(json) ? json as Array<Record<string, any>> : []
  const queues = arr.map(q => ({ id: q.id ?? null, key: q.key ?? null, name: q.name ?? null }))
  return { count: queues.length, queues }
}

async function listIssues(token: string, orgId: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const queue = String(args.queue ?? '').trim()
  if (!queue) return { error: 'bad-args', message: 'list_issues требует queue — ключ очереди (см. list_queues).' }
  const perPage = Math.max(1, Math.min(100, Number(args.per_page ?? 50) || 50))
  const json = await post(`${BASE}/issues/_search?perPage=${perPage}`, token, orgId, { filter: { queue } }, ctx)
  const arr = Array.isArray(json) ? json as Array<Record<string, any>> : []
  const issues = arr.map(formatIssue)
  return { count: issues.length, issues }
}

async function getIssue(token: string, orgId: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const key = String(args.issue_key ?? '').trim()
  if (!key) return { error: 'bad-args', message: 'get_issue требует issue_key — ключ задачи (например QUEUE-123).' }
  const json = await get(`${BASE}/issues/${encodeURIComponent(key)}`, token, orgId, ctx) as Record<string, any>
  return formatIssueFull(json)
}

// ----------------------------------------------------------------- helpers

async function get(url: string, token: string, orgId: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, { headers: authHeaders(token, orgId), signal: ctx.signal })
  return parse(res)
}

async function post(url: string, token: string, orgId: string, body: unknown, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(token, orgId),
    body: JSON.stringify(body),
    signal: ctx.signal
  })
  return parse(res)
}

function authHeaders(token: string, orgId: string): Record<string, string> {
  return {
    'Authorization': `OAuth ${token}`,
    'X-Org-ID': orgId,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь yandex_tracker_token / yandex_tracker_org_id)'
      : ''
    throw new Error(`Tracker ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('Tracker вернул не-JSON ответ') }
}

// Плоский срез задачи для списка — status/assignee приходят объектами.
function formatIssue(i: Record<string, any>): unknown {
  return {
    key: i.key ?? null,
    summary: i.summary ?? null,
    status: i.status?.display ?? i.status?.key ?? null,
    assignee: i.assignee?.display ?? null
  }
}

// Расширенный срез одной задачи (get_issue).
function formatIssueFull(i: Record<string, any>): unknown {
  return {
    key: i.key ?? null,
    summary: i.summary ?? null,
    description: i.description ?? null,
    status: i.status?.display ?? i.status?.key ?? null,
    assignee: i.assignee?.display ?? null,
    priority: i.priority?.display ?? i.priority?.key ?? null
  }
}
