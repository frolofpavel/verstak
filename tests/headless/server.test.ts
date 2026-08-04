import { describe, it, expect, vi, afterEach } from 'vitest'
import { request } from 'http'

// HTTP/SSE-транспорт headless-хоста (Этап 1а, блок №3). Хост подменяется фейком
// (интерфейс HeadlessHost) — sqlite и провайдеры серверу не нужны, он транспорт.
// Мок electron кидает — транспорт обязан жить в чистом Node.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createHeadlessServer } = await import('../../electron/headless/server')
const { pendingWrites, scopedKey } = await import('../../electron/ai/runner-shared')
type HeadlessHost = import('../../electron/headless/host').HeadlessHost
type TaggedSender = import('../../electron/ipc/tool-handlers/shared').TaggedSender

function jsonRequest(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
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

function makeFakeHost() {
  let capturedSender: TaggedSender | null = null
  let resolveCompletion: () => void = () => {}
  const stop = vi.fn()
  const host: HeadlessHost = {
    startTask: async (opts) => {
      capturedSender = opts.sender ?? null
      return {
        runId: 'run-fake-1',
        threadId: 7,
        sendId: 42,
        completion: new Promise<void>(r => { resolveCompletion = r }),
        stop
      }
    },
    getSecret: () => null,
    setSecret: () => undefined,
    deleteSecret: () => undefined,
    listRunEvents: (runId) => runId === 'run-fake-1'
      ? [{ kind: 'user_msg', label: null, detail: 'задача', createdAt: 1 }]
      : [],
    getRunStatus: (runId) => (runId === 'run-fake-1' ? 'running' : null),
    listTasks: () => [{
      threadId: 7, runId: 'run-fake-1', prompt: 'задача', workspace: '/w', providerId: 'deepseek',
      model: 'm', status: 'running', createdAt: 1, endedAt: null, lastActivityAt: 1, runCount: 1
    }],
    getThread: (runId) => (runId === 'run-fake-1' ? {
      threadId: 7, title: 'задача', workspace: '/w', createdAt: 1, lastActivityAt: 1,
      messages: [{ id: 1, role: 'user' as const, content: 'задача', createdAt: 1 }],
      runs: [{
        runId: 'run-fake-1', status: 'running', providerId: 'deepseek', model: 'm',
        startedAt: 1, endedAt: null,
        events: [{ kind: 'user_msg', label: null, detail: 'задача', createdAt: 1 }]
      }]
    } : null),
    getRunThreadId: (runId) => (runId === 'run-fake-1' ? 7 : null),
    getRunWorkspace: (runId) => (runId === 'run-fake-1' ? '/w' : null),
    close: async () => undefined
  }
  return {
    host, stop,
    emit: (event: unknown) => capturedSender?.send('ai:event', { id: 42, event }),
    finish: () => resolveCompletion()
  }
}

describe('headless server — HTTP/SSE транспорт (Этап 1а, №3)', () => {
  const servers: Array<{ close: () => Promise<void> }> = []
  afterEach(async () => { for (const s of servers.splice(0)) await s.close() })

  async function boot(authToken?: string) {
    const fake = makeFakeHost()
    const server = createHeadlessServer({ host: fake.host, authToken })
    servers.push(server)
    const port = await server.listen(0)
    return { ...fake, port }
  }

  it('bearer-гейт: без токена 401, с токеном 202 + runId', async () => {
    const { port } = await boot('s3cret')
    const denied = await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    expect(denied.status).toBe(401)
    const ok = await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' }, { authorization: 'Bearer s3cret' })
    expect(ok.status).toBe(202)
    expect(JSON.parse(ok.body).runId).toBe('run-fake-1')
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

  it('поздний подписчик получает догон из кольцевого буфера (Last-Event-ID не нужен)', async () => {
    const { port, emit, finish } = await boot()
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    emit({ type: 'text', text: 'раннее событие' })
    emit({ type: 'done' })
    finish()
    const lines = await readSse(port, '/tasks/run-fake-1/events', 2000)
    expect(lines.some(l => l.includes('раннее событие'))).toBe(true)
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

  it('stop дёргает ручку остановки задачи', async () => {
    const { port, stop } = await boot()
    await jsonRequest(port, 'POST', '/tasks', { prompt: 'x', providerId: 'deepseek', workspace: '/w' })
    await jsonRequest(port, 'POST', '/tasks/run-fake-1/stop')
    expect(stop).toHaveBeenCalledTimes(1)
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
