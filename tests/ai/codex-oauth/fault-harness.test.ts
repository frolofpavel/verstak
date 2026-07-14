// OAuth fault harness — Фаза 2 §2.3 плана качества (срез 6).
//
// Покрываем НЕ happy-path, а отказы: параллельные refresh'и (single-flight),
// ротация refresh_token, сбой записи auth-state, реактивный 401-retry без вечного
// цикла, честный transport. Чистые модули (JWT/refresh-merge) уже покрыты в
// codex-oauth-auth/refresh.test.ts — здесь обёртки сети/fs, где живут отказы.
//
// БЕЗОПАСНОСТЬ (жёсткое требование плана): ни один тест не открывает реальный
// ~/.codex/auth.json, не трогает safeStorage и не печатает токены. Только
// синтетические JWT (подпись-заглушка) и временная папка.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

// Управляемый сбой записи (ENOSPC/EACCES) — hoisted, т.к. vi.mock поднимается выше импортов.
const ctl = vi.hoisted(() => ({ failWrite: false }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (ctl.failWrite) throw new Error('ENOSPC: no space left on device')
      return actual.writeFileSync(...args)
    }
  }
})

import { createCodexCredentialStore } from '../../../electron/ai/codex-oauth/credential-store'
import { createCodexOAuthProvider } from '../../../electron/ai/codex-oauth/provider'
import { PROVIDERS, isSubprocessTransport } from '../../../electron/ai/registry'

const AUTH_CLAIM = 'https://api.openai.com/auth'
const REFRESH_URL = 'auth.openai.com/oauth/token'
const RESPONSES_URL = 'chatgpt.com/backend-api/codex/responses'

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
const jwt = (payload: unknown) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`

/** Синтетический access_token: exp через N мс + claim с account_id. */
function accessToken(expInMs: number, accountId: string | null = 'acc-1'): string {
  const payload: Record<string, unknown> = { exp: Math.floor((Date.now() + expInMs) / 1000) }
  if (accountId) payload[AUTH_CLAIM] = { chatgpt_account_id: accountId }
  return jwt(payload)
}

let home: string
let authPath: string

function seedAuth(tokens: { access_token: string; refresh_token?: string; id_token?: string; account_id?: string }): void {
  writeFileSync(authPath, JSON.stringify({ tokens: { id_token: '', refresh_token: 'refresh-OLD', ...tokens } }, null, 2), 'utf8')
}

beforeEach(() => {
  ctl.failWrite = false
  home = mkdtempSync(join(tmpdir(), 'verstak-codex-fault-'))
  authPath = join(home, 'auth.json')
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

// ─── Безопасность харнеса ────────────────────────────────────────────────────
describe('безопасность: реальный ~/.codex/auth.json не трогаем', () => {
  it('store с явным codexHome смотрит во временную папку, а не в домашнюю', () => {
    const store = createCodexCredentialStore(home)
    expect(store.path).toBe(authPath)
    expect(store.path.startsWith(tmpdir())).toBe(true)
    expect(store.path.includes(join(homedir(), '.codex'))).toBe(false)
  })
})

// ─── single-flight refresh ───────────────────────────────────────────────────
describe('single-flight refresh при параллельных запросах', () => {
  it('два параллельных getCredentials при истекающем токене делают ОДИН refresh', async () => {
    seedAuth({ access_token: accessToken(-1000) }) // уже истёк → нужен refresh
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(String(url)).toContain(REFRESH_URL)
      refreshCalls++
      await new Promise(r => setTimeout(r, 10)) // держим in-flight, чтобы второй вызов застал его
      return new Response(JSON.stringify({
        access_token: accessToken(60 * 60 * 1000),
        refresh_token: 'refresh-NEW',
        id_token: jwt({ [AUTH_CLAIM]: { chatgpt_account_id: 'acc-1' } })
      }), { status: 200 })
    }))

    const store = createCodexCredentialStore(home)
    const [a, b] = await Promise.all([store.getCredentials(), store.getCredentials()])

    // Оба получили креды, но refresh был ОДИН (иначе гонка двух writer'ов → refresh_token_reused).
    expect(refreshCalls).toBe(1)
    expect(a.accountId).toBe('acc-1')
    expect(b.accessToken).toBe(a.accessToken)
  })
})

// ─── ротация refresh_token: атомарная запись ─────────────────────────────────
describe('ротация refresh_token сохраняется атомарно', () => {
  it('после refresh на диске НОВЫЙ refresh_token и не осталось tmp-мусора', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: accessToken(60 * 60 * 1000),
      refresh_token: 'refresh-ROTATED'
    }), { status: 200 })))

    const store = createCodexCredentialStore(home)
    await store.getCredentials()

    const onDisk = JSON.parse(readFileSync(authPath, 'utf8')) as { tokens: { refresh_token: string } }
    expect(onDisk.tokens.refresh_token).toBe('refresh-ROTATED')
    // Атомарность: временный файл не должен остаться рядом.
    expect(readdirSync(home).filter(f => f.includes('tmp'))).toEqual([])
  })

  it('refresh БЕЗ нового refresh_token в ответе — старый сохранён (не затирается пустотой)', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: accessToken(60 * 60 * 1000)  // refresh_token НЕ пришёл
    }), { status: 200 })))

    const store = createCodexCredentialStore(home)
    await store.getCredentials()

    const onDisk = JSON.parse(readFileSync(authPath, 'utf8')) as { tokens: { refresh_token: string } }
    expect(onDisk.tokens.refresh_token).toBe('refresh-OLD')
  })
})

// ─── сбой записи auth-state ──────────────────────────────────────────────────
describe('сбой записи auth-state НЕ уничтожает рабочее состояние', () => {
  it('запись упала после успешного refresh → сессия ЖИВА (новые токены отданы), старый файл цел', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    const fresh = accessToken(60 * 60 * 1000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: fresh,
      refresh_token: 'refresh-ROTATED'
    }), { status: 200 })))

    const store = createCodexCredentialStore(home)
    ctl.failWrite = true // диск полон / нет прав

    // Ключевой инвариант: refresh на сервере УЖЕ произошёл (старый refresh_token
    // ротирован и мёртв). Если уронить всю операцию, пользователь получает лок-аут.
    // Сессия обязана выжить на новых токенах в памяти.
    const creds = await store.getCredentials()
    expect(creds.accessToken).toBe(fresh)
    expect(creds.accountId).toBe('acc-1')

    // Старый файл на диске не испорчен и не обнулён (читаемый JSON со старым содержимым).
    const onDisk = JSON.parse(readFileSync(authPath, 'utf8')) as { tokens: { refresh_token: string } }
    expect(onDisk.tokens.refresh_token).toBe('refresh-OLD')
    expect(existsSync(authPath)).toBe(true)
  })
})

// ─── битый/неполный auth.json ────────────────────────────────────────────────
describe('битый auth-state даёт понятную ошибку, а не тихий undefined', () => {
  it('нет account_id нигде (ни поле, ни claim) → внятная ошибка', async () => {
    seedAuth({ access_token: accessToken(60 * 60 * 1000, null) }) // валиден по exp, но без claim
    const store = createCodexCredentialStore(home)
    await expect(store.getCredentials()).rejects.toThrow(/account_id/i)
  })

  it('нет access_token → внятная ошибка «залогинься»', async () => {
    writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: 'r' } }), 'utf8')
    const store = createCodexCredentialStore(home)
    await expect(store.getCredentials()).rejects.toThrow(/access_token|логин|login/i)
  })

  it('файла нет вовсе → внятная ошибка с путём', async () => {
    const store = createCodexCredentialStore(join(home, 'nope'))
    await expect(store.getCredentials()).rejects.toThrow(/не найден|login/i)
  })
})

// ─── реактивный 401-retry: ровно один, без вечного цикла ─────────────────────
describe('401 → реактивный refresh + РОВНО один retry (нет вечного цикла)', () => {
  it('постоянный 401 не зацикливает: endpoint дёрнут 2 раза, наружу — ошибка', async () => {
    seedAuth({ access_token: accessToken(60 * 60 * 1000), refresh_token: 'refresh-OLD' })
    let responsesCalls = 0
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes(REFRESH_URL)) {
        refreshCalls++
        return new Response(JSON.stringify({ access_token: accessToken(60 * 60 * 1000), refresh_token: 'refresh-NEW' }), { status: 200 })
      }
      if (u.includes(RESPONSES_URL)) {
        responsesCalls++
        return new Response('unauthorized', { status: 401 })
      }
      throw new Error('unexpected url')
    }))

    const provider = createCodexOAuthProvider({ model: 'gpt-5.6-sol', codexHome: home })
    const events: string[] = []
    for await (const ev of provider.send([{ role: 'user', content: 'привет' }], [])) {
      events.push(ev.type)
    }

    // Bounded: первый запрос + ОДИН retry. Не 3, не бесконечность (прецедент 1.9.7 6b2f0b5).
    expect(responsesCalls).toBe(2)
    expect(refreshCalls).toBe(1)
    // Наружу — понятная ошибка, а не тихое зависание.
    expect(events).toContain('error')
  })
})

// ─── честный transport ───────────────────────────────────────────────────────
describe('transport-parity: ярлык совпадает с фактическим механизмом', () => {
  it('codex-oauth = API (наш agent-loop напрямую), НЕ subprocess', () => {
    const d = PROVIDERS['openai-codex-oauth']
    expect(d.transport).toBe('API')
    expect(isSubprocessTransport(d.transport)).toBe(false)
  })

  it('claude-cli = Tunnel (внешний агент владеет циклом), это subprocess', () => {
    const d = PROVIDERS['claude-cli']
    expect(d.transport).toBe('Tunnel')
    expect(isSubprocessTransport(d.transport)).toBe(true)
  })

  it('gemini-cli = CLI (наша обёртка над бинарём), это subprocess', () => {
    const d = PROVIDERS['gemini-cli']
    expect(d.transport).toBe('CLI')
    expect(isSubprocessTransport(d.transport)).toBe(true)
  })

  it('codex-oauth реально шлёт HTTP на codex-responses endpoint (direct loop, не CLI)', async () => {
    seedAuth({ access_token: accessToken(60 * 60 * 1000) })
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      return new Response('unauthorized', { status: 401 }) // короткий путь, нам важен факт HTTP
    }))
    const provider = createCodexOAuthProvider({ model: 'gpt-5.6-sol', codexHome: home })
    for await (const _ev of provider.send([{ role: 'user', content: 'x' }], [])) { /* дренируем */ }
    expect(urls.some(u => u.includes(RESPONSES_URL))).toBe(true)
  })
})
