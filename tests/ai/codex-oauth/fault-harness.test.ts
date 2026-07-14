// OAuth fault harness — Фаза 2 §2.3 плана качества (срез 6).
//
// Покрываем НЕ happy-path, а отказы: параллельные refresh'и (single-flight, в т.ч.
// МЕЖДУ чатами), ротация refresh_token, сбой записи auth-state (включая осиротевший
// tmp-файл с живым токеном), реактивный 401-retry без вечного цикла, честный transport.
// Чистые модули (JWT/refresh-merge) уже покрыты в codex-oauth-auth/refresh.test.ts —
// здесь обёртки сети/fs, где живут отказы.
//
// БЕЗОПАСНОСТЬ (жёсткое требование плана): ни один тест не открывает реальный
// ~/.codex/auth.json, не трогает safeStorage и не печатает токены. Только
// синтетические JWT (подпись-заглушка) и временная папка.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

// Управляемые сбои fs. hoisted — vi.mock поднимается выше импортов.
// ВАЖНО: тест пишет фикстуры через 'node:fs' (не мокается), а credential-store —
// через 'fs' (мокается). Поэтому счётчики считают ТОЛЬКО записи стора.
const ctl = vi.hoisted(() => ({ failWrite: false, failWriteOnce: false, failRename: false, writeCalls: 0 }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      ctl.writeCalls++
      if (ctl.failWrite) throw new Error('ENOSPC: no space left on device')
      if (ctl.failWriteOnce && ctl.writeCalls === 1) throw new Error('EBUSY: resource busy (антивирус держит файл)')
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (ctl.failRename) throw new Error('EPERM: operation not permitted, rename')
      return actual.renameSync(...args)
    }
  }
})

import {
  createCodexCredentialStore,
  __resetCodexCredentialStateForTests
} from '../../../electron/ai/codex-oauth/credential-store'
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

/** Ответ refresh-эндпоинта с ротацией. */
function refreshOk(newAccess: string, newRefresh?: string): Response {
  const body: Record<string, string> = { access_token: newAccess }
  if (newRefresh) body.refresh_token = newRefresh
  return new Response(JSON.stringify(body), { status: 200 })
}

beforeEach(() => {
  ctl.failWrite = false
  ctl.failWriteOnce = false
  ctl.failRename = false
  ctl.writeCalls = 0
  // Состояние стора модульное (переживает пересоздание) — обязателен сброс между тестами.
  __resetCodexCredentialStateForTests()
  home = mkdtempSync(join(tmpdir(), 'verstak-codex-fault-'))
  authPath = join(home, 'auth.json')
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
  it('два параллельных getCredentials ОДНОГО store делают ОДИН refresh', async () => {
    seedAuth({ access_token: accessToken(-1000) })
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      refreshCalls++
      await new Promise(r => setTimeout(r, 10))
      return refreshOk(accessToken(60 * 60 * 1000), 'refresh-NEW')
    }))

    const store = createCodexCredentialStore(home)
    const [a, b] = await Promise.all([store.getCredentials(), store.getCredentials()])

    expect(refreshCalls).toBe(1)
    expect(b.accessToken).toBe(a.accessToken)
  })

  // РЕАЛЬНАЯ гонка (найдена адверсариальным ревью): store создаётся ЗАНОВО на каждый
  // ai:send. Два параллельных чата = два store'а. Если single-flight живёт в экземпляре,
  // они сделают ДВА refresh'а — и второй получит refresh_token_reused (ротация одноразовая).
  it('два РАЗНЫХ store (= два параллельных чата) на один auth.json делают ОДИН refresh', async () => {
    seedAuth({ access_token: accessToken(-1000) })
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      refreshCalls++
      await new Promise(r => setTimeout(r, 10))
      return refreshOk(accessToken(60 * 60 * 1000), 'refresh-NEW')
    }))

    const chatA = createCodexCredentialStore(home)
    const chatB = createCodexCredentialStore(home)
    const [a, b] = await Promise.all([chatA.getCredentials(), chatB.getCredentials()])

    expect(refreshCalls).toBe(1)          // иначе второй чат словил бы refresh_token_reused
    expect(b.accessToken).toBe(a.accessToken)
  })

  // Ре-ревью #4: если fetch бросит СИНХРОННО, отклонённый промис не должен «отравить»
  // общий кэш — иначе все последующие refresh'и падают той же старой ошибкой до
  // перезапуска приложения.
  it('синхронный сбой fetch НЕ залипает в single-flight: следующий вызов лечится', async () => {
    seedAuth({ access_token: accessToken(-1000) })
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('boom: синхронный сбой') }))

    await expect(createCodexCredentialStore(home).getCredentials()).rejects.toThrow(/boom/)

    // Сеть починилась — следующий вызов обязан сделать НОВЫЙ refresh, а не отдать старый отказ.
    vi.stubGlobal('fetch', vi.fn(async () => refreshOk(accessToken(60 * 60 * 1000), 'refresh-NEW')))
    const creds = await createCodexCredentialStore(home).getCredentials()
    expect(creds.accountId).toBe('acc-1')
  })
})

// ─── ротация refresh_token: атомарная запись ─────────────────────────────────
describe('ротация refresh_token сохраняется атомарно', () => {
  it('после refresh на диске НОВЫЙ refresh_token и не осталось tmp-мусора', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    vi.stubGlobal('fetch', vi.fn(async () => refreshOk(accessToken(60 * 60 * 1000), 'refresh-ROTATED')))

    await createCodexCredentialStore(home).getCredentials()

    const onDisk = JSON.parse(readFileSync(authPath, 'utf8')) as { tokens: { refresh_token: string } }
    expect(onDisk.tokens.refresh_token).toBe('refresh-ROTATED')
    expect(readdirSync(home).filter(f => f.includes('tmp'))).toEqual([])
  })

  it('refresh БЕЗ нового refresh_token в ответе — старый сохранён (не затирается пустотой)', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    vi.stubGlobal('fetch', vi.fn(async () => refreshOk(accessToken(60 * 60 * 1000))))

    await createCodexCredentialStore(home).getCredentials()

    const onDisk = JSON.parse(readFileSync(authPath, 'utf8')) as { tokens: { refresh_token: string } }
    expect(onDisk.tokens.refresh_token).toBe('refresh-OLD')
  })

  it('транзиентный сбой записи лечится ПОВТОРОМ (антивирус/индексатор держал файл)', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    vi.stubGlobal('fetch', vi.fn(async () => refreshOk(accessToken(60 * 60 * 1000), 'refresh-ROTATED')))
    ctl.failWriteOnce = true // первая запись падает, вторая проходит

    const store = createCodexCredentialStore(home)
    await store.getCredentials()

    const onDisk = JSON.parse(readFileSync(authPath, 'utf8')) as { tokens: { refresh_token: string } }
    expect(onDisk.tokens.refresh_token).toBe('refresh-ROTATED') // персист всё-таки прошёл
    expect(store.takePersistWarning()).toBeNull()               // и предупреждать не о чем
  })
})

// ─── сбой записи auth-state ──────────────────────────────────────────────────
describe('сбой записи auth-state НЕ уничтожает рабочее состояние', () => {
  it('запись упала после успешного refresh → сессия жива, старый файл цел', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    const fresh = accessToken(60 * 60 * 1000)
    vi.stubGlobal('fetch', vi.fn(async () => refreshOk(fresh, 'refresh-ROTATED')))
    ctl.failWrite = true

    const creds = await createCodexCredentialStore(home).getCredentials()
    expect(creds.accessToken).toBe(fresh)

    const onDisk = JSON.parse(readFileSync(authPath, 'utf8')) as { tokens: { refresh_token: string } }
    expect(onDisk.tokens.refresh_token).toBe('refresh-OLD') // файл не испорчен
  })

  // Ключевой инвариант (найден ревью): store пересоздаётся на КАЖДЫЙ ход. Если новые
  // токены не переживают пересоздание, следующий ход прочитает с диска ИЗРАСХОДОВАННЫЙ
  // refresh_token и получит invalid_grant → лок-аут просто отодвинут на один запрос.
  it('СЛЕДУЮЩИЙ ход (новый store) берёт токены из памяти, а не мёртвый токен с диска', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    const fresh = accessToken(60 * 60 * 1000)
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      refreshCalls++
      // Как настоящий OpenAI: израсходованный refresh_token мёртв.
      return refreshOk(fresh, 'refresh-ROTATED')
    }))
    ctl.failWrite = true

    await createCodexCredentialStore(home).getCredentials()   // ход 1: персист упал
    const next = await createCodexCredentialStore(home).getCredentials() // ход 2: новый store

    expect(next.accessToken).toBe(fresh) // живём на памяти, а не на мёртвом диске
    expect(refreshCalls).toBe(1)         // повторного refresh мёртвым токеном НЕ было
  })

  it('сбой rename НЕ оставляет осиротевший tmp-файл с живым токеном', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    vi.stubGlobal('fetch', vi.fn(async () => refreshOk(accessToken(60 * 60 * 1000), 'refresh-ROTATED')))
    ctl.failRename = true // запись во временный файл прошла, переименование упало

    await createCodexCredentialStore(home).getCredentials()

    // Секрет не должен осиротеть рядом с auth.json.
    const orphans = readdirSync(home).filter(f => f !== 'auth.json')
    expect(orphans, `осиротевшие файлы с токеном: ${orphans.join(', ')}`).toEqual([])
  })

  it('пользователь УЗНАЁТ о несохранённом токене: провайдер отдаёт событие в Timeline', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes(REFRESH_URL)) return refreshOk(accessToken(60 * 60 * 1000), 'refresh-ROTATED')
      return new Response('unauthorized', { status: 401 }) // короткий путь, нам важно предупреждение
    }))
    ctl.failWrite = true

    const provider = createCodexOAuthProvider({ model: 'gpt-5.6-sol', codexHome: home })
    const seen: Array<{ type: string; title?: string; detail?: string }> = []
    for await (const ev of provider.send([{ role: 'user', content: 'x' }], [])) {
      seen.push(ev as { type: string; title?: string; detail?: string })
    }

    const warn = seen.find(e => e.type === 'agent-progress' && e.title?.includes('токен не сохранён'))
    expect(warn, 'предупреждение о несохранённом токене не дошло до UI').toBeDefined()
    expect(warn?.detail).toMatch(/codex login/i)
    // Токены в тексте предупреждения не светятся.
    expect(warn?.detail).not.toContain('refresh-ROTATED')
  })

  // Ре-ревью #1 (HIGH): двух ходов мало. При СТОЙКОМ сбое записи ориентир «что на диске»
  // не должен уезжать — иначе на 3-м ходу код примет нетронутый диск за re-login,
  // выбросит единственную живую копию токенов и попробует мёртвый → refresh_token_reused.
  it('стойкий сбой записи: ход 3 ТОЖЕ жив (память не самоуничтожается на втором сбое)', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'R1' })
    const consumed: string[] = []
    let n = 1
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      // Имитируем настоящий OpenAI: израсходованный refresh_token мёртв навсегда.
      const sent = JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string }
      const rt = String(sent.refresh_token)
      if (consumed.includes(rt)) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh_token_reused' }), { status: 400 })
      }
      consumed.push(rt)
      n++
      return refreshOk(accessToken(-1000), `R${n}`) // каждый выданный access тоже сразу протух → нужен refresh на след. ходу
    }))
    ctl.failWrite = true // запись падает ВСЕГДА

    await createCodexCredentialStore(home).getCredentials() // ход 1: R1 → R2
    await createCodexCredentialStore(home).getCredentials() // ход 2: R2 → R3
    await createCodexCredentialStore(home).getCredentials() // ход 3: должен взять R3, а НЕ мёртвый R1 с диска

    expect(consumed).toEqual(['R1', 'R2', 'R3']) // ни одного повторного использования
  })

  it('юзер вышел (codex logout — файла нет) → память НЕ подставляет токены старого аккаунта', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    vi.stubGlobal('fetch', vi.fn(async () => refreshOk(accessToken(60 * 60 * 1000), 'refresh-ROTATED')))
    ctl.failWrite = true
    await createCodexCredentialStore(home).getCredentials() // память заполнена

    unlinkSync(authPath) // codex logout

    await expect(createCodexCredentialStore(home).getCredentials()).rejects.toThrow(/не найден|login/i)
  })

  it('юзер перелогинился (файл на диске изменился) → память сбрасывается, берём диск', async () => {
    seedAuth({ access_token: accessToken(-1000), refresh_token: 'refresh-OLD' })
    vi.stubGlobal('fetch', vi.fn(async () => refreshOk(accessToken(60 * 60 * 1000), 'refresh-ROTATED')))
    ctl.failWrite = true
    await createCodexCredentialStore(home).getCredentials() // персист упал → память

    // codex login переписал auth.json свежими токенами.
    ctl.failWrite = false
    const relogin = accessToken(60 * 60 * 1000, 'acc-RELOGIN')
    seedAuth({ access_token: relogin, refresh_token: 'refresh-AFTER-LOGIN' })

    const creds = await createCodexCredentialStore(home).getCredentials()
    expect(creds.accountId).toBe('acc-RELOGIN') // диск новее памяти — он и главный
  })
})

// ─── битый/неполный auth.json ────────────────────────────────────────────────
describe('битый auth-state даёт понятную ошибку, а не тихий undefined', () => {
  it('нет account_id нигде (ни поле, ни claim) → внятная ошибка', async () => {
    seedAuth({ access_token: accessToken(60 * 60 * 1000, null) })
    await expect(createCodexCredentialStore(home).getCredentials()).rejects.toThrow(/account_id/i)
  })

  it('нет access_token → внятная ошибка «залогинься»', async () => {
    writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: 'r' } }), 'utf8')
    await expect(createCodexCredentialStore(home).getCredentials()).rejects.toThrow(/access_token|логин|login/i)
  })

  it('файла нет вовсе → внятная ошибка с путём', async () => {
    await expect(createCodexCredentialStore(join(home, 'nope')).getCredentials()).rejects.toThrow(/не найден|login/i)
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
        return refreshOk(accessToken(60 * 60 * 1000), 'refresh-NEW')
      }
      if (u.includes(RESPONSES_URL)) {
        responsesCalls++
        return new Response('unauthorized', { status: 401 })
      }
      throw new Error('unexpected url')
    }))

    const provider = createCodexOAuthProvider({ model: 'gpt-5.6-sol', codexHome: home })
    const events: string[] = []
    for await (const ev of provider.send([{ role: 'user', content: 'привет' }], [])) events.push(ev.type)

    // Bounded: первый запрос + ОДИН retry. Не 3, не бесконечность (класс дефекта 1.9.7 6b2f0b5).
    expect(responsesCalls).toBe(2)
    expect(refreshCalls).toBe(1)
    expect(events).toContain('error')
  })
})

// ─── честный transport ───────────────────────────────────────────────────────
describe('transport-parity: ярлык совпадает с фактическим механизмом', () => {
  it('codex-oauth = API (наш agent-loop напрямую), НЕ subprocess', () => {
    expect(PROVIDERS['openai-codex-oauth'].transport).toBe('API')
    expect(isSubprocessTransport(PROVIDERS['openai-codex-oauth'].transport)).toBe(false)
  })

  it('claude-cli = Tunnel (внешний агент владеет циклом), это subprocess', () => {
    expect(PROVIDERS['claude-cli'].transport).toBe('Tunnel')
    expect(isSubprocessTransport(PROVIDERS['claude-cli'].transport)).toBe(true)
  })

  it('gemini-cli = CLI (наша обёртка над бинарём), это subprocess', () => {
    expect(PROVIDERS['gemini-cli'].transport).toBe('CLI')
    expect(isSubprocessTransport(PROVIDERS['gemini-cli'].transport)).toBe(true)
  })

  it('codex-oauth реально шлёт HTTP на codex-responses endpoint (direct loop, не CLI)', async () => {
    seedAuth({ access_token: accessToken(60 * 60 * 1000) })
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      return new Response('unauthorized', { status: 401 })
    }))
    const provider = createCodexOAuthProvider({ model: 'gpt-5.6-sol', codexHome: home })
    for await (const _ev of provider.send([{ role: 'user', content: 'x' }], [])) { /* дренируем */ }
    expect(urls.some(u => u.includes(RESPONSES_URL))).toBe(true)
  })
})
