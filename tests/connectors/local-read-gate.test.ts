import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTelegramConnector } from '../../electron/connectors/telegram'
import { createYandexDiskConnector } from '../../electron/connectors/yandex-disk'
import type { ConnectorContext } from '../../electron/connectors/types'

// Блок №6 Этапа 1а (security-долг переноса, отчёт headless-recon §4 п.6): telegram
// send_document и yandex-disk upload_file читают ЛОКАЛЬНЫЙ файл по пути из аргументов
// модели. На общем сервере это примитив чтения произвольного файла (secrets соседей,
// конфиги хоста) с эксфильтрацией наружу. Гейт: пути обязаны лежать внутри
// ctx.allowedReadRoots (когда заданы), а секрето-файлы (isForbiddenPath) запрещены всегда.
//
// Сетка писана ДО фикса и обязана быть КРАСНОЙ на текущем коде (кроме контрольных кейсов).

describe('коннекторы: гейт локального чтения по путям из аргументов модели', () => {
  let root: string          // разрешённый корень (workspace задачи)
  let outside: string       // чужая территория
  let fetchCalls: Array<{ url: string; init?: RequestInit }>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vsk-read-gate-root-'))
    outside = mkdtempSync(join(tmpdir(), 'vsk-read-gate-outside-'))
    writeFileSync(join(root, 'legit.txt'), 'обычный файл workspace')
    writeFileSync(join(outside, 'host-secret.txt'), 'SECRET_HOST_DATA_do_not_leak')
    fetchCalls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true, href: 'https://upload.example/put', method: 'PUT' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  function tgCtx(): ConnectorContext {
    return {
      getSecret: (k: string) => ({
        telegram_bot_token: 'tok-123',
        telegram_chat_whitelist: '["777"]'
      } as Record<string, string>)[k] ?? null,
      signal: new AbortController().signal,
      allowedReadRoots: [root]
    }
  }

  function ydCtx(): ConnectorContext {
    return {
      getSecret: (k: string) => (k === 'yandex_disk_token' ? 'oauth-tok' : null),
      signal: new AbortController().signal,
      allowedReadRoots: [root]
    }
  }

  it('КРАСНЫЙ ДО ФИКСА: telegram send_document с путём ВНЕ корня → отказ, файл не уходит в сеть', async () => {
    const tg = createTelegramConnector()
    const res = await tg.query({
      op: 'send_document',
      chat_id: '777',
      document_path: join(outside, 'host-secret.txt')
    }, tgCtx()) as { error?: string } | undefined
    expect(res?.error).toBe('forbidden-path')
    expect(fetchCalls.length).toBe(0)
  })

  it('КРАСНЫЙ ДО ФИКСА: telegram send_document секрето-файла (.env) — запрещён даже ВНУТРИ корня', async () => {
    writeFileSync(join(root, '.env'), 'API_KEY=leak-me')
    const tg = createTelegramConnector()
    const res = await tg.query({
      op: 'send_document',
      chat_id: '777',
      document_path: join(root, '.env')
    }, tgCtx()) as { error?: string } | undefined
    expect(res?.error).toBe('forbidden-path')
    expect(fetchCalls.length).toBe(0)
  })

  it('контрольный кейс: легитимный файл ВНУТРИ корня проходит гейт (запрос уходит боту)', async () => {
    const tg = createTelegramConnector()
    const res = await tg.query({
      op: 'send_document',
      chat_id: '777',
      document_path: join(root, 'legit.txt')
    }, tgCtx()) as { error?: string } | undefined
    expect(res?.error).toBeUndefined()
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toContain('sendDocument')
  })

  it('КРАСНЫЙ ДО ФИКСА: yandex-disk upload_file с путём ВНЕ корня → отказ до единого сетевого вызова', async () => {
    const yd = createYandexDiskConnector()
    const res = await yd.query({
      op: 'upload_file',
      local_path: join(outside, 'host-secret.txt')
    }, ydCtx()) as { error?: string } | undefined
    expect(res?.error).toBe('forbidden-path')
    // Проверка «до единого вызова» существенна: гейт обязан стоять ДО ensureDir/upload,
    // иначе путь наружу уже открыт к моменту отказа.
    expect(fetchCalls.length).toBe(0)
  })

  it('легаси-совместимость: без allowedReadRoots (десктоп) обычный файл читается как раньше', async () => {
    const tg = createTelegramConnector()
    const ctx = { ...tgCtx(), allowedReadRoots: undefined } as ConnectorContext
    const res = await tg.query({
      op: 'send_document',
      chat_id: '777',
      document_path: join(outside, 'host-secret.txt')
    }, ctx) as { error?: string } | undefined
    // Пути вне корня на десктопе легитимны (пользователь шлёт свой файл из любого места).
    expect(res?.error).toBeUndefined()
    expect(fetchCalls.length).toBe(1)
  })

  it('symlink изнутри корня наружу НЕ обходит гейт', async () => {
    const linkDir = join(root, 'link-out')
    try {
      const { symlinkSync } = await import('fs')
      symlinkSync(outside, linkDir, 'junction')
    } catch {
      return // нет прав на symlink — кейс покрыт realpath-логикой, проверенной выше
    }
    const tg = createTelegramConnector()
    const res = await tg.query({
      op: 'send_document',
      chat_id: '777',
      document_path: join(linkDir, 'host-secret.txt')
    }, tgCtx()) as { error?: string } | undefined
    expect(res?.error).toBe('forbidden-path')
    expect(fetchCalls.length).toBe(0)
  })
})
