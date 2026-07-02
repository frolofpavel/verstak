/**
 * SSRF-защита коннекторов: блокирует хосты, указывающие на служебные/внутренние
 * IP-диапазоны. Коннектор ходит на юзер-URL и следует редиректам → без проверки
 * можно увести запрос на cloud-metadata (169.254.169.254) или во внутреннюю сеть.
 * (Security, ревью 23.06 #8 — паритет с OpenClaw net-policy, но без зависимости
 * ipaddr.js: детект через built-in net.isIP + ручная проверка диапазонов.)
 *
 * Два режима через allowLocalAndPrivate:
 *  - true  (сконфигурированная БАЗА): loopback/RFC1918 РАЗРЕШЕНЫ — http-коннектор
 *          документирован для «custom internal services» (юзер сам так настроил).
 *          Блокируются только no-legit диапазоны (link-local/metadata/multicast/
 *          reserved/this-network).
 *  - false (цель РЕДИРЕКТА): блокируется ВСЁ внутреннее — внешний API, редиректящий
 *          на 127.0.0.1/10.x/169.254 — почти наверняка атака, легитимной причины нет.
 */
import { isIPv4, isIPv6 } from 'net'
import { lookup as dnsLookup } from 'node:dns/promises'

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const o = [m[1], m[2], m[3], m[4]].map(Number)
  if (o.some(n => n > 255)) return null
  return ((o[0] * 2 ** 24) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0
}

function inRange(ip: number, base: string, prefix: number): boolean {
  const baseInt = ipv4ToInt(base)
  if (baseInt === null) return false
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (ip & mask) === (baseInt & mask)
}

function isBlockedIpv4(ip: string, allowLocalAndPrivate?: boolean): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return false
  // No-legit-use всегда:
  if (
    inRange(n, '0.0.0.0', 8) ||       // this-network
    inRange(n, '169.254.0.0', 16) ||  // link-local — ВСЕ cloud-metadata (AWS/GCP/Azure)
    inRange(n, '224.0.0.0', 4) ||     // multicast
    inRange(n, '240.0.0.0', 4) ||     // reserved (вкл. 255.255.255.255 broadcast)
    ip === '100.100.100.200'          // Alibaba metadata (в CGNAT-диапазоне)
  ) return true
  if (allowLocalAndPrivate) return false
  // Внутренние (блокируем только для редиректов):
  return (
    inRange(n, '127.0.0.0', 8) ||     // loopback
    inRange(n, '10.0.0.0', 8) ||      // private
    inRange(n, '172.16.0.0', 12) ||   // private
    inRange(n, '192.168.0.0', 16) ||  // private
    inRange(n, '100.64.0.0', 10)      // CGNAT
  )
}

function isBlockedIpv6(raw: string, allowLocalAndPrivate?: boolean): boolean {
  // .split('%')[0] — срезаем scope-id (RFC 4007: fe80::1%eth0), чтобы он не сбивал
  // парсинг первого хекстета (security-review 23.06).
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  // IPv4-mapped ::ffff:a.b.c.d → проверяем встроенный IPv4 в том же режиме.
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) return isBlockedIpv4(mapped[1], allowLocalAndPrivate)
  if (ip === '::') return true // unspecified — всегда
  const firstGroup = ip.split(':')[0]
  const h = firstGroup === '' ? 0 : parseInt(firstGroup, 16)
  if (!Number.isNaN(h)) {
    if (h >= 0xfe80 && h <= 0xfebf) return true // link-local fe80::/10 — всегда
    if (h >= 0xff00 && h <= 0xffff) return true // multicast ff00::/8 — всегда
    if (!allowLocalAndPrivate && h >= 0xfc00 && h <= 0xfdff) return true // ULA fc00::/7
  }
  if (!allowLocalAndPrivate && ip === '::1') return true // loopback
  return false
}

/**
 * true → хост запрещён (SSRF-риск). Доменные имена (не IP-литералы) пропускаются,
 * кроме явных metadata/localhost-имён: коннектор ходит на юзер-домены, DNS-rebinding
 * вне scope этого слоя.
 */
export function isBlockedHost(hostname: string, opts: { allowLocalAndPrivate?: boolean } = {}): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'metadata.google.internal') return true
  if (!opts.allowLocalAndPrivate && host === 'localhost') return true
  if (isIPv4(host)) return isBlockedIpv4(host, opts.allowLocalAndPrivate)
  if (isIPv6(host)) return isBlockedIpv6(host, opts.allowLocalAndPrivate)
  return false
}

/** Проверить резолвленный из DNS числовой IP (v4/v6) в том же режиме. */
export function isBlockedResolvedIp(ip: string, allowLocalAndPrivate?: boolean): boolean {
  if (isIPv4(ip)) return isBlockedIpv4(ip, allowLocalAndPrivate)
  if (isIPv6(ip)) return isBlockedIpv6(ip, allowLocalAndPrivate)
  return false
}

/**
 * Async SSRF-проверка хоста: литеральная (isBlockedHost) + DNS-резолв доменного ИМЕНИ
 * с проверкой КАЖДОГО адреса (anti-rebinding — паритет с guardDns в ai/web-fetch.ts).
 * Ревью MEDIUM: раньше коннекторный гейт резолв не делал → имя с A-записью в 169.254/10.x
 * проходило. Возвращает причину блокировки или null. lookupImpl инъектируется для тестов.
 */
export async function assertHostAllowed(
  hostname: string,
  opts: { allowLocalAndPrivate?: boolean; lookupImpl?: (h: string) => Promise<Array<{ address: string }>> } = {}
): Promise<string | null> {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (isBlockedHost(host, opts)) return `${hostname} — служебный/внутренний адрес`
  if (!host || isIPv4(host) || isIPv6(host)) return null // литерал уже проверен
  const doLookup = opts.lookupImpl ?? ((h: string) => dnsLookup(h, { all: true }))
  let addrs: Array<{ address: string }>
  try { addrs = await doLookup(host) } catch { return `${hostname} — DNS не разрешился` }
  for (const a of addrs) {
    if (isBlockedResolvedIp(a.address, opts.allowLocalAndPrivate)) {
      return `${hostname} резолвится в ${a.address} — внутренний адрес (заблокировано)`
    }
  }
  return null
}
