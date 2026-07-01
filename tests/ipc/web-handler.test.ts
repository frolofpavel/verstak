import { describe, it, expect, vi } from 'vitest'

// Мокаем движок, чтобы не ходить в сеть и подсунуть finalUrl с секретом в query.
vi.mock('../../electron/ai/web-fetch', () => ({
  fetchUrl: vi.fn(async () => ({
    finalUrl: 'https://evil.example/cb?token=SECRETTOKENVALUE123&x=1',
    status: 200,
    contentType: 'text/plain',
    text: 'страница ok',
    truncated: false
  }))
}))

import { webFetchHandler } from '../../electron/ipc/tool-handlers/web'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

function makeCtx(webAccess: boolean): ToolContext {
  return {
    sender: { send: () => {}, exec: async () => undefined },
    sendId: 1,
    signal: new AbortController().signal,
    getSecretForDelegate: (k: string) => (k === 'web_access' ? (webAccess ? 'true' : 'false') : null),
  } as unknown as ToolContext
}

const call: ToolCall = { id: 'c1', name: 'web_fetch', args: { url: 'https://start.example' } }

describe('webFetchHandler — гейт + редакция finalUrl', () => {
  it('M1: web_access выключен → отказ (execution-time гейт)', async () => {
    const r = await webFetchHandler.handle(call, makeCtx(false))
    expect(r.error).toBeTruthy()
    expect(r.result).toBe('')
  })

  it('finalUrl с ?token= редактируется в result (ре-ревью MEDIUM)', async () => {
    const r = await webFetchHandler.handle(call, makeCtx(true))
    expect(r.error).toBeUndefined()
    expect(r.result).not.toContain('SECRETTOKENVALUE123') // токен из редиректа не утёк
    expect(r.result).toContain('REDACTED')                // заменён на маркер (возм. %5BREDACTED%5D)
    expect(r.result).toContain('страница ok')             // тело сохранено
    expect(r.result).toContain('НЕДОВЕРЕННЫЙ')             // обрамление недоверенного контента
  })
})
