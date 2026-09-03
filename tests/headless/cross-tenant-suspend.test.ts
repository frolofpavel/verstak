import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { request } from 'http'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'

vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { suspendedSends } = await import('../../electron/ai/runner-shared')
const { createHeadlessServer } = await import('../../electron/headless/server')
const { createTenantRegistry } = await import('../../electron/headless/tenants')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(onResolve => { resolve = onResolve })
  return { promise, resolve }
}

function call(port: number, method: string, path: string, tenant: string, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: { 'content-type': 'application/json', 'x-verstak-tenant': tenant },
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

async function waitStatus(port: number, tenant: string, runId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await call(port, 'GET', `/tasks/${runId}`, tenant)
    const status = (JSON.parse(response.body) as { status: string }).status
    if (status !== 'running') return status
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`run ${runId} did not finish`)
}

describe('headless cross-tenant suspend isolation', () => {
  let root: string
  let server: ReturnType<typeof createHeadlessServer> | null = null
  let registry: ReturnType<typeof createTenantRegistry> | null = null

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vsk-suspend-isolation-'))
    suspendedSends.clear()
  })

  afterEach(async () => {
    if (server) await server.close()
    if (registry) await registry.closeAll()
    suspendedSends.clear()
    rmSync(root, { recursive: true, force: true })
  })

  it('different tenant-hosts receive different process-wide sendIds', async () => {
    const completedProvider = (): ChatProvider => ({
      id: 'completed',
      name: 'completed',
      models: ['test'],
      async *send(): AsyncGenerator<ChatEvent> {
        yield { type: 'text', text: 'done' }
        yield { type: 'done' }
      },
    })
    registry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      hostDefaults: { schedulerPollMs: null, providerFactory: completedProvider },
    })
    const tenantA = await registry.get('direct-a')
    const tenantB = await registry.get('direct-b')
    try {
      const runA = await tenantA.host.startTask({
        prompt: 'A', providerId: 'deepseek', agentMode: 'bypass',
      })
      const runB = await tenantB.host.startTask({
        prompt: 'B', providerId: 'deepseek', agentMode: 'bypass',
      })
      expect(runA.sendId).not.toBe(runB.sendId)
      await Promise.all([runA.completion, runB.completion])
    } finally {
      tenantA.release()
      tenantB.release()
    }
  })

  it('suspending tenant A cannot suspend tenant B and leaves no global marker', async () => {
    const startedA = deferred()
    const startedB = deferred()
    const releaseB = deferred()
    let providerNumber = 0

    registry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      hostDefaults: {
        schedulerPollMs: null,
        providerFactory: (_providerId, _model, signal): ChatProvider => {
          const number = ++providerNumber
          return {
            id: `provider-${number}`,
            name: `provider-${number}`,
            models: ['test'],
            async *send(): AsyncGenerator<ChatEvent> {
              if (number === 1) {
                startedA.resolve()
                await new Promise<void>((_resolve, reject) => {
                  if (signal.aborted) reject(signal.reason)
                  else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                })
                return
              }
              startedB.resolve()
              await releaseB.promise
              yield { type: 'text', text: 'tenant B completed normally' }
              yield { type: 'done' }
            },
          }
        },
      },
    })
    server = createHeadlessServer({ tenants: registry })
    const port = await server.listen(0)

    const createdA = await call(port, 'POST', '/tasks', 'tenant-a', {
      prompt: 'suspend me', providerId: 'deepseek', agentMode: 'bypass',
    })
    const createdB = await call(port, 'POST', '/tasks', 'tenant-b', {
      prompt: 'finish normally', providerId: 'deepseek', agentMode: 'bypass',
    })
    const runA = (JSON.parse(createdA.body) as { runId: string }).runId
    const runB = (JSON.parse(createdB.body) as { runId: string }).runId
    await Promise.all([startedA.promise, startedB.promise])

    const suspend = await call(port, 'POST', `/tasks/${runA}/suspend`, 'tenant-a')
    expect(suspend.status).toBe(200)
    expect(JSON.parse(suspend.body)).toEqual({ suspended: true })
    expect(await waitStatus(port, 'tenant-a', runA)).toBe('suspended')

    releaseB.resolve()
    expect(await waitStatus(port, 'tenant-b', runB)).toBe('done')
    expect(suspendedSends.size, 'headless suspend marker must be consumed').toBe(0)
  }, 20_000)
})
