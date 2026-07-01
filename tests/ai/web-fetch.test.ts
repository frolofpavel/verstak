import { describe, it, expect } from 'vitest'
import {
  isBlockedHost, isBlockedIp, assertUrlAllowed, htmlToText, fetchUrl
} from '../../electron/ai/web-fetch'

describe('web-fetch — SSRF host-блокировка (литеральные хосты)', () => {
  it('loopback / localhost блокируется', () => {
    expect(isBlockedHost('localhost')).toBeTruthy()
    expect(isBlockedHost('LOCALHOST')).toBeTruthy()
    expect(isBlockedHost('foo.localhost')).toBeTruthy()
    expect(isBlockedHost('127.0.0.1')).toBeTruthy()
    expect(isBlockedHost('127.1.2.3')).toBeTruthy()
  })
  it('приватные IPv4-диапазоны блокируются', () => {
    expect(isBlockedHost('10.0.0.5')).toBeTruthy()
    expect(isBlockedHost('192.168.1.1')).toBeTruthy()
    expect(isBlockedHost('172.16.0.1')).toBeTruthy()
    expect(isBlockedHost('172.31.255.255')).toBeTruthy()
    expect(isBlockedHost('0.0.0.0')).toBeTruthy()
  })
  it('cloud-metadata 169.254.169.254 блокируется (link-local)', () => {
    expect(isBlockedHost('169.254.169.254')).toBeTruthy()
  })
  it('.local (mDNS) блокируется', () => {
    expect(isBlockedHost('printer.local')).toBeTruthy()
  })
  it('IPv6 loopback / ULA / link-local блокируется', () => {
    expect(isBlockedHost('::1')).toBeTruthy()
    expect(isBlockedHost('[::1]')).toBeTruthy()
    expect(isBlockedHost('fc00::1')).toBeTruthy()
    expect(isBlockedHost('fe80::1')).toBeTruthy()
    expect(isBlockedHost('::ffff:127.0.0.1')).toBeTruthy()  // mapped IPv4 loopback (decimal)
  })
  it('IPv4-mapped IPv6 в HEX-форме блокируется (ревью C1 — new URL нормализует в hex)', () => {
    expect(isBlockedHost('::ffff:a9fe:a9fe')).toBeTruthy()   // 169.254.169.254 (metadata) hex
    expect(isBlockedHost('[::ffff:a9fe:a9fe]')).toBeTruthy()
    expect(isBlockedHost('::ffff:7f00:1')).toBeTruthy()      // 127.0.0.1 hex
    expect(isBlockedHost('::a9fe:a9fe')).toBeTruthy()        // IPv4-compat ::169.254.169.254
    expect(isBlockedHost('64:ff9b::a9fe:a9fe')).toBeTruthy() // NAT64 → 169.254.169.254
  })
  it('публичный mapped/IPv6 разрешён (не приватный embedded)', () => {
    expect(isBlockedHost('::ffff:808:808')).toBeNull()       // 8.8.8.8 mapped hex
    expect(isBlockedHost('2606:4700:4700::1111')).toBeNull() // Cloudflare public
  })
  it('публичные хосты проходят', () => {
    expect(isBlockedHost('example.com')).toBeNull()
    expect(isBlockedHost('8.8.8.8')).toBeNull()
    expect(isBlockedHost('93.184.216.34')).toBeNull()
    expect(isBlockedHost('api.github.com')).toBeNull()
  })
  it('172.32+ НЕ приватный (граница /12)', () => {
    expect(isBlockedHost('172.32.0.1')).toBeNull()
    expect(isBlockedHost('172.15.0.1')).toBeNull()
  })
})

describe('web-fetch — isBlockedIp (резолвленные адреса)', () => {
  it('приватные и loopback резолвы блокируются', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true)
    expect(isBlockedIp('10.1.2.3')).toBe(true)
    expect(isBlockedIp('169.254.169.254')).toBe(true)
    expect(isBlockedIp('::1')).toBe(true)
  })
  it('публичные резолвы проходят', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false)
    expect(isBlockedIp('1.1.1.1')).toBe(false)
  })
})

describe('web-fetch — assertUrlAllowed (схема + хост)', () => {
  it('только http/https', () => {
    expect(() => assertUrlAllowed('file:///etc/passwd')).toThrow()
    expect(() => assertUrlAllowed('ftp://example.com')).toThrow()
    expect(() => assertUrlAllowed('gopher://x')).toThrow()
    expect(() => assertUrlAllowed('http://example.com')).not.toThrow()
    expect(() => assertUrlAllowed('https://example.com/a')).not.toThrow()
  })
  it('невалидный URL бросает', () => {
    expect(() => assertUrlAllowed('не url')).toThrow()
  })
  it('приватный литеральный хост бросает', () => {
    expect(() => assertUrlAllowed('http://169.254.169.254/latest/meta-data')).toThrow()
    expect(() => assertUrlAllowed('http://localhost:8080/admin')).toThrow()
  })
  it('mapped-metadata через реальный URL бросает (C1, new URL → hex hostname)', () => {
    expect(() => assertUrlAllowed('http://[::ffff:169.254.169.254]/latest/meta-data/')).toThrow()
  })
  it('decimal/hex/octal IPv4 нормализуется new URL и блокируется', () => {
    expect(() => assertUrlAllowed('http://2130706433/')).toThrow()   // 127.0.0.1 decimal
    expect(() => assertUrlAllowed('http://0x7f000001/')).toThrow()   // 127.0.0.1 hex
  })
})

describe('web-fetch — htmlToText', () => {
  it('вырезает script/style и теги, декодирует базовые сущности', () => {
    const html = '<html><head><style>.a{color:red}</style><script>alert(1)</script></head><body><h1>Привет</h1><p>Мир &amp; текст</p></body></html>'
    const text = htmlToText(html)
    expect(text).toContain('Привет')
    expect(text).toContain('Мир & текст')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('<h1>')
  })
  it('схлопывает пустые строки', () => {
    const text = htmlToText('<div>a</div>\n\n\n\n<div>b</div>')
    expect(text).not.toMatch(/\n{3,}/)
  })
  it('незакрытый блочный тег НЕ отбрасывает остаток страницы (ре-ревью MEDIUM)', () => {
    const t = htmlToText('<p>Начало статьи.</p><svg><path d="M0 0"/>Хвост после битого svg. Важный вывод.')
    expect(t).toContain('Начало статьи')
    expect(t).toContain('Важный вывод')       // раньше терялось после break
  })
  it('корректно закрытый script/style всё ещё полностью вырезается', () => {
    const t = htmlToText('<p>до</p><script>alert(1)</script><p>после</p>')
    expect(t).not.toContain('alert')
    expect(t).toContain('до')
    expect(t).toContain('после')
  })
  it('не виснет и не квадратичен на враждебном входе (ReDoS-кап, ревью HIGH)', () => {
    const started = Date.now()
    expect(typeof htmlToText('<'.repeat(500_000))).toBe('string')          // млн `<` без `>`
    expect(typeof htmlToText('<script>'.repeat(60_000))).toBe('string')    // незакрытые script
    expect(typeof htmlToText('<!--'.repeat(60_000))).toBe('string')        // незакрытые комменты
    expect(Date.now() - started).toBeLessThan(4000)                        // ограниченно, не минуты
  })
})

describe('web-fetch — fetchUrl (инъекция fetch/lookup)', () => {
  const okLookup = async () => [{ address: '93.184.216.34', family: 4 }]

  it('успешный fetch → текст из HTML, обрезка по maxBytes', async () => {
    const fakeFetch = async () => new Response('<p>hello world</p>', {
      status: 200, headers: { 'content-type': 'text/html' }
    })
    const r = await fetchUrl('https://example.com', { fetchImpl: fakeFetch, lookupImpl: okLookup })
    expect(r.status).toBe(200)
    expect(r.text).toContain('hello world')
  })

  it('обрезка по maxBytes не даёт U+FFFD на границе многобайтного UTF-8 (ревью M1)', async () => {
    const bodyStr = 'я'.repeat(100) // 200 байт (по 2 на символ); maxBytes нечётный → граница внутри символа
    const fakeFetch = async () => new Response(bodyStr, { status: 200, headers: { 'content-type': 'text/plain' } })
    const r = await fetchUrl('https://example.com', { fetchImpl: fakeFetch, lookupImpl: okLookup, maxBytes: 51 })
    expect(r.truncated).toBe(true)
    expect(r.text).not.toContain('�') // неполный хвостовой код-поинт отброшен, не крякозябра
    expect(r.text).toContain('я')
  })

  it('DNS резолвится в приватный IP → блок (rebinding-защита)', async () => {
    const privLookup = async () => [{ address: '10.0.0.5', family: 4 }]
    const fakeFetch = async () => new Response('secret', { status: 200 })
    await expect(fetchUrl('https://evil.example', { fetchImpl: fakeFetch, lookupImpl: privLookup }))
      .rejects.toThrow()
  })

  it('редирект на приватный хост блокируется', async () => {
    let hop = 0
    const fakeFetch = async (input: string | URL) => {
      hop++
      const url = String(input)
      if (url.includes('start')) {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
      }
      return new Response('meta', { status: 200 })
    }
    await expect(fetchUrl('https://start.example', { fetchImpl: fakeFetch as typeof fetch, lookupImpl: okLookup }))
      .rejects.toThrow()
    expect(hop).toBe(1)  // второй хоп (приватный) не выполнен
  })

  it('слишком много редиректов → ошибка', async () => {
    const fakeFetch = async () => new Response(null, {
      status: 302, headers: { location: 'https://public-other.example/next' }
    })
    await expect(fetchUrl('https://a.example', {
      fetchImpl: fakeFetch, lookupImpl: okLookup, maxRedirects: 2
    })).rejects.toThrow(/редирект/i)
  })

  it('domainCheck блокирует хост до сети (web-policy)', async () => {
    let called = false
    const fakeFetch = async () => { called = true; return new Response('ok') }
    const deny = (host: string) => (host === 'evil.example' ? 'домен запрещён политикой' : null)
    await expect(fetchUrl('https://evil.example/x', { fetchImpl: fakeFetch, lookupImpl: okLookup, domainCheck: deny }))
      .rejects.toThrow(/политик/i)
    expect(called).toBe(false)
  })

  it('domainCheck блокирует РЕДИРЕКТ на запрещённый домен (per-hop)', async () => {
    let hop = 0
    const fakeFetch = async (input: string | URL) => {
      hop++
      if (String(input).includes('allowed.example')) {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })
      }
      return new Response('secret', { status: 200 })
    }
    const deny = (host: string) => (host === 'evil.example' ? 'домен запрещён политикой' : null)
    await expect(fetchUrl('https://allowed.example/start', { fetchImpl: fakeFetch as typeof fetch, lookupImpl: okLookup, domainCheck: deny }))
      .rejects.toThrow()
    expect(hop).toBe(1) // редирект-хоп на evil не выполнен
  })

  it('non-http схема в теле fetchUrl отвергается до сети', async () => {
    let called = false
    const fakeFetch = async () => { called = true; return new Response('x') }
    await expect(fetchUrl('file:///etc/passwd', { fetchImpl: fakeFetch, lookupImpl: okLookup }))
      .rejects.toThrow()
    expect(called).toBe(false)
  })
})
