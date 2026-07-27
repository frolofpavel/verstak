/**
 * Jira connector — задачи, проекты, поиск по JQL (Jira Cloud).
 *
 * Своя реализация поверх официального Jira Cloud REST API v3.
 * Basic-аутентификация: base64(email:api_token) в заголовке Authorization.
 *
 * Зачем агентству: вытащить задачи клиента/команды по JQL для отчёта,
 * посмотреть статус конкретной задачи, получить список проектов в инстансе.
 *
 * Credentials (settings keys) — нужны ВСЕ ТРИ, иначе no-credentials:
 *   jira_base_url   — https://company.atlassian.net (без /rest/api/3).
 *   jira_email      — email пользователя Atlassian.
 *   jira_api_token  — API-токен (id.atlassian.com → Security → API tokens).
 *
 * API:
 *   Base: {jira_base_url}/rest/api/3
 *   Auth: Authorization: Basic base64(email + ':' + api_token), Accept: application/json
 *   ВАЖНО: старый GET /search удалён в Jira Cloud — используем GET /search/jql.
 *   У /search/jql дефолтные fields = только id, поэтому summary/status/assignee/
 *   created запрашиваем явно через параметр fields.
 *
 * Операции (args.op):
 *   search_issues — поиск задач по JQL (jql, max). GET /search/jql.
 *   get_issue     — одна задача по ключу (issue_key). GET /issue/{key}.
 *   list_projects — список проектов. GET /project/search.
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

// Поля, которые тянем для компактного ответа (см. format-хелперы).
const ISSUE_FIELDS = 'summary,status,assignee,created'

function clampMax(raw: unknown, def = 25): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.max(1, Math.min(100, Math.trunc(n)))
}

export function createJiraConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'jira',
        label: 'Jira',
        kind: 'jira',
        requires: ['jira_base_url', 'jira_email', 'jira_api_token'],
        status: 'ready',
        detail: 'Задачи, проекты, поиск по JQL. base_url/email/api_token в settings (jira_base_url).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const baseUrl = ctx.getSecret('jira_base_url')
      const email = ctx.getSecret('jira_email')
      const apiToken = ctx.getSecret('jira_api_token')
      if (!baseUrl || !email || !apiToken) {
        return {
          error: 'no-credentials',
          message: 'Jira не настроена. Settings → Jira: base_url (https://company.atlassian.net), ' +
                   'email и API-токен (id.atlassian.com → Security → Create API token).'
        }
      }
      const base = `${baseUrl.replace(/\/+$/, '')}/rest/api/3`
      const auth = Buffer.from(`${email}:${apiToken}`).toString('base64')
      try {
        switch (op) {
          case 'search_issues': return await searchIssues(base, auth, args, ctx)
          case 'get_issue':     return await getIssue(base, auth, args, ctx)
          case 'list_projects': return await listProjects(base, auth, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: search_issues, get_issue, list_projects.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function searchIssues(base: string, auth: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const jql = String(args.jql ?? 'order by created DESC')
  const params = new URLSearchParams({
    jql,
    maxResults: String(clampMax(args.max)),
    fields: ISSUE_FIELDS
  })
  const json = await get(`${base}/search/jql?${params}`, auth, ctx) as { issues?: Array<Record<string, any>> }
  const issues = (json.issues ?? []).map(formatIssue)
  return { count: issues.length, issues }
}

async function getIssue(base: string, auth: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const key = String(args.issue_key ?? '').trim()
  if (!key) return { error: 'bad-args', message: 'get_issue требует issue_key (напр. PROJ-123).' }
  const params = new URLSearchParams({ fields: ISSUE_FIELDS })
  const json = await get(`${base}/issue/${encodeURIComponent(key)}?${params}`, auth, ctx) as Record<string, any>
  return formatIssue(json)
}

async function listProjects(base: string, auth: string, ctx: ConnectorContext): Promise<unknown> {
  const json = await get(`${base}/project/search`, auth, ctx) as { values?: Array<Record<string, any>> }
  const projects = (json.values ?? []).map(p => ({ id: p.id, key: p.key, name: p.name }))
  return { count: projects.length, projects }
}

// ----------------------------------------------------------------- helpers

async function get(url: string, auth: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь jira_email / jira_api_token / права доступа)'
      : ''
    throw new Error(`Jira ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('Jira вернула не-JSON ответ') }
}

// Плоско достаём только нужные поля из issue (структура одинакова у search и get).
function formatIssue(i: Record<string, any>): unknown {
  const f = (i.fields ?? {}) as Record<string, any>
  return {
    key: i.key ?? null,
    summary: f.summary ?? null,
    status: f.status?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    created: f.created ?? null
  }
}
