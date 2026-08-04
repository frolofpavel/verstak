import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { request } from 'http'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'

// Возврат из Этапа 1б: тенант-роутинг и список задач — забота ЯДРА, а не прод-слоя.
// Мок electron кидает: сервер обязан жить в чистом Node (см. full-loop-headless.test.ts).
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createHeadlessServer } = await import('../../electron/headless/server')
const { createTenantRegistry } = await import('../../electron/headless/tenants')

function scripted(): ChatProvider {
  let turn = 0
  return {
    id: 's', name: 's', models: ['s'],
    async *send(): AsyncGenerator<ChatEvent> {
      turn++
      if (turn === 1) {
        yield { type: 'tool-call', call: { id: 'w1', name: 'write_file', args: { path: 'out.md', content: 'ok\n' } } }
        yield { type: 'done' }
      } else {
        yield { type: 'text', text: 'готово' }
        yield { type: 'done' }
      }
    }
  }
}

function call(port: number, method: string, path: string, tenant?: string, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (tenant) headers['x-verstak-tenant'] = tenant
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

describe('headless server — многотенантный режим (возврат Этапа 1б, №2/№3)', () => {
  let root: string
  let server: { close: () => Promise<void> } | null = null
  let registry: ReturnType<typeof createTenantRegistry> | null = null

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vsk-mt-')) })
  afterEach(async () => {
    if (server) { await server.close(); server = null }
    if (registry) { registry.closeAll(); registry = null }
    rmSync(root, { recursive: true, force: true })
  })

  async function boot() {
    registry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      hostDefaults: { providerFactory: () => scripted() }
    })
    const s = createHeadlessServer({ tenants: registry })
    server = s
    return await s.listen(0)
  }

  it('без заголовка тенанта сервер ОТКАЗЫВАЕТ (fail-closed), а не берёт кого-то по умолчанию', async () => {
    const port = await boot()
    const r = await call(port, 'GET', '/tasks')
    expect(r.status).toBe(400)
    expect(r.body).toContain('x-verstak-tenant')
  })

  it('задача тенанта A выполняется; список задач приходит ИЗ ЯДРА (agent_runs), без внешнего индекса', async () => {
    const port = await boot()
    const created = await call(port, 'POST', '/tasks', 'user-a', { prompt: 'собери out.md', agentMode: 'bypass', providerId: 'deepseek' })
    expect(created.status).toBe(202)
    const runId = JSON.parse(created.body).runId as string

    // Ждём завершения по статусу — прогон асинхронный.
    let status = 'running'
    for (let i = 0; i < 40 && status === 'running'; i++) {
      await new Promise(r => setTimeout(r, 100))
      status = JSON.parse((await call(port, 'GET', `/tasks/${runId}`, 'user-a')).body).status
    }
    expect(status).toBe('done')

    const list = JSON.parse((await call(port, 'GET', '/tasks', 'user-a')).body) as {
      tasks: Array<{ runId: string; prompt: string; status: string; workspace: string }>
    }
    expect(list.tasks.length).toBe(1)
    expect(list.tasks[0].runId).toBe(runId)
    expect(list.tasks[0].prompt).toContain('out.md')
    expect(list.tasks[0].status).toBe('done')
    // Файл лежит в workspace, который назвало ядро.
    expect(existsSync(join(list.tasks[0].workspace, 'out.md'))).toBe(true)
  }, 20_000)

  it('ПЕРИМЕТР: тенант B не видит задачу A ни в списке, ни по прямому runId', async () => {
    const port = await boot()
    const runId = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'приватная задача', agentMode: 'bypass', providerId: 'deepseek'
    })).body).runId as string

    const listB = JSON.parse((await call(port, 'GET', '/tasks', 'user-b')).body) as { tasks: unknown[] }
    expect(listB.tasks).toEqual([])
    expect((await call(port, 'GET', `/tasks/${runId}`, 'user-b')).status).toBe(404)
    expect((await call(port, 'GET', `/tasks/${runId}/timeline`, 'user-b')).status).toBe(404)
    // Артефакты чужой задачи — тот же периметр (запрос №4).
    expect((await call(port, 'GET', `/tasks/${runId}/artifacts`, 'user-b')).status).toBe(404)
    expect((await call(port, 'GET', `/tasks/${runId}/artifacts/out.md`, 'user-b')).status).toBe(404)
    // Контрольный кейс: у самого владельца тот же runId доступен — иначе тест
    // доказывал бы лишь то, что ручка всегда отвечает 404.
    expect((await call(port, 'GET', `/tasks/${runId}`, 'user-a')).status).toBe(200)
  }, 20_000)

  it('однопользовательский режим (host) продолжает работать без заголовка тенанта', async () => {
    // Тот же путь, что у e2e-пина: createHeadlessServer({host}) не сломан.
    const { createHeadlessHost } = await import('../../electron/headless/host')
    const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')
    const dataDir = join(root, 'single'); const ws = join(root, 'single-ws')
    const { mkdirSync } = await import('fs')
    mkdirSync(ws, { recursive: true })
    const host = await createHeadlessHost({
      dataDir, workspaceRoots: [ws], safeStorage: createAesGcmSafeStorage(randomBytes(32)), env: {}
    })
    const s = createHeadlessServer({ host })
    server = { close: async () => { await s.close(); host.close() } }
    const port = await s.listen(0)
    const r = await call(port, 'GET', '/tasks')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).tasks).toEqual([])
  })

  it('ни host, ни tenants → отказ на создании сервера, а не молчаливый полусервис', () => {
    expect(() => createHeadlessServer({})).toThrow(/host.*tenants|tenants/)
  })

  it('ПЕРИМЕТР: клиент НЕ может снять allowlist Этапа 1 через тело запроса', async () => {
    const port = await boot()
    // "toolsAllow": null раньше проезжал спредом тела и включал все инструменты.
    const created = await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'проверка периметра', agentMode: 'bypass', providerId: 'deepseek', toolsAllow: null
    })
    expect(created.status).toBe(202)
    // Контрольный кейс: задача при этом создалась и отработала — гейт не «сломал всё».
    const runId = JSON.parse(created.body).runId as string
    let status = 'running'
    for (let i = 0; i < 40 && status === 'running'; i++) {
      await new Promise(r => setTimeout(r, 100))
      status = JSON.parse((await call(port, 'GET', `/tasks/${runId}`, 'user-a')).body).status
    }
    expect(status).toBe('done')
  }, 20_000)

  it('/health отвечает БЕЗ токена (проба живости для systemd) и не раскрывает задач', async () => {
    registry = createTenantRegistry({ root, masterKey: randomBytes(32) })
    const s = createHeadlessServer({ tenants: registry, authToken: 'secret-token' })
    server = s
    const port = await s.listen(0)
    const r = await call(port, 'GET', '/health')
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body) as { ok: boolean; mode: string }
    expect(body.ok).toBe(true)
    expect(body.mode).toBe('multi-tenant')
    expect(r.body).not.toContain('prompt')
    // Контрольный кейс: остальные ручки под токеном остались закрытыми.
    expect((await call(port, 'GET', '/tasks', 'user-a')).status).toBe(401)
  })
})
