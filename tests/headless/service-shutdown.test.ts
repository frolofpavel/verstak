import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { request, type IncomingMessage } from 'http'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'

// Остановка СЕРВИСА целиком (bin.ts), а не одного хоста. Соседний пин
// host-close-graceful закрепляет, что host.close() дожидается прогонов; здесь —
// что до этого ожидания вообще доходит очередь.
//
// Дефект: `httpServer.close()` перестаёт слушать сразу, но его промис ждёт закрытия
// последнего соединения. Idle-соединения Node закрывает сам, а вот НЕЗАВЕРШЁННЫЙ
// ответ — нет: SSE-подписчик /tasks/{runId}/events живёт столько же, сколько задача.
// Во время деплоя это норма — кабинет смотрит свои задачи. Ждать дренаж ПЕРЕД
// закрытием хостов означало бы, что graceful-остановка не начинается никогда: процесс
// висит до SIGKILL от systemd, прогоны рвутся на полуслове ровно так, как если бы
// фикса не было. Фолбэк, который не может сработать, снаружи неотличим от рабочего.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

// Импорт bin.ts запускает main() сам, если не запретить.
process.env.VERSTAK_HEADLESS_NO_AUTOSTART = '1'
const { shutdownService } = await import('../../electron/headless/bin')
const { createHeadlessHost } = await import('../../electron/headless/host')
const { createHeadlessServer } = await import('../../electron/headless/server')
const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')

/** Провайдер, замерший до открытия ворот: держит прогон (а с ним и SSE) живым. */
function gatedProvider(gate: Promise<void>, entered: () => void, signal?: AbortSignal): ChatProvider {
  return {
    id: 'gated', name: 'gated', models: ['gated'],
    async *send(): AsyncGenerator<ChatEvent> {
      entered()
      await Promise.race([
        gate,
        new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      ])
      if (signal?.aborted) return
      yield { type: 'text', text: 'досчитал' }
      yield { type: 'done' }
    }
  }
}

function post(port: number, path: string, body: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json' } }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })
}

/** Подписывается на SSE и НЕ закрывает соединение: ответ остаётся незавершённым. */
function subscribe(port: number, runId: string) {
  return new Promise<{ res: IncomingMessage; closed: Promise<void> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path: `/tasks/${runId}/events` }, res => {
      // Слушаем СОКЕТ, а не только res: при разрыве со стороны сервера 'close' на
      // IncomingMessage приходит не во всех случаях, и пин виснул бы на исправном коде.
      const closed = new Promise<void>(done => { res.socket?.once('close', () => done()) })
      res.resume()
      resolve({ res, closed })
    })
    req.on('error', reject)
    req.end()
  })
}

function after(ms: number): Promise<'timeout'> {
  return new Promise(resolve => setTimeout(() => resolve('timeout'), ms))
}

describe('остановка headless-сервиса не виснет на живом SSE-стриме', () => {
  let root: string
  let open: () => void = () => {}

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vsk-shutdown-')) })
  afterEach(() => {
    open()
    rmSync(root, { recursive: true, force: true })
  })

  /** Сервис в продовой форме: настоящий хост + настоящий createHeadlessServer. */
  async function boot() {
    const dataDir = join(root, 'data')
    const workspaceRoot = join(root, 'ws')
    mkdirSync(workspaceRoot, { recursive: true })
    const gate = new Promise<void>(r => { open = r })
    let entered: () => void = () => {}
    const inProvider = new Promise<void>(r => { entered = r })
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      providerFactory: (_id, _model, signal) => gatedProvider(gate, () => entered(), signal)
    })
    const server = createHeadlessServer({ host })
    const port = await server.listen(0)
    return { host, server, port, inProvider }
  }

  /** Живой прогон + подписчик на его стрим. */
  async function bootWithLiveStream() {
    const b = await boot()
    const created = await post(b.port, '/tasks', { prompt: 'считай долго', agentMode: 'bypass', providerId: 'deepseek' })
    expect(created.status).toBe(202)
    const runId = JSON.parse(created.body).runId as string
    await b.inProvider // прогон ЗАВЕДОМО в работе — не гадаем по таймеру
    const stream = await subscribe(b.port, runId)
    return { ...b, runId, stream }
  }

  it('shutdownService() завершается, пока подписчик ДЕРЖИТ незакрытый SSE-стрим', async () => {
    const { host, server, stream } = await bootWithLiveStream()
    // Стрим действительно жив в момент остановки. Без этой проверки пин «завершилось
    // быстро» был бы зелен и тогда, когда держать было нечего.
    expect(stream.res.destroyed).toBe(false)

    const started = Date.now()
    await shutdownService(server, () => host.close({ timeoutMs: 1_000 }))
    expect(Date.now() - started).toBeLessThan(8_000)

    // Соединение закрыл сам сервис, а не тест.
    await stream.closed
  }, 20_000)

  it('КОНТРОЛЬНЫЙ КЕЙС: живой стрим РЕАЛЬНО держит дренаж — иначе первый пин ничего не стережёт', async () => {
    const { host, server, stream } = await bootWithLiveStream()

    // Голый server.close() — тот самый шаг, которого раньше ждали первым. Он обязан
    // НЕ успеть, пока ответ не завершён.
    const raced = await Promise.race([server.close().then(() => 'drained' as const), after(1_000)])
    expect(raced).toBe('timeout')

    // …и он же завершается, как только соединение уходит: дренаж не сломан вообще,
    // он именно ЖДЁТ. Иначе «не успел» означало бы просто нерабочий close().
    stream.res.destroy()
    await Promise.race([server.close(), after(5_000)])
    await host.close({ timeoutMs: 1_000 })
  }, 20_000)
})
