// Срез 2.1.3-CD: one-shot маршрут с КОНКРЕТНЫМ аккаунтом (promptRoute.accountId).
// Доказываем runtime wiring, а не декоративный UI:
//  1. выбранный аккаунт реально доезжает до createProvider (токен/env именно его);
//  2. неготовый явный выбор (cooling / login-required / удалённый) — ранний стоп с
//     понятной причиной, прогон НЕ стартует (ни run-строки, ни провайдера), и запрос
//     НЕ уходит на другой аккаунт;
//  3. accountId форсит строгость: fallbackOpts не передаётся даже при 'allow';
//  4. run фиксирует запрошенный аккаунт в Timeline (route-событие).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatMessage } from '../../electron/ai/types'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

/** Ловушка аргументов createProvider — сюда доезжают claudeOauthToken/codexHome аккаунта. */
let providerOpts: Record<string, unknown> | null = null
vi.mock('../../electron/ai/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('../../electron/ai/registry')>()
  return {
    ...actual,
    createProvider: (_id: string, opts: Record<string, unknown>) => {
      providerOpts = opts
      return {
        id: 'claude-cli', name: 'claude-cli', models: ['auto'],
        async *send(): AsyncGenerator<ChatEvent> {
          yield { type: 'text', text: 'готово' }
          yield { type: 'done' }
        },
      }
    },
  }
})

/** Шпион над fallbackOpts plain-пути (позиционный arg #10) — вызывает оригинал. */
let plainFallbackOpts: unknown = 'NOT-CALLED'
vi.mock('../../electron/ai/runner-plain', async importOriginal => {
  const actual = await importOriginal<typeof import('../../electron/ai/runner-plain')>()
  return {
    ...actual,
    runPlainConversation: (...args: unknown[]) => {
      plainFallbackOpts = args[10]
      return (actual.runPlainConversation as (...a: unknown[]) => Promise<void>)(...args)
    },
  }
})

const { openDb } = await import('../../electron/storage/db')
const { createSubscriptionAccount, markAccountCooling, getActiveAccount, setActiveAccount } = await import('../../electron/storage/subscription-accounts')
const { createResolveSubscriptionAccount } = await import('../../electron/ai/resolve-subscription-account')
const { registerAiIpc } = await import('../../electron/ipc/ai')

const NOW = 1_800_000_000_000
const messages: ChatMessage[] = [{ role: 'user', content: 'сделай' }]

interface SentPayload { id: number; event: { type: string; message?: string }; chatId?: number | null }

describe('ai:send — one-shot маршрут с аккаунтом (CD)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let secrets: Record<string, string | null>
  let binding: { mode: 'auto' | 'pinned'; accountId: number | null } | null
  let sent: SentPayload[]
  let agentRuns: { create: ReturnType<typeof vi.fn>; appendEvent: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn>; persistUsage: ReturnType<typeof vi.fn>; tick: ReturnType<typeof vi.fn> }

  function makeDeps() {
    return {
      getSecret: (k: string) => secrets[k] ?? null,
      getProviderId: () => 'claude-cli' as const,
      getProviderModel: () => 'auto',
      getKnownRoots: () => [dir],
      recordWrite: () => {},
      recentWrites: () => [],
      getAgentMode: () => 'ask' as const,
      recordPlan: () => ({ id: 1 }),
      recordJournal: () => {},
      readJournal: () => [],
      saveMemory: () => ({ id: 'm' }),
      saveDecision: (r: unknown) => r,
      searchMemories: () => [],
      searchConversations: () => [],
      resolveSubscriptionAccount: createResolveSubscriptionAccount(db, {
        getSecret: (k: string) => secrets[k] ?? null,
        getSubscriptionBinding: () => binding,
        now: () => NOW,
      }),
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0]
  }

  const event = () => ({
    sender: {
      isDestroyed: () => false,
      send: (_ch: string, payload?: SentPayload) => { if (payload) sent.push(payload) },
    },
  })

  async function sendOnce(overrides?: Record<string, unknown>) {
    return handlers.get('ai:send')!(event(), messages, dir, undefined, overrides, '7') as Promise<number>
  }

  function addAccount(label: string, credRef: string) {
    return createSubscriptionAccount(db, { providerId: 'claude-cli', label, credRef })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-oneshot-route-'))
    db = openDb(join(dir, 'test.db'))
    secrets = {}
    binding = null
    sent = []
    providerOpts = null
    plainFallbackOpts = 'NOT-CALLED'
    agentRuns = { create: vi.fn(() => 0), appendEvent: vi.fn(), get: vi.fn(() => null), finish: vi.fn(), persistUsage: vi.fn(), tick: vi.fn() }
    handlers.clear()
    registerAiIpc(makeDeps())
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('C: one-shot strict account B — токен B доезжает до createProvider, run создан с requested route', async () => {
    const a = addAccount('Аккаунт A', 'subacct:a')
    const b = addAccount('Аккаунт B', 'subacct:b')
    secrets['subacct:a'] = 'sk-A'
    secrets['subacct:b'] = 'sk-B'
    void a
    const sendId = await sendOnce({ promptRoute: { providerId: 'claude-cli', model: 'auto', fallbackPolicy: 'strict', accountId: b.id } })
    expect(sendId).toBeGreaterThan(0)
    // Доказательство wiring: провайдер создан с токеном ИМЕННО выбранного аккаунта.
    expect(providerOpts).toBeTruthy()
    expect(providerOpts!.claudeOauthToken).toBe('sk-B')
    // Run сохраняет запрошенный route (requested отдельно от actual).
    expect(agentRuns.create).toHaveBeenCalledTimes(1)
    expect(agentRuns.create.mock.calls[0][0]).toMatchObject({ requestedProviderId: 'claude-cli', requestedModel: 'auto' })
    // Запрошенный аккаунт зафиксирован в Timeline прогона (label, не id).
    const routeEvent = agentRuns.appendEvent.mock.calls.find(c => c[1] === 'route')
    expect(routeEvent).toBeTruthy()
    expect(JSON.stringify(routeEvent![2])).toContain('Аккаунт B')
    expect(JSON.stringify(routeEvent![2])).not.toContain('sk-B')
  })

  it('C-strict: accountId форсит строгость — fallbackOpts НЕ передаётся даже при fallbackPolicy allow', async () => {
    const b = addAccount('Аккаунт B', 'subacct:b')
    secrets['subacct:b'] = 'sk-B'
    const sendId = await sendOnce({ promptRoute: { providerId: 'claude-cli', model: 'auto', fallbackPolicy: 'allow', accountId: b.id } })
    expect(sendId).toBeGreaterThan(0)
    await vi.waitFor(() => { if (plainFallbackOpts === 'NOT-CALLED') throw new Error('runner не вызван') })
    expect(plainFallbackOpts, 'one-shot с аккаунтом обязан быть строгим: ни account-, ни provider-fallback').toBeUndefined()
  })

  it('D: one-shot на ОСТЫВШИЙ аккаунт — стоп с причиной и сроком, прогон не стартовал', async () => {
    const b = addAccount('Остывший B', 'subacct:b')
    secrets['subacct:b'] = 'sk-B'
    markAccountCooling(db, b.id, NOW + 3_600_000, { scope: 'account', reason: 'quota' })
    const sendId = await sendOnce({ promptRoute: { providerId: 'claude-cli', model: 'auto', fallbackPolicy: 'strict', accountId: b.id } })
    expect(sendId).toBe(0)
    expect(providerOpts, 'провайдер не должен создаваться').toBeNull()
    expect(agentRuns.create, 'run-строка не должна создаваться').not.toHaveBeenCalled()
    const err = sent.find(p => p.event.type === 'error')
    expect(err).toBeTruthy()
    expect(err!.event.message).toContain('Остывший B')
    expect(err!.event.message).toContain('остывает')
    // Выход из тупика: подсказка выбрать другой аккаунт или Auto.
    expect(err!.event.message).toMatch(/другой аккаунт|Auto/i)
  })

  it('D: one-shot на аккаунт БЕЗ ВХОДА — стоп «требуется вход», не уходит на активный', async () => {
    const ready = addAccount('Готовый', 'subacct:ready')
    secrets['subacct:ready'] = 'sk-ready'
    const b = addAccount('Без входа', 'subacct:empty')
    secrets['subacct:empty'] = null
    void ready
    const sendId = await sendOnce({ promptRoute: { providerId: 'claude-cli', model: 'auto', fallbackPolicy: 'strict', accountId: b.id } })
    expect(sendId).toBe(0)
    expect(providerOpts).toBeNull()
    const err = sent.find(p => p.event.type === 'error')
    expect(err!.event.message).toContain('Без входа')
    expect(err!.event.message).toMatch(/вход/i)
  })

  it('D: one-shot на УДАЛЁННЫЙ аккаунт — стоп «удалён», прогон не стартовал', async () => {
    const sendId = await sendOnce({ promptRoute: { providerId: 'claude-cli', model: 'auto', fallbackPolicy: 'strict', accountId: 999 } })
    expect(sendId).toBe(0)
    expect(providerOpts).toBeNull()
    const err = sent.find(p => p.event.type === 'error')
    expect(err!.event.message).toMatch(/удал/i)
  })

  it('D: ранняя ошибка несёт chatId — рендерер может доставить её в нужный чат', async () => {
    const sendId = await sendOnce({ promptRoute: { providerId: 'claude-cli', model: 'auto', fallbackPolicy: 'strict', accountId: 999 } })
    expect(sendId).toBe(0)
    const err = sent.find(p => p.event.type === 'error')
    expect(err!.chatId, 'без chatId событие дропается роутером рендерера (owner нет)').toBe(7)
  })

  it('B: pin на остывший аккаунт — ранний стоп с причиной (без гарантированного фейла прогона)', async () => {
    const a = addAccount('Pinned Остывший', 'subacct:a')
    secrets['subacct:a'] = 'sk-A'
    binding = { mode: 'pinned', accountId: a.id }
    markAccountCooling(db, a.id, NOW + 60_000, { scope: 'account', reason: 'rate-limit' })
    const sendId = await sendOnce()
    expect(sendId).toBe(0)
    expect(providerOpts).toBeNull()
    const err = sent.find(p => p.event.type === 'error')
    expect(err!.event.message).toContain('Pinned Остывший')
    expect(err!.event.message).toContain('остывает')
  })

  it('pin на удалённый аккаунт — стоп D2 сохранён', async () => {
    binding = { mode: 'pinned', accountId: 555 }
    const sendId = await sendOnce()
    expect(sendId).toBe(0)
    const err = sent.find(p => p.event.type === 'error')
    expect(err!.event.message).toMatch(/удал/i)
  })

  it('обычная отправка без аккаунтов-подписок — как раньше (legacy токен, sendId > 0)', async () => {
    secrets['claude_code_oauth_token'] = 'sk-legacy'
    const sendId = await sendOnce()
    expect(sendId).toBeGreaterThan(0)
    expect(providerOpts!.claudeOauthToken).toBe('sk-legacy')
  })

  // ─── EF S1/S6: Auto pre-flight — без лишнего сетевого фейла, видимая ротация ───

  it('EF-A: Auto — активный cooling → запрос СРАЗУ через готовый B, ротация видима (без 429 A)', async () => {
    const a = addAccount('Аккаунт A', 'subacct:a')
    const b = addAccount('Аккаунт B', 'subacct:b')
    secrets['subacct:a'] = 'sk-A'
    secrets['subacct:b'] = 'sk-B'
    markAccountCooling(db, a.id, NOW + 3_600_000, { scope: 'account', reason: 'quota' })
    const sendId = await sendOnce()
    expect(sendId).toBeGreaterThan(0)
    // Провайдер создан сразу с токеном B — A в сеть не уходил.
    expect(providerOpts).toBeTruthy()
    expect(providerOpts!.claudeOauthToken).toBe('sk-B')
    // Active реально переключился на B (следующие запросы тоже через B).
    expect(getActiveAccount(db, 'claude-cli')?.id).toBe(b.id)
    // Timeline: route-событие ротации с machine-readable preflight-evidence.
    const rot = agentRuns.appendEvent.mock.calls.find(c => c[1] === 'route' && (c[2] as { label?: string })?.label === 'rotate-account')
    expect(rot).toBeTruthy()
    const payload = rot![2] as { detail: string; ref: string }
    expect(payload.detail).toContain('Аккаунт A')
    expect(payload.detail).toContain('Аккаунт B')
    const ref = JSON.parse(payload.ref) as Record<string, unknown>
    expect(ref).toMatchObject({
      kind: 'rotate-account', preflight: true, reason: 'cooling',
      fromAccountLabel: 'Аккаунт A', toAccountLabel: 'Аккаунт B', resetAt: NOW + 3_600_000,
    })
    // Секреты нигде не светятся.
    expect(JSON.stringify(payload)).not.toContain('sk-')
    // Renderer получил route-changed для пилюли «⇄ Аккаунт A → B».
    const rc = sent.find(p => p.event.type === 'route-changed')
    expect(rc).toBeTruthy()
    expect(rc!.event).toMatchObject({
      action: 'rotate-account',
      accounts: { fromLabel: 'Аккаунт A', toLabel: 'Аккаунт B' },
      resetAt: NOW + 3_600_000,
    })
  })

  it('EF-allBlocked: Auto, единственный аккаунт cooling → честный стоп ДО сети (не 429)', async () => {
    const a = addAccount('Единственный', 'subacct:a')
    secrets['subacct:a'] = 'sk-A'
    markAccountCooling(db, a.id, NOW + 60_000, { scope: 'account', reason: 'quota' })
    const sendId = await sendOnce()
    expect(sendId).toBe(0)
    expect(providerOpts, 'провайдер не создаётся — никакого сетевого запроса').toBeNull()
    expect(agentRuns.create, 'run-строка не создаётся').not.toHaveBeenCalled()
    const err = sent.find(p => p.event.type === 'error')
    expect(err).toBeTruthy()
    expect(err!.event.message).toContain('остывают')
    expect(err!.event.message).toContain('(1)')
    expect(err!.chatId, 'ошибка адресована чату').toBe(7)
  })

  it('EF-allBlocked: все аккаунты требуют входа → стоп «требуют входа», сети нет', async () => {
    addAccount('Без входа 1', 'subacct:e1')
    addAccount('Без входа 2', 'subacct:e2')
    secrets['subacct:e1'] = null
    secrets['subacct:e2'] = null
    const sendId = await sendOnce()
    expect(sendId).toBe(0)
    expect(providerOpts).toBeNull()
    const err = sent.find(p => p.event.type === 'error')
    expect(err!.event.message).toContain('требуют входа')
    expect(err!.event.message).toContain('(2)')
  })

  it('EF-R2 Б1: active сменился «во время await» — credentials и run.accountId из ОДНОГО resolve', async () => {
    const a = addAccount('Аккаунт A', 'subacct:a') // активный (первый в пуле)
    const b = addAccount('Аккаунт B', 'subacct:b')
    secrets['subacct:a'] = 'sk-A'
    secrets['subacct:b'] = 'sk-B'
    expect(getActiveAccount(db, 'claude-cli')?.id).toBe(a.id)
    // Гонка Б1: первый resolve отдаёт A; ЛЮБОЙ повторный resolve (после await
    // подготовки контекста) уже видит B — раньше провайдер уходил на B при run.accountId=A.
    let resolveCalls = 0
    const realResolve = createResolveSubscriptionAccount(db, {
      getSecret: (k: string) => secrets[k] ?? null,
      getSubscriptionBinding: () => binding,
      now: () => NOW,
    })
    handlers.clear()
    const deps = makeDeps()
    deps.resolveSubscriptionAccount = (pid: string, cid?: number, o?: { accountId?: number | null }) => {
      resolveCalls++
      if (resolveCalls > 1) setActiveAccount(db, 'claude-cli', b.id)
      return realResolve(pid, cid, o)
    }
    registerAiIpc(deps)
    const sendId = await sendOnce()
    expect(sendId).toBeGreaterThan(0)
    // Инвариант: ОДИН согласованный resolve на попытку — повторного чтения active нет.
    expect(resolveCalls, 'повторный resolve после await — источник A/B race').toBe(1)
    // Провайдер создан с токеном ТОГО ЖЕ аккаунта, что записан в run.accountId.
    expect(providerOpts).toBeTruthy()
    expect(providerOpts!.claudeOauthToken).toBe('sk-A')
    expect(agentRuns.create).toHaveBeenCalledTimes(1)
    expect(agentRuns.create.mock.calls[0][0]).toMatchObject({ accountId: a.id })
    expect(agentRuns.create.mock.calls[0][0]).not.toMatchObject({ accountId: b.id })
  })
})
