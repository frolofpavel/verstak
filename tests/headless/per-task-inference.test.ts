import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server } from 'http'

// Запрос №5 Этапа 1б: маршрут инференса задаётся НА ЗАДАЧУ (короткоживущий токен
// прогона), а не через секреты тенанта. Главное утверждение — токен НИГДЕ не оседает.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createHeadlessHost } = await import('../../electron/headless/host')
const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')

const RUN_TOKEN = 'run-token-ZZZQQQ0123456789-secret'

/** Мини-эндпоинт OpenAI-совместимого шлюза: пишет полученный Authorization. */
function fakeGateway(): Promise<{ url: string; seenAuth: string[]; close: () => Promise<void>; server: Server }> {
  const seenAuth: string[] = []
  const server = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ''))
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Готово.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      }))
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        seenAuth,
        server,
        close: () => new Promise<void>(r => server.close(() => r()))
      })
    })
  })
}

/** Рекурсивно собирает содержимое всех файлов каталога — для грепа секрета. */
function readAllFiles(dir: string, depth = 0): string {
  if (depth > 6) return ''
  let out = ''
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let st: ReturnType<typeof statSync>
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) { out += readAllFiles(full, depth + 1); continue }
    try { out += readFileSync(full, 'latin1') } catch { /* нечитаемый — пропускаем */ }
  }
  return out
}

describe('per-task маршрут инференса (запрос №5)', () => {
  let dataDir: string, wsRoot: string
  let gw: Awaited<ReturnType<typeof fakeGateway>> | null = null
  const hosts: Array<{ close: () => Promise<void> }> = []

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vsk-inf-data-'))
    wsRoot = mkdtempSync(join(tmpdir(), 'vsk-inf-ws-'))
  })
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.close()
    if (gw) { await gw.close(); gw = null }
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(wsRoot, { recursive: true, force: true })
  })

  async function makeHost() {
    const host = await createHeadlessHost({
      dataDir, workspaceRoots: [wsRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)), env: {}
    })
    hosts.push(host)
    return host
  }

  it('прогон идёт через переданный маршрут: токен уходит В ЗАПРОСЕ и нигде не сохраняется', async () => {
    gw = await fakeGateway()
    const host = await makeHost()
    const workspace = join(wsRoot, 'task-inf')
    mkdirSync(workspace, { recursive: true })

    const task = await host.startTask({
      workspace, prompt: 'скажи готово', providerId: 'custom-openai',
      model: 'test-model', agentMode: 'bypass',
      inference: { baseUrl: gw.url, apiKey: RUN_TOKEN }
    })
    await task.completion

    // 1. Маршрут реально использован — шлюз увидел токен прогона.
    expect(gw.seenAuth.some(a => a.includes(RUN_TOKEN))).toBe(true)

    // 2. И при этом токен НЕ осел: ни в секретах тенанта…
    expect(host.getSecret('custom_openai_api_key')).toBeNull()
    expect(host.getSecret('custom_openai_baseurl')).toBeNull()
    // …ни в одном файле хранилища (sqlite + логи + workspace).
    await host.close()
    const stored = readAllFiles(dataDir) + readAllFiles(wsRoot)
    expect(stored).not.toContain(RUN_TOKEN)

    // 3. Контрольный кейс: греп вообще способен что-то найти в этих файлах — иначе
    // пункт 2 был бы зелёным просто потому, что читать нечего. Маркер ASCII: файлы
    // читаются побайтно (latin1), и кириллица в UTF-8 так не сматчится, а токен —
    // ASCII, то есть нашёлся бы, если бы где-то лежал.
    expect(stored).toContain('custom-openai')
    expect(stored).toContain('test-model')
  }, 30_000)

  it('без блока inference поведение прежнее: маршрут берётся из секретов тенанта', async () => {
    gw = await fakeGateway()
    const host = await makeHost()
    host.setSecret('custom_openai_baseurl', gw.url)
    host.setSecret('custom_openai_api_key', 'tenant-stored-key')
    const workspace = join(wsRoot, 'task-legacy')
    mkdirSync(workspace, { recursive: true })

    const task = await host.startTask({
      workspace, prompt: 'скажи готово', providerId: 'custom-openai',
      model: 'test-model', agentMode: 'bypass'
    })
    await task.completion
    expect(gw.seenAuth.some(a => a.includes('tenant-stored-key'))).toBe(true)
    expect(gw.seenAuth.some(a => a.includes(RUN_TOKEN))).toBe(false)
  }, 30_000)

  it('таймлайн задачи не содержит токен (durable-хранилище чисто)', async () => {
    gw = await fakeGateway()
    const host = await makeHost()
    const workspace = join(wsRoot, 'task-tl')
    mkdirSync(workspace, { recursive: true })
    const task = await host.startTask({
      workspace, prompt: 'скажи готово', providerId: 'custom-openai',
      model: 'test-model', agentMode: 'bypass',
      inference: { baseUrl: gw.url, apiKey: RUN_TOKEN }
    })
    await task.completion
    const events = JSON.stringify(host.listRunEvents(task.runId))
    expect(events).not.toContain(RUN_TOKEN)
    const runs = JSON.stringify(host.listTasks())
    expect(runs).not.toContain(RUN_TOKEN)
    expect(runs).toContain(task.runId) // контроль: данные о прогоне вообще есть
  }, 30_000)
})
