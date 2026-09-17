import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'
import type { SearchExecutionResult } from '../../electron/headless/search-executor'

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
  let hosts: Array<{ close: () => Promise<void> }>

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vsk-host-data-'))
    wsRoot = mkdtempSync(join(tmpdir(), 'vsk-host-ws-'))
    hosts = []
  })
  afterEach(async () => {
    // await: close() ждёт живые прогоны, иначе teardown уносит sqlite из-под них.
    for (const h of hosts) await h.close()
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

  it('web_search детерминированно идёт через Search Executor, затем синтез без legacy tools', async () => {
    let providerCalls = 0
    let synthesisMessages: import('../../electron/ai/types').ChatMessage[] = []
    let synthesisTools: import('../../electron/ai/types').ToolDefinition[] = []
    const provider: ChatProvider = {
      id: 'synthesis', name: 'synthesis', models: ['synthesis'],
      async *send(messages, tools): AsyncGenerator<ChatEvent> {
        providerCalls++
        synthesisMessages = messages
        synthesisTools = tools
        yield { type: 'text', text: 'Ответ по evidence [1]' }
        yield { type: 'done' }
      }
    }
    const search: SearchExecutionResult = {
      status: 'success', originalQuery: 'актуальный факт', rewrittenQuery: null,
      queriesAttempted: ['актуальный факт'], backends: ['test'], candidateCount: 1,
      fetchAttempted: 1, fetchSuccess: 1, fetchRejected: 0, usableEvidenceCount: 1,
      evidence: [{
        url: 'https://official.example/fact', title: 'Официальный факт', snippet: '',
        backend: 'test', rank: 1, language: 'ru', publishedAt: null,
        contentType: 'text/html', text: 'Проверенный текст источника '.repeat(20), truncated: false,
      }],
      fetches: [{
        url: 'https://official.example/fact', finalUrl: 'https://official.example/fact',
        status: 200, bodyChars: 560, usable: true, reason: null, elapsedMs: 5,
      }],
      timeoutReason: null, timings: { searchMs: 3, fetchMs: 5, totalMs: 8 },
    }
    const host = await makeHost({ searchExecutor: vi.fn(async (_query, deps) => {
      deps.onStage?.('search'); deps.onStage?.('fetch'); return search
    }) })
    const task = await host.startTask({
      prompt: 'актуальный факт', executionKind: 'web_search', providerId: 'deepseek',
      providerOverride: provider, contextMessages: [{ role: 'system', content: 'Инструкция проекта' }],
    })
    await task.completion

    expect(providerCalls).toBe(1)
    expect(synthesisTools).toEqual([])
    expect(synthesisMessages.some(message => message.content.includes('Проверенный текст источника'))).toBe(true)
    expect(synthesisMessages.some(message => message.content.includes('Инструкция проекта'))).toBe(true)
    const events = host.listRunEvents(task.runId)
    expect(host.getRunStatus(task.runId), JSON.stringify(events)).toBe('done')
    expect(events.some(event => event.label === 'web_search')).toBe(true)
    expect(events.some(event => event.label === 'web_fetch' && event.detail?.includes('200'))).toBe(true)
    expect(events.find(event => event.kind === 'search_execution')?.label).toBe('success')
    expect(host.getThread(task.runId)?.messages.at(-1)?.content).toContain('Ответ по evidence')
  })

  it('0 evidence не вызывает модель и сохраняет controlled failure в разговоре', async () => {
    const provider = scriptedProvider()
    const sendSpy = vi.spyOn(provider, 'send')
    const failed: SearchExecutionResult = {
      status: 'no_evidence', originalQuery: 'закрытый источник', rewrittenQuery: 'закрытый источник официальный источник',
      queriesAttempted: ['закрытый источник'], backends: ['test'], candidateCount: 1,
      fetchAttempted: 1, fetchSuccess: 0, fetchRejected: 1, usableEvidenceCount: 0,
      evidence: [], fetches: [{
        url: 'https://closed.example', finalUrl: 'https://closed.example', status: 403,
        bodyChars: 0, usable: false, reason: 'http_403', elapsedMs: 4,
      }],
      timeoutReason: null, timings: { searchMs: 2, fetchMs: 4, totalMs: 6 },
    }
    const host = await makeHost({ searchExecutor: vi.fn(async () => failed) })
    const task = await host.startTask({
      prompt: 'закрытый источник', executionKind: 'web_search', providerId: 'deepseek',
      providerOverride: provider,
    })
    await task.completion

    expect(sendSpy).not.toHaveBeenCalled()
    expect(host.getThread(task.runId)?.messages.at(-1)?.content).toContain('не удалось надёжно проверить')
    expect(host.listRunEvents(task.runId).find(event => event.kind === 'search_execution')?.label)
      .toBe('no_evidence')
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
    await host.close()
    const reopened = await makeHost()
    expect(reopened.getRunStatus(task.runId)).toBe('done')
    expect(reopened.listRunEvents(task.runId)[0].kind).toBe('user_msg')
  })
})
