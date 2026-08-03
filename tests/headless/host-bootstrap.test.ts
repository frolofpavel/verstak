import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'

// Bootstrap headless-хоста (Этап 1а, блок №2 постановки). Мок electron кидает —
// хост обязан подниматься в среде, где electron недоступен совсем (см. комментарий
// в tests/headless/full-loop-headless.test.ts о контрольном кейсе).
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createHeadlessHost } = await import('../../electron/headless/host')
const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')
const { openDb } = await import('../../electron/storage/db')

function scriptedProvider(): ChatProvider {
  let turn = 0
  return {
    id: 'scripted', name: 'scripted', models: ['scripted'],
    async *send(): AsyncGenerator<ChatEvent> {
      turn++
      if (turn === 1) {
        yield { type: 'tool-call', call: { id: 'w1', name: 'write_file', args: { path: 'out.md', content: 'host bootstrap ok\n' } } }
        yield { type: 'done' }
      } else {
        yield { type: 'text', text: 'готово' }
        yield { type: 'done' }
      }
    }
  }
}

describe('headless host bootstrap (Этап 1а, №2)', () => {
  let dataDir: string
  let wsRoot: string
  let hosts: Array<{ close: () => void }>

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vsk-host-data-'))
    wsRoot = mkdtempSync(join(tmpdir(), 'vsk-host-ws-'))
    hosts = []
  })
  afterEach(() => {
    for (const h of hosts) h.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(wsRoot, { recursive: true, force: true })
  })

  async function makeHost(extra: Partial<Parameters<typeof createHeadlessHost>[0]> = {}) {
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [wsRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      ...extra
    })
    hosts.push(host)
    return host
  }

  it('секреты: roundtrip через AES-хранилище; в БД лежит шифртекст, не плейнтекст', async () => {
    const host = await makeHost()
    host.setSecret('deepseek_api_key', 'sk-super-secret-000111222333')
    expect(host.getSecret('deepseek_api_key')).toBe('sk-super-secret-000111222333')
    const raw = openDb(join(dataDir, 'verstak.db'))
    try {
      const row = raw.prepare('SELECT value FROM settings WHERE key = ?').get('deepseek_api_key') as { value: string }
      expect(row.value).not.toContain('sk-super-secret')
      expect(Buffer.from(row.value, 'base64').includes(Buffer.from('sk-super-secret'))).toBe(false)
    } finally { raw.close() }
  })

  it('env-фолбэк: ключа нет в хранилище → берётся из env по правилу UPPER_CASE', async () => {
    const host = await makeHost({ env: { DEEPSEEK_API_KEY: 'from-env-fallback' } })
    expect(host.getSecret('deepseek_api_key')).toBe('from-env-fallback')
    // Хранилище побеждает env.
    host.setSecret('deepseek_api_key', 'from-storage')
    expect(host.getSecret('deepseek_api_key')).toBe('from-storage')
  })

  it('startTask: полный цикл через хост — файл в workspace, done в agent_runs, таймлайн читается', async () => {
    const host = await makeHost()
    const workspace = join(wsRoot, 'task-1')
    mkdirSync(workspace, { recursive: true })
    const task = await host.startTask({
      workspace,
      prompt: 'создай out.md',
      providerId: 'deepseek',
      agentMode: 'bypass',
      providerOverride: scriptedProvider()
    })
    await task.completion
    expect(existsSync(join(workspace, 'out.md'))).toBe(true)
    expect(readFileSync(join(workspace, 'out.md'), 'utf8')).toContain('host bootstrap ok')
    expect(host.getRunStatus(task.runId)).toBe('done')
    const events = host.listRunEvents(task.runId)
    expect(events.length).toBeGreaterThan(1)
    expect(events[0].kind).toBe('user_msg')
  })

  it('контрольный кейс allowlist: run_command НЕ исполняется на хосте Этапа 1', async () => {
    const host = await makeHost()
    const workspace = join(wsRoot, 'task-denied')
    mkdirSync(workspace, { recursive: true })
    const marker = join(workspace, 'shell-ran.txt')
    let turn = 0
    const provider: import('../../electron/ai/types').ChatProvider = {
      id: 'p-deny', name: 'p-deny', models: ['p-deny'],
      async *send(): AsyncGenerator<ChatEvent> {
        turn++
        if (turn === 1) {
          yield { type: 'tool-call', call: { id: 'c1', name: 'run_command', args: { command: `echo ran > "${marker}"` } } }
          yield { type: 'done' }
        } else {
          yield { type: 'text', text: 'финал' }
          yield { type: 'done' }
        }
      }
    }
    const task = await host.startTask({
      workspace, prompt: 'попробуй shell', providerId: 'deepseek',
      agentMode: 'bypass', providerOverride: provider
    })
    await task.completion
    // Команда не исполнилась (allowlist Этапа 1), прогон при этом завершился штатно.
    expect(existsSync(marker)).toBe(false)
    expect(host.getRunStatus(task.runId)).not.toBe('running')
  })

  it('workspace вне разрешённых корней → отказ до старта прогона', async () => {
    const host = await makeHost()
    const outside = mkdtempSync(join(tmpdir(), 'vsk-host-outside-'))
    try {
      await expect(host.startTask({
        workspace: outside,
        prompt: 'x',
        providerId: 'deepseek',
        providerOverride: scriptedProvider()
      })).rejects.toThrow(/вне разрешённых корней/)
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })

  it('CLI-провайдер без override → отказ (Этап 1 — только API-транспорт)', async () => {
    const host = await makeHost()
    const workspace = join(wsRoot, 'task-cli')
    mkdirSync(workspace, { recursive: true })
    await expect(host.startTask({
      workspace,
      prompt: 'x',
      providerId: 'claude-cli'
    })).rejects.toThrow(/только API-провайдеры/)
  })

  it('таймлайн переживает рестарт: второй хост над тем же dataDir читает события первого', async () => {
    const host = await makeHost()
    const workspace = join(wsRoot, 'task-restart')
    mkdirSync(workspace, { recursive: true })
    const task = await host.startTask({
      workspace, prompt: 'restart smoke', providerId: 'deepseek',
      agentMode: 'bypass', providerOverride: scriptedProvider()
    })
    await task.completion
    host.close()
    const reopened = await makeHost()
    expect(reopened.getRunStatus(task.runId)).toBe('done')
    expect(reopened.listRunEvents(task.runId)[0].kind).toBe('user_msg')
  })
})
