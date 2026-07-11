/**
 * GitHub connector — REST API v3.
 *
 * Позволяет AI работать с GitHub: репозитории, issues, PR, code search.
 * Auth через Personal Access Token (ghp_... или fine-grained).
 *
 * Настройки: github_token в settings (зашифровано через safeStorage).
 *
 * Rate limiting: GitHub REST API — 5000 req/hour для авторизованных.
 * При X-RateLimit-Remaining < 50 коннектор добавляет предупреждение в ответ.
 *
 * Безопасность:
 * - Токен никогда не попадает в ответ (secret-scanner + он только в headers).
 * - Read-only: create_issue/create_pr заблокированы (инвариант «коннекторы
 *   read-only», как bitrix24) — запись в чужой репо недопустима.
 * - Ответы обрезаются до MAX_FIELD_BYTES на поле.
 */

import * as https from 'https'
import type { Connector, ConnectorContext, ConnectorInfo } from './types'

const GITHUB_API_HOST = 'api.github.com'
const MAX_FIELD_BYTES = 10 * 1024  // 10 KB per text field

// GitHub API response — used in internal helpers only
interface GitHubResponse {
  data: unknown
  rateRemaining: number
  rateReset: number
}

// Low-level GitHub API call via native https (no external deps)
async function githubApi(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<GitHubResponse> {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Verstak',
      'X-GitHub-Api-Version': '2022-11-28'
    }
    if (bodyStr) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr))
    }

    const req = https.request(
      {
        hostname: GITHUB_API_HOST,
        path,
        method,
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const rateRemaining = parseInt(res.headers['x-ratelimit-remaining'] as string ?? '5000', 10)
          const rateReset = parseInt(res.headers['x-ratelimit-reset'] as string ?? '0', 10)
          const status = res.statusCode ?? 0

          if (status === 204) {
            resolve({ data: null, rateRemaining, rateReset })
            return
          }

          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = { _raw: raw.slice(0, 500) }
          }

          if (status >= 400) {
            const msg = (parsed as { message?: string })?.message ?? `HTTP ${status}`
            const hint = statusHint(status)
            reject(new GitHubApiError(status, `${msg}${hint}`, parsed))
            return
          }

          resolve({ data: parsed, rateRemaining, rateReset })
        })
        res.on('error', reject)
      }
    )

    // Поддержка AbortSignal
    if (signal) {
      if (signal.aborted) {
        req.destroy()
        reject(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => { req.destroy(); reject(new Error('aborted')) }, { once: true })
    }

    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

function statusHint(status: number): string {
  switch (status) {
    case 401: return '. Проверь github_token — он невалидный или истёк.'
    case 403: return '. Нет доступа: repo может быть приватным или не хватает scope.'
    case 404: return '. Ресурс не найден. Проверь owner/repo/номер.'
    case 422: return '. Ошибка валидации. Проверь обязательные поля запроса.'
    case 429: return '. Rate limit исчерпан. Жди сброса через несколько минут.'
    default: return ''
  }
}

// Обрезать строку до MAX_FIELD_BYTES байт
function truncateField(s: unknown): string {
  if (typeof s !== 'string') return String(s ?? '')
  if (Buffer.byteLength(s, 'utf8') <= MAX_FIELD_BYTES) return s
  return s.slice(0, MAX_FIELD_BYTES) + '\n…[truncated]'
}

// Добавить предупреждение о rate limit если осталось мало запросов
function rateWarning(remaining: number, result: Record<string, unknown>): Record<string, unknown> {
  if (remaining < 50) {
    return { ...result, _rate_limit_warning: `Осталось ${remaining} запросов к GitHub API. Используй API экономно.` }
  }
  return result
}

// Обязательный строковый аргумент
function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Аргумент "${key}" обязателен и должен быть непустой строкой.`)
  }
  return v.trim()
}

// Опциональный строковый аргумент
function optString(args: Record<string, unknown>, key: string, def = ''): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : def
}

// Опциональный числовой аргумент
function optInt(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key]
  if (v == null) return def
  const n = parseInt(String(v), 10)
  return isNaN(n) ? def : n
}

// ----------------------------------------------------------------- операции

async function listRepos(token: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const type = optString(args, 'type', 'all')  // all | owner | public | private | member
  const sort = optString(args, 'sort', 'updated')  // created | updated | pushed | full_name
  const per_page = optInt(args, 'per_page', 30)
  const page = optInt(args, 'page', 1)
  const filter = optString(args, 'filter', '')  // substring фильтр по имени

  const path = `/user/repos?type=${type}&sort=${sort}&per_page=${Math.min(per_page, 100)}&page=${page}`
  const { data, rateRemaining } = await githubApi(token, 'GET', path, undefined, signal)

  const repos = (data as Array<Record<string, unknown>>).map(r => ({
    full_name: r.full_name,
    description: truncateField(r.description ?? ''),
    private: r.private,
    language: r.language,
    default_branch: r.default_branch,
    open_issues_count: r.open_issues_count,
    stargazers_count: r.stargazers_count,
    updated_at: r.updated_at,
    url: r.html_url
  }))

  const filtered = filter
    ? repos.filter(r => String(r.full_name).toLowerCase().includes(filter.toLowerCase()))
    : repos

  return rateWarning(rateRemaining, { repos: filtered, count: filtered.length, page, per_page })
}

async function listIssues(token: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const repo = requireString(args, 'repo')  // owner/repo
  const state = optString(args, 'state', 'open')  // open | closed | all
  const labels = optString(args, 'labels', '')
  const per_page = optInt(args, 'per_page', 20)
  const page = optInt(args, 'page', 1)

  let path = `/repos/${repo}/issues?state=${state}&per_page=${Math.min(per_page, 100)}&page=${page}`
  if (labels) path += `&labels=${encodeURIComponent(labels)}`

  const { data, rateRemaining } = await githubApi(token, 'GET', path, undefined, signal)

  // GitHub возвращает и PR в /issues — фильтруем только настоящие issues
  const issues = (data as Array<Record<string, unknown>>)
    .filter(i => !i.pull_request)
    .map(i => ({
      number: i.number,
      title: truncateField(i.title),
      state: i.state,
      labels: (i.labels as Array<{ name: string }>).map(l => l.name),
      author: (i.user as { login: string })?.login,
      created_at: i.created_at,
      updated_at: i.updated_at,
      comments: i.comments,
      url: i.html_url
    }))

  return rateWarning(rateRemaining, { issues, count: issues.length, repo, state, page })
}

async function getIssue(token: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const repo = requireString(args, 'repo')
  const number = optInt(args, 'number', 0)
  if (!number) throw new Error('Аргумент "number" обязателен — номер issue.')

  // Загружаем issue и комментарии параллельно
  const [issueResp, commentsResp] = await Promise.all([
    githubApi(token, 'GET', `/repos/${repo}/issues/${number}`, undefined, signal),
    githubApi(token, 'GET', `/repos/${repo}/issues/${number}/comments?per_page=30`, undefined, signal)
  ])

  const i = issueResp.data as Record<string, unknown>
  const comments = (commentsResp.data as Array<Record<string, unknown>>).map(c => ({
    author: (c.user as { login: string })?.login,
    body: truncateField(c.body),
    created_at: c.created_at
  }))

  const result = {
    number: i.number,
    title: truncateField(i.title),
    state: i.state,
    body: truncateField(i.body),
    labels: (i.labels as Array<{ name: string }>).map(l => l.name),
    author: (i.user as { login: string })?.login,
    assignees: (i.assignees as Array<{ login: string }>).map(a => a.login),
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    comments_count: i.comments,
    comments,
    url: i.html_url
  }

  return rateWarning(issueResp.rateRemaining, result)
}

async function listPRs(token: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const repo = requireString(args, 'repo')
  const state = optString(args, 'state', 'open')  // open | closed | all
  const per_page = optInt(args, 'per_page', 20)
  const page = optInt(args, 'page', 1)
  const base = optString(args, 'base', '')  // целевая ветка

  let path = `/repos/${repo}/pulls?state=${state}&per_page=${Math.min(per_page, 100)}&page=${page}`
  if (base) path += `&base=${encodeURIComponent(base)}`

  const { data, rateRemaining } = await githubApi(token, 'GET', path, undefined, signal)

  const prs = (data as Array<Record<string, unknown>>).map(pr => ({
    number: pr.number,
    title: truncateField(pr.title),
    state: pr.state,
    author: (pr.user as { login: string })?.login,
    head: (pr.head as { ref: string })?.ref,
    base: (pr.base as { ref: string })?.ref,
    draft: pr.draft,
    mergeable_state: pr.mergeable_state,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    url: pr.html_url
  }))

  return rateWarning(rateRemaining, { prs, count: prs.length, repo, state, page })
}

async function getPR(token: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const repo = requireString(args, 'repo')
  const number = optInt(args, 'number', 0)
  if (!number) throw new Error('Аргумент "number" обязателен — номер PR.')

  const { data, rateRemaining } = await githubApi(token, 'GET', `/repos/${repo}/pulls/${number}`, undefined, signal)
  const pr = data as Record<string, unknown>

  return rateWarning(rateRemaining, {
    number: pr.number,
    title: truncateField(pr.title),
    state: pr.state,
    body: truncateField(pr.body),
    author: (pr.user as { login: string })?.login,
    head: (pr.head as { ref: string; sha: string }),
    base: (pr.base as { ref: string }),
    draft: pr.draft,
    mergeable: pr.mergeable,
    mergeable_state: pr.mergeable_state,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    commits: pr.commits,
    labels: (pr.labels as Array<{ name: string }>).map(l => l.name),
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    merged_at: pr.merged_at,
    url: pr.html_url
  })
}

async function listCommits(token: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const repo = requireString(args, 'repo')
  const branch = optString(args, 'branch', '')  // default = default_branch репо
  const per_page = optInt(args, 'per_page', 20)
  const page = optInt(args, 'page', 1)
  const author = optString(args, 'author', '')  // GitHub login

  let path = `/repos/${repo}/commits?per_page=${Math.min(per_page, 100)}&page=${page}`
  if (branch) path += `&sha=${encodeURIComponent(branch)}`
  if (author) path += `&author=${encodeURIComponent(author)}`

  const { data, rateRemaining } = await githubApi(token, 'GET', path, undefined, signal)

  const commits = (data as Array<Record<string, unknown>>).map(c => {
    const commit = c.commit as Record<string, unknown>
    const author = commit.author as Record<string, unknown>
    return {
      sha: String(c.sha).slice(0, 8),
      message: truncateField(String(commit.message ?? '').split('\n')[0]),
      author: author?.name ?? (c.author as { login?: string })?.login,
      date: author?.date,
      url: c.html_url
    }
  })

  return rateWarning(rateRemaining, { commits, count: commits.length, repo, branch: branch || 'default', page })
}

async function getFile(token: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const repo = requireString(args, 'repo')
  const path = requireString(args, 'path')  // путь к файлу в репо
  const ref = optString(args, 'ref', '')    // branch/tag/sha; пусто = default_branch

  // 2.0.1 bug: сегменты пути не кодировались → файлы с пробелом/'?'/'#' в имени
  // ломали запрос (404/обрезание по query). Кодируем каждый сегмент (не '/').
  const encodedPath = path.replace(/^\//, '').split('/').map(encodeURIComponent).join('/')
  let apiPath = `/repos/${repo}/contents/${encodedPath}`
  if (ref) apiPath += `?ref=${encodeURIComponent(ref)}`

  const { data, rateRemaining } = await githubApi(token, 'GET', apiPath, undefined, signal)
  const file = data as Record<string, unknown>

  // GitHub отдаёт листинг директории МАССИВОМ (у него нет поля .type) — раньше
  // ветка по file.type==='dir' была мёртвой, dir-листинг ломался (C3).
  if (Array.isArray(data)) {
    // Директория — возвращаем список файлов
    const entries = (data as Array<Record<string, unknown>>).map(e => ({
      name: e.name,
      type: e.type,
      size: e.size,
      path: e.path
    }))
    return rateWarning(rateRemaining, { type: 'dir', path, entries, count: entries.length })
  }

  // Файл — декодируем base64
  let content = ''
  if (file.encoding === 'base64' && typeof file.content === 'string') {
    const decoded = Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8')
    content = truncateField(decoded)
  }

  return rateWarning(rateRemaining, {
    type: 'file',
    path: file.path,
    name: file.name,
    size: file.size,
    sha: file.sha,
    content,
    encoding: 'utf8',
    url: file.html_url
  })
}

async function searchCode(token: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const q = requireString(args, 'q')  // поисковый запрос
  const repo = optString(args, 'repo', '')  // ограничить поиск конкретным repo (owner/repo)
  const per_page = optInt(args, 'per_page', 10)

  let query = q
  if (repo) query += ` repo:${repo}`

  const path = `/search/code?q=${encodeURIComponent(query)}&per_page=${Math.min(per_page, 30)}`

  const { data, rateRemaining } = await githubApi(token, 'GET', path, undefined, signal)
  const result = data as { total_count: number; items: Array<Record<string, unknown>> }

  const items = result.items.map(item => ({
    path: item.path,
    repository: (item.repository as { full_name: string })?.full_name,
    url: item.html_url,
    // text_matches есть только при Accept: application/vnd.github.text-match+json
    score: item.score
  }))

  return rateWarning(rateRemaining, {
    total_count: result.total_count,
    returned: items.length,
    query,
    items
  })
}

// ----------------------------------------------------------------- фабрика

export function createGitHubConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'github',
        label: 'GitHub',
        kind: 'github',
        status: 'ready',
        detail: 'Репозитории, issues, PR, code search (github_token в settings)'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const token = ctx.getSecret('github_token')
      if (!token) {
        return {
          error: 'no-credentials',
          message: 'GitHub token не настроен. Открой Settings → GitHub → введи Personal Access Token.'
        }
      }

      const op = String(args.op ?? '')

      try {
        switch (op) {
          case 'list_repos':    return await listRepos(token, args, ctx.signal)
          case 'list_issues':   return await listIssues(token, args, ctx.signal)
          case 'get_issue':     return await getIssue(token, args, ctx.signal)
          case 'list_prs':      return await listPRs(token, args, ctx.signal)
          case 'get_pr':        return await getPR(token, args, ctx.signal)
          case 'list_commits':  return await listCommits(token, args, ctx.signal)
          case 'get_file':      return await getFile(token, args, ctx.signal)
          case 'search_code':   return await searchCode(token, args, ctx.signal)
          // Инвариант: все коннекторы read-only (как bitrix24). create_issue/
          // create_pr реально писали POST в чужой репо — в auto/bypass без
          // подтверждения. Блокируем, как write-операции Битрикс24 (C2).
          case 'create_issue':
          case 'create_pr':
            return { error: 'read-only', message: `GitHub-коннектор — read-only. Операция «${op}» (запись в чужой репозиторий) недоступна.` }
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная операция «${op}». Доступно (read-only): list_repos, list_issues, get_issue, list_prs, get_pr, list_commits, get_file, search_code.`
            }
        }
      } catch (err) {
        if (err instanceof GitHubApiError) {
          return {
            error: 'github-api-error',
            status: err.status,
            message: err.message,
            op
          }
        }
        return {
          error: 'request-failed',
          message: err instanceof Error ? err.message : String(err),
          op
        }
      }
    }
  }
}
