/**
 * Generic HTTP/REST connector.
 *
 * Lets the user wire arbitrary HTTP APIs (REST, MCP-style, custom internal
 * services) without writing code. Up to 4 endpoints are configured in
 * Settings; each has a name, base URL, auth header template, and an
 * allow-list of paths (so a misbehaving AI can't hit anything else).
 *
 * Settings layout (encrypted via safeStorage):
 *   http_endpoint_N_name       (N = 1..4)
 *   http_endpoint_N_base       — base URL, e.g. https://api.example.com
 *   http_endpoint_N_auth       — full Authorization header value, e.g.
 *                                "Bearer xxx" or "Basic xxx". Optional.
 *   http_endpoint_N_paths      — comma-separated allow-list of path prefixes.
 *                                Empty = any path under the base URL.
 *
 * Tool args:
 *   endpoint  — name as configured in settings (e.g. "github").
 *   method    — GET | POST | PUT | DELETE | PATCH (default GET).
 *   path      — relative path appended to the base URL.
 *   query     — record of query params (optional).
 *   body      — JSON-serializable body for POST/PUT/PATCH (optional).
 *   headers   — extra request headers (optional). Auth header from settings
 *               is always added — args.headers can't overwrite it.
 *
 * Output: { status, ok, url, contentType, body } with body redacted by the
 * secret scanner and capped at 256 KB.
 */

import type { Connector, ConnectorContext, ConnectorInfo } from './types'
import { readBodyWithLimit } from './types'

const MAX_ENDPOINTS = 4
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])

interface EndpointConfig {
  name: string
  base: string
  auth: string
  paths: string[]  // allow-list of path prefixes; empty = unrestricted under base
}

function loadEndpoints(getSecret: (k: string) => string | null): EndpointConfig[] {
  const out: EndpointConfig[] = []
  for (let i = 1; i <= MAX_ENDPOINTS; i++) {
    const name = (getSecret(`http_endpoint_${i}_name`) ?? '').trim()
    const base = (getSecret(`http_endpoint_${i}_base`) ?? '').trim()
    if (!name || !base) continue
    const auth = (getSecret(`http_endpoint_${i}_auth`) ?? '').trim()
    const rawPaths = (getSecret(`http_endpoint_${i}_paths`) ?? '').trim()
    const paths = rawPaths
      ? rawPaths.split(',').map(p => p.trim()).filter(Boolean)
      : []
    out.push({ name, base, auth, paths })
  }
  return out
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

function pathAllowed(target: string, allowList: string[]): boolean {
  if (allowList.length === 0) return true
  const norm = target.startsWith('/') ? target : '/' + target
  return allowList.some(p => {
    const prefix = p.startsWith('/') ? p : '/' + p
    return norm === prefix || norm.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')
  })
}

export function createHttpConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'http',
        label: 'Generic HTTP (REST)',
        kind: 'http-rest',
        status: 'ready',
        detail: 'до 4 пользовательских эндпоинтов'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const endpoints = loadEndpoints(ctx.getSecret)
      if (endpoints.length === 0) {
        return {
          error: 'needs-config',
          message: 'В настройках не задан ни один HTTP-эндпоинт. Открой Settings → HTTP коннекторы.',
          configured: []
        }
      }

      const requested = typeof args.endpoint === 'string' ? args.endpoint.trim() : ''
      if (!requested) {
        return {
          error: 'bad-args',
          message: 'Передай endpoint — имя эндпоинта из настроек.',
          configured: endpoints.map(e => e.name)
        }
      }
      const cfg = endpoints.find(e => e.name === requested)
      if (!cfg) {
        return {
          error: 'unknown-endpoint',
          message: `Нет эндпоинта "${requested}". Известны: ${endpoints.map(e => e.name).join(', ')}`,
          configured: endpoints.map(e => e.name)
        }
      }

      const method = (typeof args.method === 'string' ? args.method.toUpperCase() : 'GET')
      if (!ALLOWED_METHODS.has(method)) {
        return { error: 'bad-args', message: `Недопустимый method: ${method}. Разрешены: ${[...ALLOWED_METHODS].join(', ')}` }
      }

      const path = typeof args.path === 'string' ? args.path : '/'
      if (!pathAllowed(path, cfg.paths)) {
        return {
          error: 'path-blocked',
          message: `Путь "${path}" не входит в allow-list эндпоинта "${cfg.name}". Разрешены: ${cfg.paths.join(', ') || '(пусто)'}`
        }
      }

      // Build URL with query params
      const baseUrl = trimSlash(cfg.base)
      const cleanPath = path.startsWith('/') ? path : '/' + path
      let url = baseUrl + cleanPath
      if (args.query && typeof args.query === 'object' && !Array.isArray(args.query)) {
        const params = new URLSearchParams()
        for (const [k, v] of Object.entries(args.query as Record<string, unknown>)) {
          if (v != null) params.set(k, String(v))
        }
        const qs = params.toString()
        if (qs) url += (url.includes('?') ? '&' : '?') + qs
      }

      // Headers: user-supplied first, then auth header from config (auth wins).
      const headers: Record<string, string> = { 'Accept': 'application/json, text/*;q=0.9, */*;q=0.5' }
      if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
        for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
          if (v != null) headers[k] = String(v)
        }
      }
      if (cfg.auth) headers['Authorization'] = cfg.auth

      // Body
      let body: string | undefined
      if (method !== 'GET' && method !== 'DELETE' && args.body != null) {
        if (typeof args.body === 'string') {
          body = args.body
          if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
        } else {
          body = JSON.stringify(args.body)
          headers['Content-Type'] = 'application/json'
        }
      }

      try {
        const res = await fetch(url, { method, headers, body, signal: ctx.signal })
        const bodyText = await readBodyWithLimit(res)
        return {
          status: res.status,
          ok: res.ok,
          url,
          method,
          contentType: res.headers.get('content-type') ?? '',
          body: bodyText
        }
      } catch (err) {
        return {
          error: 'fetch-failed',
          message: err instanceof Error ? err.message : String(err),
          url,
          method
        }
      }
    }
  }
}
