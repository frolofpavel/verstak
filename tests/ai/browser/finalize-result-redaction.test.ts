import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserController, DispatchResult } from '../../../electron/ai/browser/controller'
import type { Observation } from '../../../electron/ai/browser/types'
import type { ToolCall } from '../../../electron/ai/types'
import { browserHandler, configureBrowserHandler } from '../../../electron/ipc/tool-handlers/browser'
import type { ToolContext } from '../../../electron/ipc/tool-handlers/shared'

function observation(over: Partial<Observation> = {}): Observation {
  return {
    observationId: 'obs-result-redaction',
    observationVersion: 1,
    browserTaskId: 'bt-result-redaction',
    runId: 'run-result-redaction',
    capturedAt: Date.now(),
    source: {
      kind: 'chrome-extension',
      url: 'https://app.example/report?page=2',
      title: 'Продажи за сентябрь',
      origin: 'https://app.example',
    },
    tenant: 'Мой кабинет',
    account: 'Маркетинг',
    text: 'Видимый текст',
    tables: [],
    omissions: [],
    truncated: { text: false, selection: false, tables: false },
    ...over,
  }
}

function context(): ToolContext {
  return {
    sender: { send: vi.fn(), exec: vi.fn(async () => null) },
    sendId: 42,
    signal: new AbortController().signal,
    projectPath: '/project',
    tools: {},
    recordWrite: vi.fn(),
    recordPlan: vi.fn(() => ({ id: 1 })),
    recordJournal: vi.fn(),
    readJournal: vi.fn(() => []),
    saveMemory: vi.fn(() => ({ id: 'memory-1' })),
    saveDecision: vi.fn(() => ({})),
    searchMemories: vi.fn(() => []),
    searchConversations: vi.fn(() => []),
    connectors: { list: vi.fn(() => []), query: vi.fn(async () => null) },
    pendingAttachments: [],
    pendingWrites: new Map(),
    pendingCommands: new Map(),
    scopedKey: (sendId: number, callId: string) => `${sendId}::${callId}`,
    agentMode: 'accept-edits',
    runId: 'run-result-redaction',
    parentChatId: 1,
  } as unknown as ToolContext
}

async function invoke(result: DispatchResult) {
  const controller = {
    dispatch: vi.fn(async () => result),
  } as unknown as BrowserController
  configureBrowserHandler({
    controller,
    resolveTaskId: () => 'bt-result-redaction',
  })
  const call: ToolCall = { id: 'call-result-redaction', name: 'browser_read_page', args: {} }
  return browserHandler.handle(call, context())
}

afterEach(() => configureBrowserHandler({}))

describe('finalizeBrowserResult — metadata redaction on the model output path', () => {
  it('redacts OAuth query/fragment/userinfo and fallback metadata', async () => {
    const secrets = {
      finalPassword: 'finalPassword12',
      finalQuery: 'fq12',
      finalFragment: 'ff12',
      sourcePassword: 'sourcePassword12',
      sourceQuery: 'sq12',
      sourceFragment: 'sf12',
      originPassword: 'originPassword12',
      originQuery: 'oq12',
      title: 'sk-titleSecret1234567890abcd',
      tenant: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      account: 'accountBearerSecret12345',
    }
    const finalUrl = `https://final-user:${secrets.finalPassword}@app.example/callback?page=2&access_token=${secrets.finalQuery}#token=${secrets.finalFragment}`
    const postObservation = observation({
      source: {
        kind: 'chrome-extension',
        url: `https://source-user:${secrets.sourcePassword}@app.example/report?page=3&access_token=${secrets.sourceQuery}#token=${secrets.sourceFragment}`,
        title: `Отчёт ${secrets.title}`,
        origin: `https://origin-user:${secrets.originPassword}@app.example/?session_id=${secrets.originQuery}`,
      },
      tenant: `Кабинет ${secrets.tenant}`,
      account: `Authorization: Bearer ${secrets.account}`,
    })
    const out = await invoke({
      ok: true,
      actionId: 'action-result-redaction',
      risk: 'R0',
      decision: { kind: 'auto', reason: 'test' },
      result: {
        actionId: 'action-result-redaction',
        status: 'verified',
        finalUrl,
        postObservation,
        detail: 'readback complete',
        finalizedAt: Date.now(),
      },
    })
    const modelPayload = JSON.stringify(out.result)

    for (const secret of Object.values(secrets)) expect(modelPayload).not.toContain(secret)
    expect(out.result).toMatchObject({
      finalUrl: expect.stringContaining('page=2'),
      url: expect.stringContaining('page=3'),
      title: 'Отчёт [REDACTED:openai-key]',
      tenant: 'Кабинет [REDACTED:github-token]',
      account: 'Authorization: Bearer [REDACTED:auth-value]',
    })
  })

  it('preserves safe finalUrl and fallback metadata', async () => {
    const postObservation = observation()
    const out = await invoke({
      ok: true,
      actionId: 'action-safe-result',
      risk: 'R0',
      decision: { kind: 'auto', reason: 'test' },
      result: {
        actionId: 'action-safe-result',
        status: 'verified',
        finalUrl: 'https://app.example/report?page=2',
        postObservation,
        detail: 'readback complete',
        finalizedAt: Date.now(),
      },
    })

    expect(out.result).toMatchObject({
      finalUrl: 'https://app.example/report?page=2',
      url: 'https://app.example/report?page=2',
      title: 'Продажи за сентябрь',
      origin: 'https://app.example',
      tenant: 'Мой кабинет',
      account: 'Маркетинг',
    })
  })
})
