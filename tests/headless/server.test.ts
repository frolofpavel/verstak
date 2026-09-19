import { describe, it, expect, vi, afterEach } from 'vitest'
import { request, type ClientRequest, type IncomingMessage } from 'http'

// HTTP/SSE-транспорт headless-хоста (Этап 1а, блок №3). Хост подменяется фейком
// (интерфейс HeadlessHost) — sqlite и провайдеры серверу не нужны, он транспорт.
// Мок electron кидает — транспорт обязан жить в чистом Node.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createHeadlessServer } = await import('../../electron/headless/server')
const { pendingWrites, scopedKey } = await import('../../electron/ai/runner-shared')
const {
  HEADLESS_IDEMPOTENCY_CONFLICT,
  HEADLESS_IDEMPOTENCY_INVALID,
  HEADLESS_IDEMPOTENCY_PENDING,
  HeadlessIdempotencyError,
} = await import('../../electron/storage/headless-idempotency')
type HeadlessHost = import('../../electron/headless/host').HeadlessHost
type StartTaskOptions = import('../../electron/headless/host').StartTaskOptions
type TenantRegistry = import('../../electron/headless/tenants').TenantRegistry
type TaggedSender = import('../../electron/ipc/tool-handlers/shared').TaggedSender

interface TestServerOptions {
  maxSseSubscribersPerRun?: number
  maxSseSubscribersPerTenant?: number
  maxSseSubscribersGlobal?: number
  maxSsePendingBytes?: number
  maxSseReplayBytes?: number
}

function jsonRequest(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

interface OpenSse {
  req: ClientRequest
  res: IncomingMessage
  status: number
  headers: IncomingMessage['headers']
  lines: string[]
  chunks: string[]
  closed: Promise<void>
}

/** Открывает SSE до первых заголовков, не дожидаясь конца живого прогона. */
function openSse(port: number, path: string, headers: Record<string, string> = {}): Promise<OpenSse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path, headers }, res => {
      const lines: string[] = []
      const chunks: string[] = []
      let settled = false
      const closed = new Promise<void>(done => {
        const finish = (): void => {
          if (settled) return
          settled = true
          done()
        }
        res.once('end', finish)
        res.once('close', finish)
        res.once('error', finish)
      })
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        chunks.push(chunk)
        for (const line of chunk.split('\n')) if (line.startsWith('data: ')) lines.push(line.slice(6))
      })
      resolve({ req, res, status: res.statusCode ?? 0, headers: res.headers, lines, chunks, closed })
    })
    req.setTimeout(2_000, () => req.destroy(new Error('SSE headers timeout')))
    req.once('error', reject)
    req.end()
  })
}

/**
 * Клиентский close означает, что локальный socket закрыт, но не обещает, что
 * серверный event loop уже обработал FIN/RST. Повторяем только ожидаемый 429
 * в коротком bounded-окне: если счётчик не освободится, тест всё равно красный.
 */
async function openSseAfterDisconnect(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  timeoutMs = 1000,
): Promise<OpenSse> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const candidate = await openSse(port, path, headers)
    if (candidate.status !== 429) return candidate
    await candidate.closed
    if (Date.now() >= deadline) return candidate
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Читает SSE до конца стрима (или до maxMs) и отдаёт сырые data-строки. */
function readSse(port: number, path: string, maxMs = 5000) {
  return new Promise<string[]>((resolve, reject) => {
    const lines: string[] = []
    const req = request({ host: '127.0.0.1', port, method: 'GET', path }, res => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) if (line.startsWith('data: ')) lines.push(line.slice(6))
      })
      res.on('end', () => resolve(lines))
    })
    req.on('error', reject)
    req.end()
    // Бюджет ожидания заметно меньше testTimeout (§3.1): осмысленная ошибка вместо таймаута прогона.
    setTimeout(() => { req.destroy(); resolve(lines) }, maxMs).unref()
  })
}

function makeFakeHost(startError?: string | Error, runId = 'run-fake-1') {
  let capturedSender: TaggedSender | null = null
  let resolveCompletion: () => void = () => {}
  let startCalls = 0
  const starts: StartTaskOptions[] = []
  const stop = vi.fn()
  const host: HeadlessHost = {
    startTask: async (opts) => {
      if (startError) throw typeof startError === 'string' ? new Error(startError) : startError
      startCalls += 1
      starts.push(opts)
      capturedSender = opts.sender ?? null
      return {
        runId,
        threadId: 7,
        sendId: 42,
        replayed: false,
        completion: new Promise<void>(r => { resolveCompletion = r }),
        stop
      }
    },
    getSecret: () => null,
    setSecret: () => undefined,
    deleteSecret: () => undefined,
    listRunEvents: (candidate) => candidate === runId
      ? [{ kind: 'user_msg', label: null, detail: 'задача', createdAt: 1 }]
      : [],
    getRunStatus: (candidate) => (candidate === runId ? 'running' : null),
    listTasks: () => [{
      threadId: 7, runId, prompt: 'задача', workspace: '/w', providerId: 'deepseek',
      model: 'm', status: 'running', createdAt: 1, endedAt: null, lastActivityAt: 1, runCount: 1
    }],
    getThread: (candidate) => (candidate === runId ? {
      threadId: 7, title: 'задача', workspace: '/w', createdAt: 1, lastActivityAt: 1,
      messages: [{ id: 1, role: 'user' as const, content: 'задача', createdAt: 1 }],
      runs: [{
        runId, status: 'running', providerId: 'deepseek', model: 'm',
        startedAt: 1, endedAt: null,
        events: [{ kind: 'user_msg', label: null, detail: 'задача', createdAt: 1 }]
      }]
    } : null),
    getRunThreadId: (candidate) => (candidate === runId ? 7 : null),
    getRunWorkspace: (candidate) => (candidate === runId ? '/w' : null),
    // C1: правка фикстуры при неизменных утверждениях — фейк добирает новые поля
    // контракта HeadlessHost (расписание в этих тестах не участвует).
    scheduledJobs: {
      create: () => { throw new Error('fake host: расписание не участвует') },
      get: () => null,
      list: () => [],
      due: () => [],
      recordRun: () => undefined,
      setEnabled: () => undefined,
      remove: () => undefined
    },
    schedulerTick: async () => 0,
    close: async () => undefined
  }
  return {
    host, stop,
    startCalls: () => startCalls,
    starts,
    emit: (event: unknown) => capturedSender?.send('ai:event', { id: 42, event }),
    finish: () => resolveCompletion()
  }
}

describe('headless server — HTTP/SSE транспорт (Этап 1а, №3)', () => {
  const servers: Array<{ close: () => Promise<void> }> = []
  afterEach(async () => { for (const s of servers.splice(0)) await s.close() })

  async function boot(authToken?: string, serverOptions: TestServerOptions = {}, startError?: string | Error) {
    const fake = makeFakeHost(startError)
    const server = createHeadlessServer({ host: fake.host, authToken, ...serverOptions })
    servers.push(server)
    const port = await server.listen(0)
    return { ...fake, port }
  }

  async function bootTenants(serverOptions: TestServerOptions = {}) {
    const tenantA = makeFakeHost(undefined, 'run-tenant-a')
    const tenantB = makeFakeHost(undefined, 'run-tenant-b')
    const hosts = new Map([
      ['tenant-a', tenantA.host],
      ['tenant-b', tenantB.host]
    ])
    const tenants: TenantRegistry = {
      get: async (tenantId) => {
        const host = hosts.get(tenantId)
        if (!host) throw new Error('unknown test tenant')
        return {
          tenantId,
          host,
          workspaceRoot: `/w/${tenantId}`,
          signal: new AbortController().signal,
          onShutdown: () => {},
          release: () => {},
        }
      },
      connectorStatus: async () => [],
      closeAll: async () => undefined
    }
    const server = createHeadlessServer({ tenants, ...serverOptions })
    servers.push(server)
    const port = await server.listen(0)
    return { tenantA, tenantB, port }
  }

  it('bearer-гейт: без токена 401, с токеном 202 + runId', async () => {
    const { port } = await boot('s3cret')
    const denied = await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    expect(denied.status).toBe(401)
    const ok = await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' }, { authorization: 'Bearer s3cret' })
    expect(ok.status).toBe(202)
    expect(JSON.parse(ok.body).runId).toBe('run-fake-1')
  })

  it('disconnect during async tenant init releases the late lease without touching host', async () => {
    const fake = makeFakeHost()
    const listTasks = vi.fn(fake.host.listTasks)
    fake.host.listTasks = listTasks
    type Lease = Awaited<ReturnType<TenantRegistry['get']>>
    let resolveLease!: (lease: Lease) => void
    let markEntered!: () => void
    const initialized = new Promise<Lease>(resolve => { resolveLease = resolve })
    const entered = new Promise<void>(resolve => { markEntered = resolve })
    const release = vi.fn()
    const tenants: TenantRegistry = {
      get: () => {
        markEntered()
        return initialized
      },
      connectorStatus: async () => [],
      closeAll: async () => undefined,
    }
    const server = createHeadlessServer({ tenants })
    servers.push(server)
    const port = await server.listen(0)
    const clientClosed = new Promise<void>(resolve => {
      const req = request({
        host: '127.0.0.1', port, method: 'GET', path: '/tasks',
        headers: { 'x-verstak-tenant': 'slow-init' },
      })
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      req.once('error', done)
      req.once('close', done)
      req.end()
      void entered.then(() => req.destroy())
    })
    await entered
    await clientClosed
    resolveLease({
      tenantId: 'slow-init',
      host: fake.host,
      workspaceRoot: '/w/slow-init',
      signal: new AbortController().signal,
      onShutdown: () => {},
      release,
    })

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    expect(listTasks).not.toHaveBeenCalled()
  })

  it('forwards Idempotency-Key as a route-bound host contract', async () => {
    const { port, starts } = await boot()
    const response = await jsonRequest(
      port,
      'POST',
      '/tasks',
      { prompt: 'x', providerId: 'deepseek' },
      { 'idempotency-key': 'create-request-001' },
    )
    expect(response.status).toBe(202)
    expect(starts[0].idempotency).toEqual({ key: 'create-request-001', operation: 'create' })
  })

  it('binds continuation idempotency to the resolved thread rather than the run anchor', async () => {
    const { port, starts } = await boot()
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'first', providerId: 'deepseek' })
    const response = await jsonRequest(
      port,
      'POST',
      '/tasks/run-fake-1/continue',
      { prompt: 'next', providerId: 'deepseek' },
      { 'idempotency-key': 'continue-request-001' },
    )
    expect(response.status).toBe(202)
    expect(starts[1].threadId).toBe(7)
    expect(starts[1].idempotency).toEqual({ key: 'continue-request-001', operation: 'continue' })
  })

  it('an idempotent replay returns the same task without replacing its live SSE channel', async () => {
    const setup = await boot()
    const originalStart = setup.host.startTask
    let accepted: Awaited<ReturnType<HeadlessHost['startTask']>> | null = null
    setup.host.startTask = async (opts) => {
      if (!accepted) {
        accepted = await originalStart(opts)
        return accepted
      }
      return { ...accepted, replayed: true }
    }
    const headers = { 'idempotency-key': 'same-logical-request' }
    const first = await jsonRequest(setup.port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek' }, headers)
    const replay = await jsonRequest(setup.port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek' }, headers)
    expect(JSON.parse(first.body).replayed).toBe(false)
    expect(JSON.parse(replay.body)).toMatchObject({ runId: 'run-fake-1', threadId: 7, replayed: true })

    const live = readSse(setup.port, '/tasks/run-fake-1/events', 2000)
    await new Promise(resolve => setTimeout(resolve, 50))
    setup.emit({ type: 'text', text: 'channel-still-live' })
    setup.finish()
    expect((await live).some(line => line.includes('channel-still-live'))).toBe(true)
  })

  it('maps idempotency pending/conflict to 409 and preserves Retry-After', async () => {
    const pending = new HeadlessIdempotencyError(
      HEADLESS_IDEMPOTENCY_PENDING,
      'request is still being accepted',
      2,
    )
    const pendingServer = await boot(undefined, {}, pending)
    const pendingResponse = await jsonRequest(pendingServer.port, 'POST', '/tasks', { prompt: 'x' })
    expect(pendingResponse.status).toBe(409)
    expect(pendingResponse.headers['retry-after']).toBe('2')
    expect(JSON.parse(pendingResponse.body).code).toBe(HEADLESS_IDEMPOTENCY_PENDING)

    const conflictServer = await boot(undefined, {}, new HeadlessIdempotencyError(
      HEADLESS_IDEMPOTENCY_CONFLICT,
      'key belongs to another request',
    ))
    const conflictResponse = await jsonRequest(conflictServer.port, 'POST', '/tasks', { prompt: 'x' })
    expect(conflictResponse.status).toBe(409)
    expect(JSON.parse(conflictResponse.body).code).toBe(HEADLESS_IDEMPOTENCY_CONFLICT)

    const invalidServer = await boot(undefined, {}, new HeadlessIdempotencyError(
      HEADLESS_IDEMPOTENCY_INVALID,
      'invalid key',
    ))
    const invalidResponse = await jsonRequest(invalidServer.port, 'POST', '/tasks', { prompt: 'x' })
    expect(invalidResponse.status).toBe(400)
    expect(JSON.parse(invalidResponse.body).code).toBe(HEADLESS_IDEMPOTENCY_INVALID)
  })

  it('capacity errors are 429 with Retry-After; ordinary start errors stay 400', async () => {
    for (const code of ['HEADLESS_CAPACITY_ACTIVE', 'HEADLESS_CAPACITY_DAILY', 'HEADLESS_CAPACITY_GLOBAL']) {
      const { port } = await boot(undefined, {}, `${code}: limit reached`)
      const response = await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek' })
      expect(response.status).toBe(429)
      expect(response.headers['retry-after']).toBe('60')
      expect(JSON.parse(response.body)).toEqual({ error: `${code}: limit reached` })
    }

    const unavailableRegistry: TenantRegistry = {
      get: async () => { throw new Error('HEADLESS_TENANT_HOST_CAPACITY: limit reached') },
      connectorStatus: async () => [],
      closeAll: async () => undefined,
    }
    const unavailableServer = createHeadlessServer({ tenants: unavailableRegistry })
    servers.push(unavailableServer)
    const unavailablePort = await unavailableServer.listen(0)
    const unavailable = await jsonRequest(
      unavailablePort,
      'GET',
      '/tasks',
      undefined,
      { 'x-verstak-tenant': 'new-tenant' }
    )
    expect(unavailable.status).toBe(503)
    expect(unavailable.headers['retry-after']).toBe('60')
    expect(JSON.parse(unavailable.body)).toEqual({ error: 'HEADLESS_TENANT_HOST_CAPACITY: limit reached' })

    const { port } = await boot(undefined, {}, 'ordinary start failure')
    const response = await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek' })
    expect(response.status).toBe(400)
    expect(response.headers['retry-after']).toBeUndefined()
    expect(JSON.parse(response.body)).toEqual({ error: 'ordinary start failure' })
  })

  it('SSE: события прогона доходят подписчику; завершение прогона закрывает стрим', async () => {
    const { port, emit, finish } = await boot()
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    const ssePromise = readSse(port, '/tasks/run-fake-1/events')
    // Дать подписчику встать, затем поток событий и финал.
    await new Promise(r => setTimeout(r, 100))
    emit({ type: 'text', text: 'работаю' })
    emit({ type: 'done' })
    finish()
    const lines = await ssePromise
    const types = lines.map(l => (JSON.parse(l) as { type?: string }).type)
    expect(types).toContain('text')
    expect(types).toContain('done')
  })

  it('поздний LIVE-подписчик догоняет буфер; после completion канал gone, а timeline durable', async () => {
    const { port, emit, finish } = await boot()
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    emit({ type: 'text', text: 'раннее событие' })
    const live = readSse(port, '/tasks/run-fake-1/events', 2000)
    await new Promise(resolve => setTimeout(resolve, 50))
    emit({ type: 'done' })
    finish()
    const lines = await live
    expect(lines.some(l => l.includes('раннее событие'))).toBe(true)

    await new Promise<void>(resolve => setImmediate(resolve))
    const gone = await jsonRequest(port, 'GET', '/tasks/run-fake-1/events')
    expect(gone.status).toBe(200)
    expect(gone.body).toContain('event: gone')
    expect(gone.body).not.toContain('раннее событие')

    const timeline = await jsonRequest(port, 'GET', '/tasks/run-fake-1/timeline')
    expect(JSON.parse(timeline.body).events[0].kind).toBe('user_msg')
  })

  it('SSE subscriber cap rejects overflow and releases the slot after disconnect', async () => {
    const { port, finish } = await boot(undefined, { maxSseSubscribersPerRun: 1 })
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })

    const first = await openSse(port, '/tasks/run-fake-1/events')
    expect(first.status).toBe(200)

    const overflow = await openSse(port, '/tasks/run-fake-1/events')
    expect(overflow.status).toBe(429)
    expect(overflow.headers['retry-after']).toBeDefined()
    await overflow.closed
    expect(JSON.parse(overflow.chunks.join('')).error).toMatch(/SSE_SUBSCRIBERS/)

    first.req.destroy()
    await first.closed
    await new Promise(resolve => setTimeout(resolve, 25))

    const replacement = await openSse(port, '/tasks/run-fake-1/events')
    expect(replacement.status).toBe(200)
    finish()
    await replacement.closed
  })

  it('single-host SSE caps cannot be split with spoofed tenant headers', async () => {
    const { port, finish } = await boot(undefined, {
      maxSseSubscribersPerRun: 2,
      maxSseSubscribersPerTenant: 1
    })
    await jsonRequest(
      port,
      'POST',
      '/tasks',
      { prompt: 'x', providerId: 'deepseek', workspace: '/w' },
      { 'x-verstak-tenant': 'spoof-a' }
    )

    const first = await openSse(port, '/tasks/run-fake-1/events', { 'x-verstak-tenant': 'spoof-a' })
    const overflow = await openSse(port, '/tasks/run-fake-1/events', { 'x-verstak-tenant': 'spoof-b' })
    expect(overflow.status).toBe(429)
    await overflow.closed
    expect(JSON.parse(overflow.chunks.join('')).error).toMatch(/SSE_SUBSCRIBERS_TENANT/)

    first.req.destroy()
    await first.closed
    finish()
  })

  it('SSE client over the pending-byte budget is dropped on broadcast and frees its slot', async () => {
    const { port, emit, finish } = await boot(undefined, {
      maxSseSubscribersPerRun: 1,
      maxSsePendingBytes: 1024
    })
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })

    const slow = await openSse(port, '/tasks/run-fake-1/events')
    emit({ type: 'text', text: 'x'.repeat(2048) })
    await slow.closed

    // Первое событие осознанно пропускаем: проверяем освобождение слота,
    // а не повторную доставку кадра, который и превысил защитную границу.
    const replacement = await openSse(port, '/tasks/run-fake-1/events', { 'last-event-id': '1' })
    expect(replacement.status).toBe(200)
    finish()
    await replacement.closed
  })

  it('SSE replay is byte-bounded: an evicted gap returns gone, while its exact boundary replays safely', async () => {
    const { port, emit, finish } = await boot(undefined, {
      maxSseReplayBytes: 1024,
      maxSsePendingBytes: 8 * 1024
    })
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    emit({ type: 'text', text: `first-${'a'.repeat(650)}` })
    emit({ type: 'text', text: `second-${'b'.repeat(650)}` })

    const unsafe = await openSse(port, '/tasks/run-fake-1/events')
    expect(unsafe.status).toBe(200)
    await unsafe.closed
    expect(unsafe.chunks.join('')).toContain('event: gone')
    expect(unsafe.chunks.join('')).not.toContain('second-')

    const boundary = await openSse(port, '/tasks/run-fake-1/events', { 'last-event-id': '1' })
    finish()
    await boundary.closed
    expect(boundary.lines.some(line => line.includes('second-'))).toBe(true)
  })

  it('an event larger than the replay budget is live-only and forces durable fallback on reconnect', async () => {
    const { port, emit, finish } = await boot(undefined, {
      maxSseReplayBytes: 1024,
      maxSsePendingBytes: 8 * 1024
    })
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })

    const live = await openSse(port, '/tasks/run-fake-1/events')
    emit({ type: 'text', text: `live-only-${'x'.repeat(2048)}` })
    await vi.waitFor(() => expect(live.lines.some(line => line.includes('live-only-'))).toBe(true))
    live.req.destroy()
    await live.closed

    const reconnect = await openSse(port, '/tasks/run-fake-1/events')
    await reconnect.closed
    expect(reconnect.chunks.join('')).toContain('event: gone')
    expect(reconnect.chunks.join('')).not.toContain('live-only-')
    finish()
  })

  it('SSE replay keeps the 500-event cap even when tiny events fit the byte budget', async () => {
    const { port, emit, finish } = await boot(undefined, {
      maxSseReplayBytes: 1024 * 1024
    })
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    for (let n = 0; n < 501; n += 1) emit({ type: 'tick', n })

    const missingFirst = await openSse(port, '/tasks/run-fake-1/events')
    await missingFirst.closed
    expect(missingFirst.chunks.join('')).toContain('event: gone')

    const exactBoundary = await openSse(port, '/tasks/run-fake-1/events', { 'last-event-id': '1' })
    finish()
    await exactBoundary.closed
    expect(exactBoundary.lines).toHaveLength(500)
    expect(JSON.parse(exactBoundary.lines[0])).toEqual({ type: 'tick', n: 1 })
  })

  it('SSE tenant cap spans runs and releases its counter after disconnect', async () => {
    const { tenantA, port } = await bootTenants({
      maxSseSubscribersPerRun: 2,
      maxSseSubscribersPerTenant: 1,
      maxSseSubscribersGlobal: 4
    })
    const headers = { 'x-verstak-tenant': 'tenant-a' }
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'a', providerId: 'deepseek' }, headers)

    const first = await openSse(port, '/tasks/run-tenant-a/events', headers)
    const overflow = await openSse(port, '/tasks/run-tenant-a/events', headers)
    expect(overflow.status).toBe(429)
    expect(overflow.headers['retry-after']).toBe('1')
    await overflow.closed
    expect(JSON.parse(overflow.chunks.join('')).error).toMatch(/SSE_SUBSCRIBERS_TENANT/)

    first.req.destroy()
    await first.closed
    const replacement = await openSseAfterDisconnect(port, '/tasks/run-tenant-a/events', headers)
    expect(replacement.status).toBe(200)
    tenantA.finish()
    await replacement.closed
  })

  it('SSE global cap spans tenants and releases its counter after disconnect', async () => {
    const { tenantA, tenantB, port } = await bootTenants({
      maxSseSubscribersPerRun: 2,
      maxSseSubscribersPerTenant: 2,
      maxSseSubscribersGlobal: 1
    })
    const headersA = { 'x-verstak-tenant': 'tenant-a' }
    const headersB = { 'x-verstak-tenant': 'tenant-b' }
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'a', providerId: 'deepseek' }, headersA)
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'b', providerId: 'deepseek' }, headersB)

    const first = await openSse(port, '/tasks/run-tenant-a/events', headersA)
    const overflow = await openSse(port, '/tasks/run-tenant-b/events', headersB)
    expect(overflow.status).toBe(429)
    expect(overflow.headers['retry-after']).toBe('1')
    await overflow.closed
    expect(JSON.parse(overflow.chunks.join('')).error).toMatch(/SSE_SUBSCRIBERS_GLOBAL/)

    first.req.destroy()
    await first.closed
    const replacement = await openSseAfterDisconnect(port, '/tasks/run-tenant-b/events', headersB)
    expect(replacement.status).toBe(200)
    tenantA.finish()
    tenantB.finish()
    await replacement.closed
  })

  it('статус и durable-таймлайн читаются; неизвестный runId → 404', async () => {
    const { port } = await boot()
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    const status = await jsonRequest(port, 'GET', '/tasks/run-fake-1')
    expect(JSON.parse(status.body)).toMatchObject({ runId: 'run-fake-1', status: 'running' })
    const timeline = await jsonRequest(port, 'GET', '/tasks/run-fake-1/timeline')
    expect(JSON.parse(timeline.body).events[0].kind).toBe('user_msg')
    const missing = await jsonRequest(port, 'GET', '/tasks/run-nope')
    expect(missing.status).toBe(404)
  })

  it('repeated HTTP stop is idempotent for the run; after completion stale stop is gone', async () => {
    const { port, stop, finish, startCalls } = await boot()
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    for (let n = 0; n < 20; n += 1) {
      const response = await jsonRequest(port, 'POST', '/tasks/run-fake-1/stop')
      expect(JSON.parse(response.body)).toEqual({ stopped: true })
    }
    expect(stop).toHaveBeenCalledTimes(20)
    expect(startCalls()).toBe(1)

    finish()
    await new Promise<void>(resolve => setImmediate(resolve))
    const after = await jsonRequest(port, 'POST', '/tasks/run-fake-1/stop')
    expect(JSON.parse(after.body)).toEqual({ stopped: false })
    expect(stop).toHaveBeenCalledTimes(20)
    expect(startCalls()).toBe(1)
  })

  it('resolve write: HTTP-ответ резолвит ТОТ ЖЕ pending-реестр, что десктопный ai:resolve-write', async () => {
    const { port } = await boot()
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    let accepted: boolean | null = null
    pendingWrites.set(scopedKey(42, 'call-7'), { sendId: 42, resolve: (a) => { accepted = a } })
    try {
      await jsonRequest(port, 'POST', '/tasks/run-fake-1/resolve', { kind: 'write', callId: 'call-7', accept: true })
      expect(accepted).toBe(true)
      expect(pendingWrites.has(scopedKey(42, 'call-7'))).toBe(false)
    } finally {
      pendingWrites.delete(scopedKey(42, 'call-7'))
    }
  })

  it('контрольный кейс к resolve: чужой callId ничего не резолвит', async () => {
    const { port } = await boot()
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    let touched = false
    pendingWrites.set(scopedKey(42, 'call-real'), { sendId: 42, resolve: () => { touched = true } })
    try {
      await jsonRequest(port, 'POST', '/tasks/run-fake-1/resolve', { kind: 'write', callId: 'call-other', accept: true })
      expect(touched).toBe(false)
      expect(pendingWrites.has(scopedKey(42, 'call-real'))).toBe(true)
    } finally {
      pendingWrites.delete(scopedKey(42, 'call-real'))
    }
  })
})
