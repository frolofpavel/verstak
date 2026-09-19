import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createReadStream } from 'fs'

import { pendingWrites, pendingCommands, suspendedSends } from '../ai/runner-shared'
import { resolvePending } from '../ipc/ai-resolve'
import type { TaggedSender } from '../ipc/tool-handlers/shared'
import type { HeadlessHost, StartTaskOptions } from './host'
import type { TenantRegistry } from './tenants'
import {
  HEADLESS_IDEMPOTENCY_CONFLICT,
  HEADLESS_IDEMPOTENCY_CORRUPT,
  HEADLESS_IDEMPOTENCY_INVALID,
  HEADLESS_IDEMPOTENCY_PENDING,
  HeadlessIdempotencyError,
  type HeadlessTaskOperation
} from '../storage/headless-idempotency'
import { listWorkspaceFiles, resolveArtifactPath } from './artifacts'
import {
  applyConnectorSecrets,
  clearConnectorSecrets,
  listConnectorSecretViews,
  type ConnectorSecretsResult
} from './connector-secrets'

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
  /** Byte-bounded догон. JSON сериализуется один раз и не держит исходный объект в памяти. */
  buffer: SseEntry[]
  bufferBytes: number
  /** Последний seq, который уже нельзя восстановить из буфера (eviction / live-only event). */
  replayFloor: number
  seq: number
  done: boolean
}

interface SseEntry {
  seq: number
  json: string
  bytes: number
}

const BODY_LIMIT = 1024 * 1024
const DEFAULT_SSE_SUBSCRIBERS_PER_RUN = 8
const DEFAULT_SSE_SUBSCRIBERS_PER_TENANT = 16
const DEFAULT_SSE_SUBSCRIBERS_GLOBAL = 64
const DEFAULT_SSE_PENDING_BYTES = 256 * 1024
const DEFAULT_SSE_REPLAY_BYTES = 512 * 1024
const SSE_REPLAY_EVENT_LIMIT = 500
const SSE_RETRY_AFTER_SECONDS = 1

function writeSse(
  res: ServerResponse,
  entry: SseEntry,
  maxPendingBytes: number
): boolean {
  if (res.destroyed || res.writableEnded || !res.writable) return false
  if (res.writableLength + entry.bytes > maxPendingBytes) return false
  try {
    res.write(`id: ${entry.seq}\ndata: ${entry.json}\n\n`)
    return !res.destroyed && !res.writableEnded && res.writableLength <= maxPendingBytes
  } catch {
    return false
  }
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

function headlessErrorResponse(err: unknown): {
  status: number
  headers: Record<string, string>
  body: { error: string; code?: string }
} {
  const message = err instanceof Error ? err.message : 'bad request'
  if (message.startsWith('HEADLESS_TENANT_HOST_CAPACITY')) {
    return {
      status: 503,
      headers: { 'retry-after': '60' },
      body: { error: message }
    }
  }
  if (message.startsWith('HEADLESS_CAPACITY_')) {
    return {
      status: 429,
      headers: { 'retry-after': '60' },
      body: { error: message }
    }
  }
  if (!(err instanceof HeadlessIdempotencyError)) {
    return { status: 400, headers: {}, body: { error: message } }
  }
  const status = {
    [HEADLESS_IDEMPOTENCY_INVALID]: 400,
    [HEADLESS_IDEMPOTENCY_CONFLICT]: 409,
    [HEADLESS_IDEMPOTENCY_PENDING]: 409,
    [HEADLESS_IDEMPOTENCY_CORRUPT]: 500,
  }[err.code]
  return {
    status,
    headers: err.retryAfterSeconds ? { 'retry-after': String(err.retryAfterSeconds) } : {},
    body: { error: message, code: err.code }
  }
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
  /** Живые SSE-клиенты одного прогона. Граница не даёт одной задаче занять все socket'ы. */
  maxSseSubscribersPerRun?: number
  /** Живые SSE-клиенты одного тенанта суммарно по всем его прогонам. */
  maxSseSubscribersPerTenant?: number
  /** Живые SSE-клиенты процесса суммарно по всем тенантам. */
  maxSseSubscribersGlobal?: number
  /** Максимум невыгруженных SSE-байтов на клиента; медленный клиент отсоединяется. */
  maxSsePendingBytes?: number
  /** Максимальный объём replay-буфера одного живого прогона. */
  maxSseReplayBytes?: number
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
  const sseSubscribersByTenant = new Map<string, number>()
  let sseSubscribersGlobal = 0
  const configuredSubscribers = Number(opts.maxSseSubscribersPerRun ?? DEFAULT_SSE_SUBSCRIBERS_PER_RUN)
  const maxSseSubscribersPerRun = Number.isFinite(configuredSubscribers)
    ? Math.max(1, Math.floor(configuredSubscribers))
    : DEFAULT_SSE_SUBSCRIBERS_PER_RUN
  const configuredTenantSubscribers = Number(
    opts.maxSseSubscribersPerTenant ?? DEFAULT_SSE_SUBSCRIBERS_PER_TENANT
  )
  const maxSseSubscribersPerTenant = Number.isFinite(configuredTenantSubscribers)
    ? Math.max(1, Math.floor(configuredTenantSubscribers))
    : DEFAULT_SSE_SUBSCRIBERS_PER_TENANT
  const configuredGlobalSubscribers = Number(
    opts.maxSseSubscribersGlobal ?? DEFAULT_SSE_SUBSCRIBERS_GLOBAL
  )
  const maxSseSubscribersGlobal = Number.isFinite(configuredGlobalSubscribers)
    ? Math.max(1, Math.floor(configuredGlobalSubscribers))
    : DEFAULT_SSE_SUBSCRIBERS_GLOBAL
  const configuredPendingBytes = Number(opts.maxSsePendingBytes ?? DEFAULT_SSE_PENDING_BYTES)
  const maxSsePendingBytes = Number.isFinite(configuredPendingBytes)
    ? Math.max(1024, Math.floor(configuredPendingBytes))
    : DEFAULT_SSE_PENDING_BYTES
  const configuredReplayBytes = Number(opts.maxSseReplayBytes ?? DEFAULT_SSE_REPLAY_BYTES)
  const maxSseReplayBytes = Number.isFinite(configuredReplayBytes)
    ? Math.max(1024, Math.floor(configuredReplayBytes))
    : DEFAULT_SSE_REPLAY_BYTES

  function detachSubscriber(channel: RunChannel, res: ServerResponse, destroy = false): void {
    if (channel.subscribers.delete(res)) {
      sseSubscribersGlobal = Math.max(0, sseSubscribersGlobal - 1)
      const tenantCount = Math.max(0, (sseSubscribersByTenant.get(channel.tenant) ?? 0) - 1)
      if (tenantCount === 0) sseSubscribersByTenant.delete(channel.tenant)
      else sseSubscribersByTenant.set(channel.tenant, tenantCount)
    }
    if (destroy && !res.destroyed) res.destroy()
  }

  function attachSubscriber(channel: RunChannel, res: ServerResponse): void {
    if (channel.subscribers.has(res)) return
    channel.subscribers.add(res)
    sseSubscribersGlobal += 1
    sseSubscribersByTenant.set(channel.tenant, (sseSubscribersByTenant.get(channel.tenant) ?? 0) + 1)
  }

  function pruneSubscribers(channel: RunChannel): void {
    for (const res of channel.subscribers) {
      if (res.destroyed || res.writableEnded || !res.writable) detachSubscriber(channel, res)
    }
  }

  function pruneAllSubscribers(): void {
    for (const channel of channels.values()) pruneSubscribers(channel)
  }

  function rejectSseCapacity(res: ServerResponse, error: string): void {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(SSE_RETRY_AFTER_SECONDS)
    })
    res.end(JSON.stringify({ error }))
  }

  function endGone(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    res.flushHeaders()
    res.write('event: gone\ndata: {}\n\n')
    res.end()
  }

  /**
   * Хост запроса. В многотенантном режиме тенант обязателен: без него сервер не
   * угадывает пользователя, а отказывает (fail-closed) — иначе первый же запрос без
   * заголовка увёл бы задачу в чужие данные.
   */
  async function hostFor(
    req: IncomingMessage,
  ): Promise<{
    host: HeadlessHost
    release: () => void
    signal?: AbortSignal
    onShutdown?: (closeResponse: () => void) => void
  } | { error: string }> {
    if (opts.tenants) {
      const tenant = String(req.headers['x-verstak-tenant'] ?? '').trim()
      if (!tenant) return { error: 'x-verstak-tenant required' }
      const lease = await opts.tenants.get(tenant)
      return {
        host: lease.host,
        release: lease.release,
        signal: lease.signal,
        onShutdown: lease.onShutdown,
      }
    }
    return { host: opts.host!, release: () => {} }
  }

  function channelSender(channel: RunChannel): TaggedSender {
    return {
      send: (_ch, payload) => {
        const seq = ++channel.seq
        const json = JSON.stringify(payload.event) ?? 'null'
        const frame = `id: ${seq}\ndata: ${json}\n\n`
        const entry: SseEntry = { seq, json, bytes: Buffer.byteLength(frame) }

        if (entry.bytes <= maxSseReplayBytes) {
          channel.buffer.push(entry)
          channel.bufferBytes += entry.bytes
          while (
            channel.buffer.length > SSE_REPLAY_EVENT_LIMIT
            || channel.bufferBytes > maxSseReplayBytes
          ) {
            const evicted = channel.buffer.shift()
            if (!evicted) break
            channel.bufferBytes -= evicted.bytes
            channel.replayFloor = Math.max(channel.replayFloor, evicted.seq)
          }
        } else {
          // Событие остаётся доступно уже подключённым клиентам, но не удерживается
          // в памяти. Реконнект до этого seq уйдёт в durable /timeline через gone.
          channel.replayFloor = Math.max(channel.replayFloor, entry.seq)
        }
        for (const res of [...channel.subscribers]) {
          if (!writeSse(res, entry, maxSsePendingBytes)) {
            // Закрытый или не успевающий читать клиент не держит слот и память.
            detachSubscriber(channel, res, true)
          }
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
    // Request lease живёт до фактического завершения ответа. Для обычного JSON
    // это finish в том же запросе; для SSE — close/finish после всего стрима.
    // Идемпотентная обёртка нужна, потому что Node обычно посылает оба события.
    let hostReleased = false
    const releaseHost = (): void => {
      if (hostReleased) return
      hostReleased = true
      resolved.release()
    }
    const assertHostLease = (): void => {
      if (resolved.signal?.aborted) throw new Error('headless-сервис закрывается')
    }
    res.once('finish', releaseHost)
    res.once('close', releaseHost)
    res.once('error', releaseHost)
    // Клиент мог уйти, пока await hostFor() инициализировал tenant-host. Событие
    // close тогда уже прошло до подписки выше; явный readback не даёт потерять lease.
    if (req.destroyed || req.aborted || res.destroyed || res.writableEnded) {
      releaseHost()
      return
    }
    resolved.onShutdown?.(() => {
      // host.close уже дописал/reconcile'нул durable status. Теперь закрываем в том
      // числе SSE зависшего provider и синхронно отпускаем DB-close barrier.
      try { if (!res.destroyed) res.destroy() } finally { releaseHost() }
    })
    assertHostLease()
    const host = resolved.host
    // В single-host режиме внешний заголовок не создаёт фиктивные tenant buckets
    // и не позволяет обойти per-tenant SSE cap.
    const tenantKey = opts.tenants
      ? String(req.headers['x-verstak-tenant'] ?? '').trim()
      : '@single'

    // --- Ключи коннекторов тенанта (задача W5) ---------------------------------
    // Наружу ходят только ИМЕНА ключей. Тенант берётся из того же X-Verstak-Tenant,
    // что и всё остальное, поэтому чужие ключи недостижимы по построению: хост уже
    // выбран по заголовку, а sqlite у тенантов разные.

    // GET /connectors — состав и готовность источников этого тенанта.
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'connectors') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ connectors: listConnectorSecretViews(host) }))
      return
    }

    // POST|DELETE /connectors/{id}/secrets — задать / снять ключи.
    if (parts.length === 3 && parts[0] === 'connectors' && parts[2] === 'secrets'
      && (req.method === 'POST' || req.method === 'DELETE')) {
      const id = decodeURIComponent(parts[1])
      const body = await readJsonBody(req)
      assertHostLease()
      const result: ConnectorSecretsResult = req.method === 'POST'
        ? applyConnectorSecrets(host, id, body)
        : clearConnectorSecrets(host, id, body)
      if (result.ok) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result.view))
        return
      }
      // Запрещённый на сервере коннектор отвечает тем же 404, что несуществующий:
      // разные коды сообщали бы, что ssh на сервере есть, просто закрыт.
      const status = result.reason === 'not-found' ? 404 : 400
      const error = result.reason === 'not-found' ? 'unknown connector' : result.message
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error }))
      return
    }

    // GET /tasks — задачи тенанта (durable, из agent_runs). Строка = ТРЕД, а не прогон:
    // после уточнения задача остаётся одной строкой, у которой сменился последний ход.
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'tasks') {
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const tasks = host.listTasks({ limit: Number.isFinite(limit) ? limit : 50 })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        tasks: tasks.map(t => ({ ...t, live: channels.get(t.runId)?.done === false }))
      }))
      return
    }

    /**
     * Общий запуск прогона: и первая постановка, и продолжение треда. Разница ровно
     * одна — threadId; всё остальное (гейт allowlist, канал, реестр stop) обязано
     * работать одинаково, поэтому путь один, а не два похожих.
     */
    async function startAndRespond(
      body: Record<string, unknown>,
      threadId: number | undefined,
      operation: HeadlessTaskOperation
    ): Promise<void> {
      const channel: RunChannel = {
        sendId: 0,
        tenant: tenantKey,
        subscribers: new Set(),
        buffer: [],
        bufferBytes: 0,
        replayFloor: 0,
        seq: 0,
        done: false
      }
      // Поля берём ЯВНО, а не спредом тела. Слепой спред позволял клиенту прислать
      // "toolsAllow": null и снять allowlist Этапа 1 — то есть включить себе shell.
      // Набор инструментов задаёт хост, а не тот, кто ставит задачу.
      const inferenceRaw = body.inference as Record<string, unknown> | undefined
      const rawIdempotencyKey = req.headers['idempotency-key']
      // Повторяющийся HTTP-заголовок нельзя молча склеить в новый валидный ключ:
      // host применит единый строгий контракт и вернёт 400 до SQLite/provider.
      const idempotencyKey = Array.isArray(rawIdempotencyKey)
        ? rawIdempotencyKey.join(',')
        : rawIdempotencyKey
      const executionKind = body.executionKind === 'web_search'
        || body.executionKind === 'artifact_task'
        || body.executionKind === 'simple_chat'
        ? body.executionKind
        : undefined
      const rawContext = Array.isArray(body.contextMessages) ? body.contextMessages : []
      let contextChars = 0
      const contextMessages: NonNullable<StartTaskOptions['contextMessages']> = rawContext.slice(-40).map(item => {
        if (!item || typeof item !== 'object') throw new Error('contextMessages: ожидаются объекты')
        const value = item as Record<string, unknown>
        const role = value.role
        const content = typeof value.content === 'string' ? value.content : ''
        if (role !== 'system' && role !== 'user' && role !== 'assistant') {
          throw new Error('contextMessages: неизвестная роль')
        }
        contextChars += content.length
        if (contextChars > 60_000) throw new Error('contextMessages: превышен лимит')
        return { role: role as 'system' | 'user' | 'assistant', content }
      })
      const startOpts: StartTaskOptions = {
        prompt: String(body.prompt ?? ''),
        executionKind,
        contextMessages: contextMessages.length ? contextMessages : undefined,
        providerId: body.providerId as StartTaskOptions['providerId'],
        model: body.model === undefined ? undefined : String(body.model),
        agentMode: body.agentMode as StartTaskOptions['agentMode'],
        // workspace продолжения задаёт тред, а не клиент (см. host.startTask).
        workspace: threadId !== undefined || body.workspace === undefined ? undefined : String(body.workspace),
        threadId,
        turnsBudget: body.turnsBudget === undefined ? undefined : Number(body.turnsBudget),
        costCapUsd: body.costCapUsd === undefined ? undefined : Number(body.costCapUsd),
        sender: channelSender(channel),
        idempotency: idempotencyKey === undefined
          ? undefined
          : { key: idempotencyKey, operation }
      }
      if (inferenceRaw && inferenceRaw.baseUrl && inferenceRaw.apiKey) {
        startOpts.inference = {
          baseUrl: String(inferenceRaw.baseUrl),
          apiKey: String(inferenceRaw.apiKey),
          models: Array.isArray(inferenceRaw.models) ? inferenceRaw.models.map(String) : undefined
        }
      }
      const task = await host.startTask(startOpts)
      assertHostLease()
      if (!task.replayed) {
        channel.sendId = task.sendId
        channels.set(task.runId, channel)
        const stop = task.stop
        stops.set(task.runId, stop)
        void task.completion.catch(() => undefined).finally(() => {
          channel.done = true
          for (const sub of [...channel.subscribers]) {
            detachSubscriber(channel, sub)
            try { sub.end() } catch { /* закрыт */ }
          }
          channel.subscribers.clear()
          // Запоздавший finally не имеет права удалить другой канал/стоп с тем же runId.
          if (channels.get(task.runId) === channel) channels.delete(task.runId)
          if (stops.get(task.runId) === stop) stops.delete(task.runId)
        })
      }
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ runId: task.runId, threadId: task.threadId, replayed: task.replayed }))
    }

    // POST /tasks — поставить задачу (новый тред).
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'tasks') {
      const body = await readJsonBody(req)
      assertHostLease()
      await startAndRespond(body, undefined, 'create')
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
        const channel = own && own.tenant === tenantKey && !own.done ? own : undefined
        if (!channel) {
          // Прогон не живёт в этом процессе (рестарт) — хвост читается из /timeline.
          endGone(res)
          return
        }

        const rawLastSeen = Number(req.headers['last-event-id'] ?? 0)
        const lastSeen = Number.isFinite(rawLastSeen) ? Math.max(0, Math.floor(rawLastSeen)) : 0
        // Частичный replay опаснее явного fallback: он тихо потерял бы evicted или
        // live-only событие. Durable timeline — единственный честный догон при gap.
        if (lastSeen < channel.replayFloor || lastSeen > channel.seq) {
          endGone(res)
          return
        }

        pruneAllSubscribers()
        if (channel.subscribers.size >= maxSseSubscribersPerRun) {
          rejectSseCapacity(
            res,
            `HEADLESS_SSE_SUBSCRIBERS: не более ${maxSseSubscribersPerRun} подписчиков на прогон`
          )
          return
        }
        const tenantSubscribers = sseSubscribersByTenant.get(tenantKey) ?? 0
        if (tenantSubscribers >= maxSseSubscribersPerTenant) {
          rejectSseCapacity(
            res,
            `HEADLESS_SSE_SUBSCRIBERS_TENANT: не более ${maxSseSubscribersPerTenant} подписчиков на тенанта`
          )
          return
        }
        if (sseSubscribersGlobal >= maxSseSubscribersGlobal) {
          rejectSseCapacity(
            res,
            `HEADLESS_SSE_SUBSCRIBERS_GLOBAL: не более ${maxSseSubscribersGlobal} подписчиков на процесс`
          )
          return
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        res.flushHeaders()
        for (const entry of channel.buffer) {
          if (entry.seq > lastSeen && !writeSse(res, entry, maxSsePendingBytes)) {
            detachSubscriber(channel, res, true)
            return
          }
        }
        attachSubscriber(channel, res)
        const detach = (): void => detachSubscriber(channel, res)
        req.once('close', detach)
        req.once('error', detach)
        res.once('close', detach)
        res.once('error', detach)
        res.once('finish', detach)
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
        assertHostLease()
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

      // POST /tasks/{runId}/continue — дописать сообщение в тред этого прогона.
      // Новый прогон, ТОТ ЖЕ workspace, история треда в контексте. runId в пути — любой
      // прогон треда: клиент всегда держит его из GET /tasks и не обязан знать threadId.
      if (req.method === 'POST' && tail === 'continue') {
        const body = await readJsonBody(req)
        assertHostLease()
        const threadId = host.getRunThreadId(runId)
        if (threadId == null) {
          // Прогон вне тредовой модели (легаси) — продолжать нечего: истории нет.
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'run has no thread' }))
          return
        }
        await startAndRespond(body, threadId, 'continue')
        return
      }

      // GET /tasks/{runId}/thread — задача ЦЕЛИКОМ: сообщения по порядку + все ходы
      // со своими таймлайнами. /timeline осознанно оставлен пер-прогонным: он читается
      // рядом с SSE одного хода, и расширять его до треда значило бы менять смысл
      // ручки под уже написанным клиентом.
      if (req.method === 'GET' && tail === 'thread') {
        const thread = host.getThread(runId)
        if (!thread) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'run not found' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ...thread,
          runs: thread.runs.map(r => ({ ...r, live: channels.get(r.runId)?.done === false }))
        }))
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
        assertHostLease()
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
        const response = headlessErrorResponse(err)
        res.writeHead(response.status, {
          'content-type': 'application/json',
          ...response.headers
        })
        res.end(JSON.stringify(response.body))
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
