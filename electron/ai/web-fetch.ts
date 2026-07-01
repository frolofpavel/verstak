/**
 * web_fetch движок — безопасное получение веб-страницы по URL для агента.
 *
 * Позиционирование Verstak = контроль: веб-доступ агента ВЫКЛючен по умолчанию
 * (гейт web_access в ai.ts) и жёстко ограждён от SSRF здесь:
 *   - только http/https;
 *   - литеральные приватные/loopback/link-local хосты блокируются (в т.ч. cloud
 *     metadata 169.254.169.254);
 *   - DNS-резолв каждого хоста проверяется на приватные адреса (anti-rebinding);
 *   - редиректы следуются вручную, КАЖДЫЙ хоп ре-валидируется (схема + хост);
 *   - лимит байт + таймаут, чтобы не раздувать контекст и не висеть.
 *
 * Остаточный риск: TOCTOU между DNS-проверкой и реальным connect'ом (полная
 * защита требовала бы pin'а IP через кастомный http.Agent) — принятый лимит для
 * десктоп-инструмента; порог для атаки поднят на порядок.
 */
import { lookup as dnsLookup } from 'node:dns/promises'

const DEFAULT_UA = 'Verstak/1.0 (+https://github.com/frolofpavel/verstak) web_fetch'
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function ipv4Private(a: number, b: number): boolean {
  if (a === 127) return true              // 127.0.0.0/8 loopback
  if (a === 10) return true               // 10.0.0.0/8 private
  if (a === 0) return true                // 0.0.0.0/8 "this"
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (+ metadata)
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

/** Строгий dotted-quad → 32-битный int, иначе null. */
function parseDottedV4(host: string): number | null {
  const m = IPV4_RE.exec(host)
  if (!m) return null
  const octs = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (octs.some(o => o > 255)) return null
  return ((octs[0] << 24) | (octs[1] << 16) | (octs[2] << 8) | octs[3]) >>> 0
}

/** 32-битный IPv4 приватный/loopback/link-local? */
function ipv4IntBlocked(v: number): boolean {
  return ipv4Private((v >>> 24) & 0xff, (v >>> 16) & 0xff)
}

/** Литеральный IPv4? → true/false заблокирован; null если это не IPv4-литерал.
 *  decimal/hex/octal-формы (`2130706433`, `0x7f000001`) сюда не попадают — их
 *  нормализует `new URL` в dotted-quad ещё до isBlockedHost. */
function checkIpv4(host: string): boolean | null {
  const v = parseDottedV4(host)
  return v === null ? null : ipv4IntBlocked(v)
}

/** Разобрать IPv6-литерал в 8 hextet-групп (чисел). Поддержка `::`-сжатия и
 *  встроенного dotted-IPv4 хвоста. null — не IPv6. Ревью CRITICAL (C1): разбираем
 *  ЧИСЛЕННО, а не regex по строке — иначе `new URL` отдаёт mapped-адрес в hex-форме
 *  (`::ffff:a9fe:a9fe`), которую строковый матчер dotted-decimal пропускал → SSRF. */
function parseIpv6(host: string): number[] | null {
  let h = host.split('%')[0] // отбросить zone-id (%eth0)
  if (!h.includes(':')) return null
  h = h.toLowerCase()
  const dbl = h.split('::')
  if (dbl.length > 2) return null
  const parseSide = (s: string): number[] | null => {
    if (s === '') return []
    const parts = s.split(':')
    const groups: number[] = []
    for (const p of parts) {
      if (p.includes('.')) {
        const v4 = parseDottedV4(p)
        if (v4 === null) return null
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff)
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(p)) return null
        groups.push(parseInt(p, 16))
      }
    }
    return groups
  }
  const head = parseSide(dbl[0]); if (head === null) return null
  let groups: number[]
  if (dbl.length === 2) {
    const tail = parseSide(dbl[1]); if (tail === null) return null
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    groups = [...head, ...Array(missing).fill(0), ...tail]
  } else {
    groups = head
  }
  return groups.length === 8 ? groups : null
}

/** Группы IPv6 → заблокирован? Ловит loopback/ULA/link-local + ЛЮБОЙ встроенный
 *  IPv4 (mapped ::ffff:*, IPv4-compat ::*, NAT64 64:ff9b::*) с приватным адресом. */
function ipv6GroupsBlocked(g: number[]): boolean {
  if ((g[0] & 0xfe00) === 0xfc00) return true       // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true        // fe80::/10 link-local
  const embedded = (): number => ((g[6] << 16) | g[7]) >>> 0
  // ::ffff:0:0/96 (mapped) и ::/96 (IPv4-compat, включая ::1/:: /::7f00:1 и т.п.)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    if (g[5] === 0xffff || g[5] === 0) return ipv4IntBlocked(embedded())
  }
  // 64:ff9b::/96 (NAT64 well-known) → тот же встроенный IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return ipv4IntBlocked(embedded())
  }
  return false
}

/** Литеральный IPv6? → true/false заблокирован; null если это не IPv6-литерал. */
function checkIpv6(host: string): boolean | null {
  const g = parseIpv6(host)
  return g === null ? null : ipv6GroupsBlocked(g)
}

/** Хост запрещён? Возвращает причину (строка) или null если разрешён.
 *  Работает по литералу — БЕЗ DNS (сеть проверяется отдельно в fetchUrl). */
export function isBlockedHost(hostname: string): string | null {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host) return 'пустой хост'
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost'
  if (host.endsWith('.local')) return 'mDNS .local'
  if (checkIpv4(host) === true) return `приватный/loopback IPv4 (${host})`
  if (checkIpv6(host) === true) return `приватный/loopback IPv6 (${host})`
  return null
}

/** Числовой резолв (из DNS) указывает на приватный/loopback адрес? */
export function isBlockedIp(ip: string): boolean {
  let host = ip.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const v4 = checkIpv4(host)
  if (v4 !== null) return v4
  const v6 = checkIpv6(host)
  if (v6 !== null) return v6
  return false
}

/** Проверить URL: валидность + схема http/https + не приватный литеральный хост.
 *  Бросает Error с человекочитаемой причиной. Возвращает распарсенный URL. */
export function assertUrlAllowed(rawUrl: string): URL {
  let u: URL
  try { u = new URL(rawUrl) } catch { throw new Error(`невалидный URL: ${rawUrl}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`схема "${u.protocol}" запрещена — только http/https`)
  }
  const reason = isBlockedHost(u.hostname)
  if (reason) throw new Error(`доступ к хосту запрещён: ${reason}`)
  return u
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»'
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    const rep = ENTITIES[body.toLowerCase()]
    return rep !== undefined ? rep : m
  })
}

// Ревью HIGH (ReDoS): htmlToText зовётся синхронно на всём теле (до 2 МБ) ДО обрезки
// вывода — а abort/timeout не прерывают синхронный regex. Жадный `<[^>]+>` и ленивые
// `[\s\S]*?<\/tag>` на враждебном входе (миллион `<` или незакрытых `<script`) дают
// O(n²) → минуты фриза event-loop. Защита: (1) кап входа; (2) удаление комментов и
// script/style — ЛИНЕЙНЫМ проходом через indexOf, а не ленивым regex; (3) линейный
// `[^<>]*` вместо жадного `[^>]+` для остальных тегов.
const MAX_HTML_INPUT = 120_000
const BLOCK_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'head']

/** Линейно вырезать `<!-- ... -->`. indexOf партиционирует строку → O(n). */
function stripComments(html: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const s = html.indexOf('<!--', i)
    if (s === -1) { out += html.slice(i); break }
    out += html.slice(i, s)
    const e = html.indexOf('-->', s + 4)
    if (e === -1) break // незакрытый коммент → отбрасываем остаток
    i = e + 3
  }
  return out
}

/** Линейно вырезать содержимое script/style/... вместе с тегами. Каждый `<` проверяем
 *  один раз; закрывающий тег ищем через indexOf. Итог O(n) даже на `<script>`×N. */
function stripBlocks(html: string): string {
  const lower = html.toLowerCase()
  const n = html.length
  // Ре-ревью MEDIUM: незакрытый блочный тег (битый `<svg>`/`<head>` на реальной странице)
  // раньше отбрасывал ВЕСЬ остаток → тихая потеря тела фетча. Теперь при отсутствии
  // закрытия пропускаем только сам открывающий тег и продолжаем. Memo noClose держит
  // O(n): позиции растут → раз `</tag>` не найден от lt, дальше его тоже нет (не ищем снова).
  const noClose = new Set<string>()
  let out = ''
  let i = 0
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) { out += html.slice(i); break }
    out += html.slice(i, lt)
    let matched = ''
    for (const t of BLOCK_TAGS) {
      if (lower.startsWith(t, lt + 1)) {
        const after = lower[lt + 1 + t.length]
        if (after === undefined || after === '>' || after === '/' || after === ' ' || after === '\t' || after === '\n' || after === '\r') { matched = t; break }
      }
    }
    if (!matched) { out += '<'; i = lt + 1; continue }
    out += ' '
    const close = noClose.has(matched) ? -1 : lower.indexOf('</' + matched, lt)
    if (close === -1) {
      // нет закрытия — пропускаем ТОЛЬКО открывающий тег, остаток обрабатываем обычно
      noClose.add(matched)
      const gt = html.indexOf('>', lt)
      i = gt === -1 ? n : gt + 1
      continue
    }
    const gt = html.indexOf('>', close)
    i = gt === -1 ? n : gt + 1
  }
  return out
}

/** HTML → читаемый текст: вырезает script/style/комменты, теги → пробелы,
 *  блочные теги → перевод строки, декодирует базовые сущности, схлопывает пустоту. */
export function htmlToText(html: string): string {
  let t = html.length > MAX_HTML_INPUT ? html.slice(0, MAX_HTML_INPUT) : html
  t = stripComments(t)
  t = stripBlocks(t)
  t = t.replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/table|\/section|\/article)\s*\/?>/gi, '\n')
  t = t.replace(/<[^<>]*>/g, ' ')
  t = decodeEntities(t)
  t = t.replace(/[ \t\f\v\r]+/g, ' ')
  t = t.replace(/ *\n */g, '\n')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

export interface FetchUrlResult {
  finalUrl: string
  status: number
  contentType: string
  text: string
  truncated: boolean
}

export interface FetchUrlOpts {
  signal?: AbortSignal
  maxBytes?: number
  maxRedirects?: number
  timeoutMs?: number
  /** Не конвертировать HTML→текст: вернуть тело как есть (для парсинга разметки,
   *  напр. web_search над html.duckduckgo.com). SSRF/лимиты работают так же. */
  raw?: boolean
  /** Per-domain политика: проверяется на КАЖДОМ хопе (вкл. редиректы). Возвращает
   *  причину блокировки или null (разрешено). Напр. allow/deny доменов из web-policy. */
  domainCheck?: (host: string) => string | null
  /** Инъекция для тестов. По умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
  /** Инъекция для тестов. По умолчанию node:dns lookup(all). */
  lookupImpl?: (host: string) => Promise<Array<{ address: string; family: number }>>
}

function isHtmlType(ct: string): boolean {
  const c = ct.toLowerCase()
  return c.includes('html') || c.includes('xml')
}

async function readCapped(resp: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const body = resp.body as ReadableStream<Uint8Array> | null
  if (!body || typeof body.getReader !== 'function') {
    const t = await resp.text()
    return t.length > maxBytes ? { body: t.slice(0, maxBytes), truncated: true } : { body: t, truncated: false }
  }
  const reader = body.getReader()
  // Ревью M1: стриминговый TextDecoder — многобайтный UTF-8 на границе maxBytes не бьётся
  // в U+FFFD. При обрезке НЕ флашим декодер → неполный хвостовой код-поинт отбрасывается
  // чисто, без крякозябр. Байтовый лимит соблюдаем, обрезая пересекающий чанк.
  const decoder = new TextDecoder('utf-8')
  let out = ''
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value && value.length) {
      let chunk = value
      if (total + chunk.length > maxBytes) {
        chunk = chunk.subarray(0, maxBytes - total)
        truncated = true
      }
      total += chunk.length
      out += decoder.decode(chunk, { stream: true })
      if (truncated) { try { await reader.cancel() } catch { /* ignore */ } break }
    }
  }
  if (!truncated) out += decoder.decode() // flush (только когда дочитали до конца)
  return { body: out, truncated }
}

/** Anti-rebinding: резолвим имя и убеждаемся, что ни один адрес не приватный.
 *  Литеральные IP уже проверены assertUrlAllowed — их не резолвим. */
async function guardDns(hostname: string, lookupImpl: NonNullable<FetchUrlOpts['lookupImpl']>): Promise<void> {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (checkIpv4(host) !== null || checkIpv6(host) !== null) return // литерал уже проверен
  let addrs: Array<{ address: string; family: number }>
  try { addrs = await lookupImpl(host) } catch { throw new Error(`DNS не разрешил хост: ${host}`) }
  if (!addrs.length) throw new Error(`DNS вернул пусто для: ${host}`)
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error(`хост ${host} резолвится в приватный адрес ${a.address} — заблокировано`)
  }
}

/** Безопасно получить страницу. Следует редиректам вручную, ре-валидируя каждый
 *  хоп. Бросает Error при блокировке/таймауте/превышении редиректов. */
export async function fetchUrl(rawUrl: string, opts: FetchUrlOpts = {}): Promise<FetchUrlResult> {
  const maxBytes = opts.maxBytes ?? 2_000_000
  const maxRedirects = opts.maxRedirects ?? 5
  const timeoutMs = opts.timeoutMs ?? 15_000
  const doFetch = opts.fetchImpl ?? fetch
  const doLookup = opts.lookupImpl ?? ((h: string) => dnsLookup(h, { all: true }))

  let current = assertUrlAllowed(rawUrl)
  let redirects = 0

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onExtAbort = () => ctrl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort()
    else opts.signal.addEventListener('abort', onExtAbort, { once: true })
  }
  try {
    for (;;) {
      // Per-domain политика (web-policy) — до DNS/сети, на каждом хопе редиректа.
      if (opts.domainCheck) {
        const reason = opts.domainCheck(current.hostname.replace(/^\[/, '').replace(/\]$/, ''))
        if (reason) throw new Error(reason)
      }
      await guardDns(current.hostname, doLookup)
      const resp = await doFetch(current.toString(), {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': DEFAULT_UA, accept: 'text/*, application/json;q=0.9, */*;q=0.5' }
      })
      const loc = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null
      if (loc) {
        if (redirects >= maxRedirects) throw new Error(`слишком много редиректов (> ${maxRedirects})`)
        redirects++
        current = assertUrlAllowed(new URL(loc, current).toString()) // ре-валидация хопа
        continue
      }
      const contentType = resp.headers.get('content-type') ?? ''
      const { body, truncated } = await readCapped(resp, maxBytes)
      const text = opts.raw ? body : (isHtmlType(contentType) ? htmlToText(body) : body)
      return { finalUrl: current.toString(), status: resp.status, contentType, text, truncated }
    }
  } finally {
    clearTimeout(timer)
    if (opts.signal) opts.signal.removeEventListener('abort', onExtAbort)
  }
}
