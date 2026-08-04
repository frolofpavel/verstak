import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { randomBytes } from 'crypto'
import { createServer, request, type Server } from 'http'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'

// Задача W5: per-user ключи коннекторов в облаке. Ядро умело ХРАНИТЬ секреты тенанта,
// но снаружи их нечем было ЗАДАТЬ — «собери отчёт по моему Директу» был недостижим.
// Главные утверждения сетки: (1) значения секретов не выходят наружу ни в одном канале,
// (2) тенанты не видят и не меняют ключи друг друга, (3) запрещённый коннектор через эти
// ручки недостижим. Рядом с каждым «не произошло» стоит контрольный кейс — иначе пин
// зелен просто потому, что ничего не измеряет (§3.1).
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createHeadlessServer } = await import('../../electron/headless/server')
const { createTenantRegistry } = await import('../../electron/headless/tenants')

/** ASCII-маркер: файлы читаются побайтно (latin1), кириллица так не сматчилась бы. */
const ENDPOINT_AUTH = 'Bearer w5-connector-secret-QQZZ0123456789'
const DIRECT_TOKEN = 'w5-yandex-direct-token-QQZZ0123456789'
/** Значение НЕобязательного ключа: секретом не является, но наружу тоже не выдаётся. */
const OPTIONAL_LOGIN = 'w5-agency-login-QQZZ0123456789'

interface Call { status: number; body: string }

function call(port: number, method: string, path: string, tenant?: string, body?: unknown, token?: string): Promise<Call> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (tenant) headers['x-verstak-tenant'] = tenant
    if (token) headers.authorization = `Bearer ${token}`
    // Content-Length задаём ЯВНО: для DELETE http.ClientRequest не включает chunked
    // сам, и тело без длины Node-сервер отбивает как malformed (400 без тела) — это
    // свойство клиента, а не ручки. Кабинетный fetch ставит длину сам.
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    if (payload) headers['content-length'] = String(payload.length)
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

interface ConnectorView {
  id: string
  label: string
  kind: string
  status: string
  requiredKeys: string[]
  optionalKeys: string[]
  missingKeys: string[]
  configuredKeys: string[]
}

function views(body: string): ConnectorView[] {
  return (JSON.parse(body) as { connectors: ConnectorView[] }).connectors
}

function pick(body: string, id: string): ConnectorView | undefined {
  return views(body).find(c => c.id === id)
}

/** Локальный «внешний сервис» для generic-HTTP коннектора: живой сети в тесте нет. */
function fakeEndpoint(): Promise<{ base: string; seenAuth: string[]; close: () => Promise<void>; server: Server }> {
  const seenAuth: string[] = []
  const server = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ''))
    res.writeHead(200, { 'content-type': 'application/json' })
    // Тело НЕ отражает Authorization: иначе секрет уехал бы в таймлайн законно, и пин
    // «значение нигде не осело» перестал бы что-либо доказывать.
    res.end(JSON.stringify({ ok: true, campaigns: 3 }))
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        base: `http://127.0.0.1:${port}`,
        seenAuth,
        server,
        close: () => new Promise<void>(r => server.close(() => r()))
      })
    })
  })
}

/** Прогон, который один раз ходит в коннектор и заканчивается. */
function connectorCaller(): ChatProvider {
  let turn = 0
  return {
    id: 's', name: 's', models: ['s'],
    async *send(): AsyncGenerator<ChatEvent> {
      turn++
      if (turn === 1) {
        yield {
          type: 'tool-call',
          call: { id: 'c1', name: 'connector_query', args: { id: 'http', endpoint: 'w5', method: 'GET', path: '/report' } }
        }
        yield { type: 'done' }
      } else {
        yield { type: 'text', text: 'отчёт собран' }
        yield { type: 'done' }
      }
    }
  }
}

/** Рекурсивно собирает содержимое всех файлов каталога — для грепа секрета. */
function readAllFiles(dir: string, depth = 0): string {
  if (depth > 6) return ''
  let out = ''
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let st: ReturnType<typeof statSync>
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) { out += readAllFiles(full, depth + 1); continue }
    try { out += readFileSync(full, 'latin1') } catch { /* нечитаемый — пропускаем */ }
  }
  return out
}

describe('ключи коннекторов тенанта — ручки /connectors (задача W5)', () => {
  let root: string
  let server: { close: () => Promise<void> } | null = null
  let registry: ReturnType<typeof createTenantRegistry> | null = null
  let endpoint: Awaited<ReturnType<typeof fakeEndpoint>> | null = null

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vsk-w5-')) })
  afterEach(async () => {
    if (server) { await server.close(); server = null }
    if (registry) { registry.closeAll(); registry = null }
    if (endpoint) { await endpoint.close(); endpoint = null }
    rmSync(root, { recursive: true, force: true })
  })

  async function boot(authToken?: string) {
    registry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      hostDefaults: { providerFactory: () => connectorCaller() }
    })
    const s = createHeadlessServer({ tenants: registry, authToken: authToken ?? null })
    server = s
    return await s.listen(0)
  }

  it('GET /connectors: статус, требуемые и заданные ключи — ИМЕНАМИ, без значений', async () => {
    const port = await boot()
    const before = await call(port, 'GET', '/connectors', 'user-a')
    expect(before.status).toBe(200)
    const direct = pick(before.body, 'yandex_direct')
    expect(direct).toBeDefined()
    expect(direct!.kind).toBe('yandex_direct')
    expect(direct!.status).toBe('needs-config')
    expect(direct!.requiredKeys).toEqual(['yandex_direct_token'])
    expect(direct!.missingKeys).toEqual(['yandex_direct_token'])
    expect(direct!.configuredKeys).toEqual([])

    const set = await call(port, 'POST', '/connectors/yandex_direct/secrets', 'user-a', {
      yandex_direct_token: DIRECT_TOKEN,
      yandex_direct_login: 'agency-client-1'
    })
    expect(set.status).toBe(200)
    // Ответ POST — та же форма, что ОДИН элемент GET.
    const posted = JSON.parse(set.body) as ConnectorView
    expect(posted.id).toBe('yandex_direct')
    expect(posted.status).toBe('ready')
    expect(posted.missingKeys).toEqual([])
    expect(posted.configuredKeys.sort()).toEqual(['yandex_direct_login', 'yandex_direct_token'])
    // Значения не выдаются НИ В ОДНОМ поле ответа.
    expect(set.body).not.toContain(DIRECT_TOKEN)

    const after = await call(port, 'GET', '/connectors', 'user-a')
    expect(after.body).not.toContain(DIRECT_TOKEN)
    expect(pick(after.body, 'yandex_direct')!.status).toBe('ready')
    // Контрольный кейс к «значения не выдаются»: имена в ответе ЕСТЬ, то есть проверка
    // не зелена просто потому, что тело пустое.
    expect(after.body).toContain('yandex_direct_token')
  })

  it('optionalKeys: необязательные ключи объявлены ИМЕНАМИ — кабинету есть что предложить, готовность от них не зависит', async () => {
    const port = await boot()
    const direct = pick((await call(port, 'GET', '/connectors', 'user-a')).body, 'yandex_direct')!
    // Кабинет обязан узнать про yandex_direct_login ДО того, как ключ задан: в requiredKeys
    // его нет по смыслу, в configuredKeys — пока не задан, и предложить ввод нечем.
    expect(direct.optionalKeys).toEqual(['yandex_direct_login'])
    expect(direct.requiredKeys).not.toContain('yandex_direct_login')
    expect(direct.missingKeys).not.toContain('yandex_direct_login')
    expect(direct.configuredKeys).toEqual([])

    // Готовность от необязательного ключа не зависит: хватило обязательного → ready, а
    // optionalKeys продолжает называть НЕзаданный login.
    const ready = JSON.parse((await call(port, 'POST', '/connectors/yandex_direct/secrets', 'user-a', {
      yandex_direct_token: DIRECT_TOKEN
    })).body) as ConnectorView
    expect(ready.status).toBe('ready')
    expect(ready.optionalKeys).toEqual(['yandex_direct_login'])
    expect(ready.configuredKeys).toEqual(['yandex_direct_token'])

    // Заданный необязательный ключ переезжает в configuredKeys, оставаясь объявленным
    // необязательным; ЗНАЧЕНИЕ не выдаётся ни в ответе POST, ни в списке.
    const withLogin = JSON.parse((await call(port, 'POST', '/connectors/yandex_direct/secrets', 'user-a', {
      yandex_direct_login: OPTIONAL_LOGIN
    })).body) as ConnectorView
    expect(withLogin.optionalKeys).toEqual(['yandex_direct_login'])
    expect(withLogin.configuredKeys.sort()).toEqual(['yandex_direct_login', 'yandex_direct_token'])
    expect(withLogin.missingKeys).toEqual([])
    expect(JSON.stringify(withLogin)).not.toContain(OPTIONAL_LOGIN)
    const list = (await call(port, 'GET', '/connectors', 'user-a')).body
    expect(list).not.toContain(OPTIONAL_LOGIN)
    expect(list).not.toContain(DIRECT_TOKEN)
    // Контрольный кейс к «значений нет»: ИМЯ ключа в теле есть — пин не зелен от пустоты.
    expect(list).toContain('yandex_direct_login')
  })

  it('optionalKeys считается по коннектору, а не константа: у onec пуст, у telegram полон, с requiredKeys не пересекается', async () => {
    const port = await boot()
    const all = views((await call(port, 'GET', '/connectors', 'user-a')).body)
    expect(all.find(c => c.id === 'onec')!.optionalKeys).toEqual([])
    // Контрольный кейс: непустые optionalKeys в ТОМ ЖЕ ответе есть — иначе «у onec пусто»
    // было бы зелено просто потому, что поле пусто у всех.
    expect(all.find(c => c.id === 'telegram')!.optionalKeys)
      .toEqual(['telegram_chat_whitelist', 'telegram_notify_chat_id'])
    expect(all.filter(c => c.optionalKeys.length > 0).length).toBeGreaterThan(1)
    // Обязательное и необязательное не пересекаются ни у одного коннектора: иначе кабинет
    // предлагал бы один ключ дважды и с разным смыслом.
    for (const c of all) {
      expect([c.id, c.optionalKeys.filter(k => c.requiredKeys.includes(k))]).toEqual([c.id, []])
    }
  })

  it('requiresAnyOf: заданного одного ключа достаточно, остальные НЕ считаются недостающими', async () => {
    const port = await boot()
    const empty = pick((await call(port, 'GET', '/connectors', 'user-a')).body, 'http')!
    expect(empty.status).toBe('needs-config')
    expect(empty.missingKeys).toEqual(empty.requiredKeys)

    const set = JSON.parse((await call(port, 'POST', '/connectors/http/secrets', 'user-a', {
      http_endpoint_1_base: 'http://127.0.0.1:1'
    })).body) as ConnectorView
    expect(set.status).toBe('ready')
    expect(set.missingKeys).toEqual([])
    expect(set.configuredKeys).toEqual(['http_endpoint_1_base'])
  })

  it('неизвестный для коннектора ключ — 400, и НИЧЕГО из тела не применяется', async () => {
    const port = await boot()
    const bad = await call(port, 'POST', '/connectors/yandex_direct/secrets', 'user-a', {
      yandex_direct_token: DIRECT_TOKEN,
      telegram_bot_token: 'not-mine'
    })
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body).error).toBe('unknown key for connector')
    // Частично применённое тело — состояние, о котором клиент не узнал бы из кода ответа.
    const list = await call(port, 'GET', '/connectors', 'user-a')
    expect(pick(list.body, 'yandex_direct')!.configuredKeys).toEqual([])
    expect(pick(list.body, 'telegram')!.configuredKeys).toEqual([])

    // Контрольный кейс: тот же запрос БЕЗ чужого ключа проходит — 400 не «всегда».
    const good = await call(port, 'POST', '/connectors/yandex_direct/secrets', 'user-a', {
      yandex_direct_token: DIRECT_TOKEN
    })
    expect(good.status).toBe(200)
  })

  it('не-строковое значение — 400 (тело), а не молча приведённое к строке', async () => {
    const port = await boot()
    const bad = await call(port, 'POST', '/connectors/yandex_direct/secrets', 'user-a', { yandex_direct_token: 42 })
    expect(bad.status).toBe(400)
    expect(pick((await call(port, 'GET', '/connectors', 'user-a')).body, 'yandex_direct')!.configuredKeys).toEqual([])
    // Контроль: строка того же ключа принимается.
    expect((await call(port, 'POST', '/connectors/yandex_direct/secrets', 'user-a', { yandex_direct_token: '42' })).status).toBe(200)
  })

  it('ПЕРИМЕТР: ssh недостижим через ручки и отсутствует в списке — 404, как несуществующий', async () => {
    const port = await boot()
    const list = await call(port, 'GET', '/connectors', 'user-a')
    expect(pick(list.body, 'ssh')).toBeUndefined()
    expect((await call(port, 'POST', '/connectors/ssh/secrets', 'user-a', { ssh_default_host: 'h' })).status).toBe(404)
    expect((await call(port, 'DELETE', '/connectors/ssh/secrets', 'user-a', {})).status).toBe(404)
    expect((await call(port, 'POST', '/connectors/no-such/secrets', 'user-a', {})).status).toBe(404)
    // Контрольные кейсы: список вообще НЕ пуст, и разрешённый коннектор отвечает 200 —
    // иначе «ssh нет» было бы зелено потому, что нет ничего.
    expect(views(list.body).length).toBeGreaterThan(20)
    expect((await call(port, 'POST', '/connectors/telegram/secrets', 'user-a', { telegram_bot_token: 't' })).status).toBe(200)
  })

  it('ПЕРИМЕТР: тенант B не видит и не снимает ключи тенанта A', async () => {
    const port = await boot()
    expect((await call(port, 'POST', '/connectors/yandex_direct/secrets', 'user-a', {
      yandex_direct_token: DIRECT_TOKEN
    })).status).toBe(200)

    const listB = await call(port, 'GET', '/connectors', 'user-b')
    expect(listB.body).not.toContain(DIRECT_TOKEN)
    expect(pick(listB.body, 'yandex_direct')!.status).toBe('needs-config')
    expect(pick(listB.body, 'yandex_direct')!.configuredKeys).toEqual([])

    // B снимает «свой» ключ того же имени — у A он обязан остаться.
    expect((await call(port, 'DELETE', '/connectors/yandex_direct/secrets', 'user-b', {})).status).toBe(200)
    expect(pick((await call(port, 'GET', '/connectors', 'user-a')).body, 'yandex_direct')!.status).toBe('ready')
    // Контрольный кейс: у САМОГО владельца DELETE действительно снимает — иначе пин
    // выше был бы зелён просто потому, что DELETE ничего не делает ни для кого.
    expect((await call(port, 'DELETE', '/connectors/yandex_direct/secrets', 'user-a', {})).status).toBe(200)
    expect(pick((await call(port, 'GET', '/connectors', 'user-a')).body, 'yandex_direct')!.status).toBe('needs-config')
  })

  it('DELETE: выборочно, идемпотентно, пустое тело снимает все ключи коннектора', async () => {
    const port = await boot()
    await call(port, 'POST', '/connectors/yandex_direct/secrets', 'user-a', {
      yandex_direct_token: DIRECT_TOKEN, yandex_direct_login: 'agency-client-1'
    })
    const partial = JSON.parse((await call(port, 'DELETE', '/connectors/yandex_direct/secrets', 'user-a', {
      keys: ['yandex_direct_login']
    })).body) as ConnectorView
    expect(partial.configuredKeys).toEqual(['yandex_direct_token'])
    expect(partial.status).toBe('ready')

    // Повтор того же DELETE — успех и то же состояние (идемпотентность).
    const again = JSON.parse((await call(port, 'DELETE', '/connectors/yandex_direct/secrets', 'user-a', {
      keys: ['yandex_direct_login']
    })).body) as ConnectorView
    expect(again).toEqual(partial)

    const all = JSON.parse((await call(port, 'DELETE', '/connectors/yandex_direct/secrets', 'user-a', {})).body) as ConnectorView
    expect(all.configuredKeys).toEqual([])
    expect(all.status).toBe('needs-config')
    // Неизвестное имя в keys — 400, а не тихий no-op.
    expect((await call(port, 'DELETE', '/connectors/yandex_direct/secrets', 'user-a', { keys: ['nope'] })).status).toBe(400)
  })

  it('коды доступа: без сервисного токена 401, без заголовка тенанта 400', async () => {
    const port = await boot('service-token')
    expect((await call(port, 'GET', '/connectors', 'user-a')).status).toBe(401)
    expect((await call(port, 'POST', '/connectors/telegram/secrets', 'user-a', {}, 'wrong')).status).toBe(401)
    expect((await call(port, 'GET', '/connectors', undefined, undefined, 'service-token')).status).toBe(400)
    expect((await call(port, 'POST', '/connectors/telegram/secrets', undefined, {}, 'service-token')).status).toBe(400)
    // Контрольный кейс: с токеном И тенантом та же ручка отвечает 200.
    expect((await call(port, 'GET', '/connectors', 'user-a', undefined, 'service-token')).status).toBe(200)
  })

  it('ПРИЁМКА e2e: задал ключ → коннектор готов → прогон им пользуется → снял → снова не задан; значение нигде не осело', async () => {
    endpoint = await fakeEndpoint()
    const port = await boot()

    // 1. Ключи ставятся снаружи, одной ручкой.
    const set = JSON.parse((await call(port, 'POST', '/connectors/http/secrets', 'user-a', {
      http_endpoint_1_name: 'w5',
      http_endpoint_1_base: endpoint.base,
      http_endpoint_1_auth: ENDPOINT_AUTH
    })).body) as ConnectorView
    expect(set.status).toBe('ready')
    expect(set.configuredKeys.sort()).toEqual(['http_endpoint_1_auth', 'http_endpoint_1_base', 'http_endpoint_1_name'])
    expect(JSON.stringify(set)).not.toContain(ENDPOINT_AUTH)

    // 2. Прогон реально пользуется ключом тенанта: внешний сервис увидел авторизацию.
    const runId = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'сходи в коннектор', agentMode: 'bypass', providerId: 'deepseek'
    })).body).runId as string
    let status = 'running'
    for (let i = 0; i < 60 && status === 'running'; i++) {
      await new Promise(r => setTimeout(r, 100))
      status = JSON.parse((await call(port, 'GET', `/tasks/${runId}`, 'user-a')).body).status
    }
    expect(status).toBe('done')
    expect(endpoint.seenAuth).toContain(ENDPOINT_AUTH)

    // 3. Значение не осело в durable-таймлайне задачи.
    const timeline = (await call(port, 'GET', `/tasks/${runId}/timeline`, 'user-a')).body
    expect(timeline).not.toContain(ENDPOINT_AUTH)
    expect(timeline).toContain('connector') // контроль: таймлайн о коннекторе вообще писал

    // 4. Снял — статус вернулся.
    const cleared = JSON.parse((await call(port, 'DELETE', '/connectors/http/secrets', 'user-a', {})).body) as ConnectorView
    expect(cleared.status).toBe('needs-config')
    expect(cleared.configuredKeys).toEqual([])

    // 5. Греп по ФАЙЛАМ тенанта (sqlite + логи + workspace): значения нет нигде.
    registry!.closeAll(); registry = null
    const stored = readAllFiles(root)
    expect(stored).not.toContain(ENDPOINT_AUTH)
    // Контрольный кейс: греп по этим же файлам ВООБЩЕ что-то находит (иначе п.5 зелен
    // просто потому, что читать нечего). Маркер ASCII — файлы читаются как latin1.
    expect(stored).toContain(runId)
  }, 40_000)
})
