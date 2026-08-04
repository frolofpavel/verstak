import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createReadStream } from 'fs'

import { pendingWrites, pendingCommands, suspendedSends } from '../ai/runner-shared'
import { resolvePending } from '../ipc/ai-resolve'
import type { TaggedSender } from '../ipc/tool-handlers/shared'
import type { HeadlessHost, StartTaskOptions } from './host'
import type { TenantRegistry } from './tenants'
import { listWorkspaceFiles, resolveArtifactPath } from './artifacts'

// HTTP/SSE-транспорт headless-хоста (Этап 1а, блок №3 постановки; отчёт §3в).
// Канал наружу ключуется runId (durable UUID), а не sendId (эфемерный int процесса):
// клиент кабинета переживает реконнект и рестарт, читая хвост из durable-таймлайна
// (GET /tasks/{runId}/timeline ← agent_run_events) и живое — из SSE.
//
// Здесь сознательно нет authn пользователей и биллинга: это зона Gateway (agi-iri).
// Единственная защита самого сервиса — общий bearer-токен процесса (VERSTAK_HOST_TOKEN):
// шлюз держит его у себя, наружу токен не выдаётся.

interface RunChannel {
  sendId: number
  /** Владелец канала. Каналы живут в одной карте по runId, а тенанты — разные. */
  tenant: string
  subscribers: Set<ServerResponse>
  /** Кольцевой буфер последних событий — догон для подписчика, пришедшего в течение прогона. */
  buffer: Array<{ seq: number; event: unknown }>
  seq: number
  done: boolean
}

const BUFFER_LIMIT = 500
const BODY_LIMIT = 1024 * 1024

function writeSse(res: ServerResponse, payload: { seq: number; event: unknown }): void {
  res.write(`id: ${payload.seq}\ndata: ${JSON.stringify(payload.event)}\n\n`)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > BODY_LIMIT) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

export interface HeadlessServerOptions {
  /** Однопользовательский режим: один хост на весь сервер (dev, тесты, десктопный сценарий). */
  host?: HeadlessHost
  /**
   * Многопользовательский режим: хост выбирается по заголовку `X-Verstak-Tenant`.
   * Многотенантность — забота ядра: реестр (sqlite и ключ шифрования на пользователя)
   * лежит здесь же, в tenants.ts, и прод-слою не нужно собирать роутинг заново.
   */
  tenants?: TenantRegistry
  /** Общий bearer-токен сервиса. Не задан → сервер отвечает только без Authorization-проверки (dev). */
  authToken?: string | null
}

export interface HeadlessServer {
  listen: (port: number, hostname?: string) => Promise<number>
  close: () => Promise<void>
  httpServer: Server
}

export function createHeadlessServer(opts: HeadlessServerOptions): HeadlessServer {
  if (!opts.host && !opts.tenants) {
    throw new Error('headless server: нужен host (одно-пользовательский) или tenants (много-пользовательский)')
  }
  const channels = new Map<string, RunChannel>()
  const stops = new Map<string, () => void>()

  /**
   * Хост запроса. В многотенантном режиме тенант обязателен: без него сервер не
   * угадывает пользователя, а отказывает (fail-closed) — иначе первый же запрос без
   * заголовка увёл бы задачу в чужие данные.
   */
  async function hostFor(req: IncomingMessage): Promise<{ host: HeadlessHost } | { error: string }> {
    if (opts.tenants) {
      const tenant = String(req.headers['x-verstak-tenant'] ?? '').trim()
      if (!tenant) return { error: 'x-verstak-tenant required' }
      const handle = await opts.tenants.get(tenant)
      return { host: handle.host }
    }
    return { host: opts.host! }
  }

  function channelSender(channel: RunChannel): TaggedSender {
    return {
      send: (_ch, payload) => {
        const entry = { seq: ++channel.seq, event: payload.event }
        channel.buffer.push(entry)
        if (channel.buffer.length > BUFFER_LIMIT) channel.buffer.shift()
        for (const res of channel.subscribers) {
          try { writeSse(res, entry) } catch { /* подписчик умер — снимется на close */ }
        }
      },
      // Этап 1: browser_* выключены allowlist'ом, exec недостижим; вернуть нечего.
      exec: async () => undefined
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal')
    const parts = url.pathname.split('/').filter(Boolean)

    // /health — ДО авторизации: это проба живости для systemd/деплоя, а не данные.
    // Ничего о задачах и тенантах не раскрывает.
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'verstak-headless', mode: opts.tenants ? 'multi-tenant' : 'single' }))
      return
    }

    if (opts.authToken) {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${opts.authToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
    }

    const resolved = await hostFor(req)
    if ('error' in resolved) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: resolved.error }))
      return
    }
    const host = resolved.host
    const tenantKey = String(req.headers['x-verstak-tenant'] ?? '').trim() || '@single'

    // GET /tasks — задачи тенанта (durable, из agent_runs).
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'tasks') {
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const runs = host.listRuns({ limit: Number.isFinite(limit) ? limit : 50 })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        tasks: runs.map(r => ({ ...r, live: channels.get(r.runId)?.done === false }))
      }))
      return
    }

    // POST /tasks — поставить задачу.
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'tasks') {
      const body = await readJsonBody(req)
      const channel: RunChannel = { sendId: 0, tenant: tenantKey, subscribers: new Set(), buffer: [], seq: 0, done: false }
      const task = await host.startTask({
        ...(body as unknown as StartTaskOptions),
        sender: channelSender(channel)
      })
      channel.sendId = task.sendId
      channels.set(task.runId, channel)
      stops.set(task.runId, task.stop)
      void task.completion.finally(() => {
        channel.done = true
        for (const sub of channel.subscribers) { try { sub.end() } catch { /* закрыт */ } }
        stops.delete(task.runId)
      })
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ runId: task.runId }))
      return
    }

    // Всё остальное — /tasks/{runId}[/...]
    if (parts[0] === 'tasks' && parts.length >= 2) {
      const runId = parts[1]
      const tail = parts[2] ?? null

      // Владение прогоном. В многотенантном режиме БД у тенантов разные, поэтому
      // чужой runId не находится в agent_runs — этого достаточно и для durable-ручек,
      // и (вторым фактом, ниже) для живого канала, который лежит в общей карте.
      if (opts.tenants && host.getRunStatus(runId) === null) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'run not found' }))
        return
      }

      if (req.method === 'GET' && tail === 'events') {
        const own = channels.get(runId)
        const channel = own && own.tenant === tenantKey ? own : undefined
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        if (!channel) {
          // Прогон не живёт в этом процессе (рестарт) — хвост читается из /timeline.
          res.write('event: gone\ndata: {}\n\n')
          res.end()
          return
        }
        const lastSeen = Number(req.headers['last-event-id'] ?? 0)
        for (const entry of channel.buffer) if (entry.seq > lastSeen) writeSse(res, entry)
        if (channel.done) { res.end(); return }
        channel.subscribers.add(res)
        req.on('close', () => channel.subscribers.delete(res))
        return
      }

      // GET /tasks/{runId}/artifacts — файлы workspace задачи.
      if (req.method === 'GET' && tail === 'artifacts' && parts.length === 3) {
        const workspace = host.getRunWorkspace(runId)
        if (!workspace) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'run not found' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ files: listWorkspaceFiles(workspace) }))
        return
      }

      // GET /tasks/{runId}/artifacts/{путь} — сам файл, строго внутри workspace.
      if (req.method === 'GET' && tail === 'artifacts' && parts.length > 3) {
        const workspace = host.getRunWorkspace(runId)
        const rel = decodeURIComponent(parts.slice(3).join('/'))
        const file = workspace ? await resolveArtifactPath(workspace, rel) : null
        if (!file) {
          // Один и тот же 404 и для «нет файла», и для «выход за workspace»:
          // разные коды подсказывали бы, что за границей что-то есть.
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'file not found' }))
          return
        }
        const name = rel.split('/').pop() ?? 'file'
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`
        })
        createReadStream(file).pipe(res)
        return
      }

      if (req.method === 'GET' && tail === 'timeline') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ events: host.listRunEvents(runId) }))
        return
      }

      if (req.method === 'GET' && tail === null) {
        const status = host.getRunStatus(runId)
        if (status === null) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'run not found' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ runId, status, live: channels.get(runId)?.done === false }))
        return
      }

      if (req.method === 'POST' && tail === 'stop') {
        const stop = stops.get(runId)
        if (stop) stop()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ stopped: Boolean(stop) }))
        return
      }

      // Приостановка = abort с пометкой 'suspended' (чекпойнт сохраняется) —
      // та же семантика, что десктопный ai:suspend (ai-resolve.ts).
      if (req.method === 'POST' && tail === 'suspend') {
        const stop = stops.get(runId)
        const channel = channels.get(runId)
        if (stop && channel) {
          suspendedSends.add(channel.sendId)
          stop()
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ suspended: Boolean(stop && channel) }))
        return
      }

      // POST /tasks/{runId}/resolve — ответ человека на pending-write/command.
      // Тот же алгоритм и те же Map'ы, что ai:resolve-* десктопа (ai-resolve.ts).
      if (req.method === 'POST' && tail === 'resolve') {
        const body = await readJsonBody(req)
        const channel = channels.get(runId)
        const callId = String(body.callId ?? '')
        const accept = body.accept === true
        const kind = body.kind === 'command' ? 'command' : 'write'
        if (!channel || !callId) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: channel ? 'callId required' : 'run not live in this process' }))
          return
        }
        resolvePending(kind === 'command' ? pendingCommands : pendingWrites, callId, channel.sendId, accept)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ resolved: true }))
        return
      }
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      try {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'bad request' }))
      } catch { /* headers already sent */ }
    })
  })

  return {
    httpServer,
    listen: (port, hostname = '127.0.0.1') => new Promise((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, hostname, () => {
        const addr = httpServer.address()
        resolve(typeof addr === 'object' && addr ? addr.port : port)
      })
    }),
    close: () => new Promise((resolve) => { httpServer.close(() => resolve()) })
  }
}
