// Срез 2.0.8-C: изоляция Codex-аккаунтов для нативного openai-codex-oauth loop.
//
// DoD: выбранный account детерминированно обслуживает только свой run — нет global-env
// mutation, нет утечки токена, нет неограниченного refresh loop. Ядро изоляции —
// credential-store с ключом по ПУТИ к auth.json (свой config-dir = свой стейт). Этот тест
// доказывает: (1) ai.ts резолвит codexHome для openai-codex-oauth (баг: раньше только
// codex-cli → null → все аккаунты читали дефолтный ~/.codex/auth.json); (2) два CODEX_HOME
// читаются раздельно и НЕ пишут крест-накрест; (3) single-flight refresh; (4) 401 после
// refresh не зацикливается; (5) реальный ~/.codex не трогаем; (6) токен не течёт в события.
//
// БЕЗОПАСНОСТЬ: только синтетические JWT (подпись-заглушка) и временные папки. Реальный
// ~/.codex/auth.json / safeStorage не читаются, токены не печатаются.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

// ai.ts тянет ipcMain/app на загрузке модуля — мокаем, как в agent-loop.test.ts.
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

// F3 (ревью): проводка call-site → createProvider не была покрыта, из-за чего третий сайт
// (runScheduledHeadless) проскочил без codexHome. Спай на registry.createProvider ловит класс.
const { createProviderSpy } = vi.hoisted(() => ({ createProviderSpy: vi.fn() }))
vi.mock('../../electron/ai/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/ai/registry')>()
  return { ...actual, createProvider: (...args: unknown[]) => createProviderSpy(...args) }
})

import { resolveCodexHome, runScheduledHeadless } from '../../electron/ipc/ai'
import type { AiDeps } from '../../electron/ipc/ai'
import {
  createCodexCredentialStore,
  __resetCodexCredentialStateForTests,
} from '../../electron/ai/codex-oauth/credential-store'
import { createCodexOAuthProvider } from '../../electron/ai/codex-oauth/provider'
import { scanText } from '../../electron/ai/secret-scanner'
import type { ChatEvent } from '../../electron/ai/types'

const AUTH_CLAIM = 'https://api.openai.com/auth'
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
const jwt = (payload: unknown) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`

/** Синтетический access_token: exp через N мс + claim с account_id. */
function accessToken(expInMs: number, accountId: string): string {
  return jwt({ exp: Math.floor((Date.now() + expInMs) / 1000), [AUTH_CLAIM]: { chatgpt_account_id: accountId } })
}

function seedAuth(dir: string, tokens: { access_token: string; refresh_token: string; id_token?: string }): void {
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { id_token: '', ...tokens } }, null, 2), 'utf8')
}

let dirA: string
let dirB: string

beforeEach(() => {
  __resetCodexCredentialStateForTests()
  createProviderSpy.mockReset()
  dirA = mkdtempSync(join(tmpdir(), 'verstak-codex-iso-a-'))
  dirB = mkdtempSync(join(tmpdir(), 'verstak-codex-iso-b-'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
})

// ─── (1) ai.ts резолвит codexHome для openai-codex-oauth (ядро бага) ──────────
describe('resolveCodexHome — выбор изолированного config-dir по провайдеру', () => {
  const resolve = (accts: Record<string, string | null>) =>
    (p: string) => (p in accts ? { configDir: accts[p] } : null)

  it('openai-codex-oauth берёт активный Codex-аккаунт (не null) — тот же codex login', () => {
    // Баг 2.0.4: для openai-codex-oauth codexHome всегда был null → дефолтный ~/.codex,
    // переключение аккаунтов не действовало. Теперь оба провайдера делят активный Codex-аккаунт.
    expect(resolveCodexHome('openai-codex-oauth', resolve({ 'codex-cli': '/acct/codex-x' }))).toBe('/acct/codex-x')
  })

  it('codex-cli резолвит свой config-dir (регрессия не тронута)', () => {
    expect(resolveCodexHome('codex-cli', resolve({ 'codex-cli': '/acct/codex-x' }))).toBe('/acct/codex-x')
  })

  it('нет Codex-аккаунта → null (дефолтный ~/.codex/auth.json, обратная совместимость)', () => {
    expect(resolveCodexHome('openai-codex-oauth', () => null)).toBe(null)
    expect(resolveCodexHome('codex-cli', () => null)).toBe(null)
  })

  it('посторонние провайдеры не получают codexHome', () => {
    const r = resolve({ 'codex-cli': '/acct/codex-x', 'openai-codex-oauth': '/acct/oauth' })
    expect(resolveCodexHome('gemini-cli', r)).toBe(null)
    expect(resolveCodexHome('claude-cli', r)).toBe(null)
    expect(resolveCodexHome('openai', r)).toBe(null)
  })

  it('resolve отсутствует (undefined deps) → null, без краша', () => {
    expect(resolveCodexHome('openai-codex-oauth', undefined)).toBe(null)
  })
})

// ─── (2) два CODEX_HOME читаются раздельно, без cross-write ───────────────────
describe('изоляция двух аккаунтов A/B', () => {
  it('store A и store B читают СВОЙ auth.json (разные account_id)', async () => {
    seedAuth(dirA, { access_token: accessToken(60 * 60_000, 'acc-A'), refresh_token: 'refresh-A' })
    seedAuth(dirB, { access_token: accessToken(60 * 60_000, 'acc-B'), refresh_token: 'refresh-B' })

    const a = await createCodexCredentialStore(dirA).getCredentials()
    const b = await createCodexCredentialStore(dirB).getCredentials()

    expect(a.accountId).toBe('acc-A')
    expect(b.accountId).toBe('acc-B')
    expect(createCodexCredentialStore(dirA).path).toBe(join(dirA, 'auth.json'))
    expect(createCodexCredentialStore(dirB).path).toBe(join(dirB, 'auth.json'))
  })

  it('параллельный refresh A/B не пишет крест-накрест (каждый в свой файл)', async () => {
    seedAuth(dirA, { access_token: accessToken(-1000, 'acc-A'), refresh_token: 'refresh-A' })
    seedAuth(dirB, { access_token: accessToken(-1000, 'acc-B'), refresh_token: 'refresh-B' })

    // fetch выдаёт токен, зависящий от отправленного refresh_token → подмена файла спалится.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string }
      const who = sent.refresh_token === 'refresh-A' ? 'A' : 'B'
      return new Response(JSON.stringify({ access_token: accessToken(60 * 60_000, `acc-${who}`), refresh_token: `refresh-${who}-NEW` }), { status: 200 })
    }))

    const [a, b] = await Promise.all([
      createCodexCredentialStore(dirA).getCredentials(),
      createCodexCredentialStore(dirB).getCredentials(),
    ])
    expect(a.accountId).toBe('acc-A')
    expect(b.accountId).toBe('acc-B')

    const onDiskA = JSON.parse(readFileSync(join(dirA, 'auth.json'), 'utf8')) as { tokens: { refresh_token: string } }
    const onDiskB = JSON.parse(readFileSync(join(dirB, 'auth.json'), 'utf8')) as { tokens: { refresh_token: string } }
    expect(onDiskA.tokens.refresh_token).toBe('refresh-A-NEW') // A обновил только A
    expect(onDiskB.tokens.refresh_token).toBe('refresh-B-NEW') // B обновил только B
  })
})

// ─── (3) single-flight refresh одного аккаунта ───────────────────────────────
describe('single-flight на аккаунт', () => {
  it('пять одновременных getCredentials одного аккаунта → один network call', async () => {
    seedAuth(dirA, { access_token: accessToken(-1000, 'acc-A'), refresh_token: 'refresh-A' })
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      await new Promise(r => setTimeout(r, 10))
      return new Response(JSON.stringify({ access_token: accessToken(60 * 60_000, 'acc-A'), refresh_token: 'refresh-A-NEW' }), { status: 200 })
    }))
    // Пять store'ов одного пути (= пять параллельных ai:send одного аккаунта).
    const creds = await Promise.all(
      Array.from({ length: 5 }, () => createCodexCredentialStore(dirA).getCredentials())
    )
    expect(calls).toBe(1)
    expect(new Set(creds.map(c => c.accessToken)).size).toBe(1)
  })
})

// ─── (4) 401 после refresh не зацикливается ──────────────────────────────────
describe('401 после refresh — ограниченный retry, не вечный цикл', () => {
  it('provider делает РОВНО один refresh+retry, затем ошибка (без петли)', async () => {
    seedAuth(dirA, { access_token: accessToken(60 * 60_000, 'acc-A'), refresh_token: 'refresh-A' })
    let responsesCalls = 0
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/responses')) { responsesCalls++; return new Response('unauthorized', { status: 401 }) }
      refreshCalls++
      return new Response(JSON.stringify({ access_token: accessToken(60 * 60_000, 'acc-A'), refresh_token: 'refresh-A-NEW' }), { status: 200 })
    }))

    const provider = createCodexOAuthProvider({ model: 'gpt-5.6-sol', codexHome: dirA })
    const events: ChatEvent[] = []
    for await (const ev of provider.send([{ role: 'user', content: 'hi' }], [])) events.push(ev)

    expect(refreshCalls).toBe(1)      // ровно один refresh
    expect(responsesCalls).toBe(2)    // исходный + один retry, не бесконечно
    expect(events.some(e => e.type === 'error')).toBe(true)
  })
})

// ─── (5) реальный ~/.codex/auth.json не трогаем ──────────────────────────────
describe('безопасность: реальный ~/.codex не в игре', () => {
  it('store с явным codexHome смотрит в temp, не в домашнюю ~/.codex', () => {
    const store = createCodexCredentialStore(dirA)
    expect(store.path.startsWith(tmpdir())).toBe(true)
    expect(store.path.includes(join(homedir(), '.codex'))).toBe(false)
  })
})

// ─── (6) токен не течёт в события провайдера ──────────────────────────────────
describe('secret scanner: fixture-токен не утекает в события', () => {
  it('access_token не появляется в событиях провайдера (и режется scanText)', async () => {
    const secretTok = accessToken(60 * 60_000, 'acc-A')
    seedAuth(dirA, { access_token: secretTok, refresh_token: 'refresh-secret-XYZ' })
    // Ответ Responses: обычный SSE со стримом текста + completed (без токенов в теле).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )))

    const provider = createCodexOAuthProvider({ model: 'gpt-5.6-sol', codexHome: dirA })
    const events: ChatEvent[] = []
    for await (const ev of provider.send([{ role: 'user', content: 'hi' }], [])) events.push(ev)

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(secretTok)
    expect(serialized).not.toContain('refresh-secret-XYZ')
    // secret scanner не находит что резать (токен в события не попадал).
    const scan = scanText(serialized)
    expect(scan.hits).toHaveLength(0)
    expect(scan.redacted).toBe(serialized)
  })
})

// ─── (F1/F3) проводка codexHome во ВСЕ createProvider-сайты, включая scheduled ─
describe('scheduled headless проводит изолированный codexHome (ревью F1/F3)', () => {
  const baseDeps = () => ({
    getKnownRoots: () => [dirA],
    getSecret: (k: string) => (k === 'codex_oauth_risk_accepted' ? 'opted-in' : null),
    recentWrites: () => [],
  })

  it('openai-codex-oauth в unattended-прогоне получает CODEX_HOME активного аккаунта', async () => {
    // createProvider бросает сразу после захвата аргументов — тяжёлый путь не нужен,
    // codexHome уже проброшен. Раньше (F1) сюда шёл createProvider БЕЗ codexHome.
    createProviderSpy.mockImplementation(() => { throw new Error('stop-after-capture') })
    const deps = {
      ...baseDeps(),
      resolveSubscriptionAccount: (p: string) =>
        p === 'codex-cli' ? { accountId: 1, secret: null, configDir: dirA, baseUrl: null } : null,
    } as unknown as AiDeps

    await runScheduledHeadless(deps, {
      projectPath: dirA, prompt: 'x', providerId: 'openai-codex-oauth', model: 'gpt-5.6-sol',
      signal: new AbortController().signal,
    })

    expect(createProviderSpy).toHaveBeenCalledTimes(1)
    expect(createProviderSpy).toHaveBeenCalledWith('openai-codex-oauth', expect.objectContaining({ codexHome: dirA }))
  })

  it('нет активного Codex-аккаунта → codexHome null (дефолтный путь, не краш)', async () => {
    createProviderSpy.mockImplementation(() => { throw new Error('stop-after-capture') })
    const deps = { ...baseDeps(), resolveSubscriptionAccount: () => null } as unknown as AiDeps

    await runScheduledHeadless(deps, {
      projectPath: dirA, prompt: 'x', providerId: 'openai-codex-oauth', model: 'gpt-5.6-sol',
      signal: new AbortController().signal,
    })

    expect(createProviderSpy).toHaveBeenCalledWith('openai-codex-oauth', expect.objectContaining({ codexHome: null }))
  })
})
