/**
 * Per-domain web-политика для web_fetch — контроль, какие домены агенту вообще
 * можно фетчить (поверх гейта web_access и SSRF-периметра). Аналог Claude Code
 * `WebFetch(domain:...)`. Прямое усиление moat «контроль» + defense-in-depth:
 * даже при обходе SSRF-guard allowlist ограничивает досягаемость.
 *
 * Конфиг (JSON), опционален — нет файла = разрешено всё (обратная совместимость):
 *   ~/.verstak/web-policy.json        — user-scope
 *   {project}/.verstak/web-policy.json — project-scope (мерджится)
 * Формат: { "allow": ["python.org", "*.mozilla.org"], "deny": ["*.internal"] }
 * Семантика: deny > allow. deny матчит → блок. allow непуст и не матчит → блок
 * (allowlist-режим). allow пуст → всё разрешено (кроме deny).
 * Паттерн `example.com` матчит apex + субдомены; `*.example.com` — только субдомены.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface WebPolicy {
  allow: string[]
  deny: string[]
}

function domainMatches(pattern: string, host: string): boolean {
  // Нормализуем и паттерн: срезаем trailing dot (FQDN `evil.com.` резолвится как evil.com).
  const p = pattern.trim().toLowerCase().replace(/\.+$/, '')
  if (!p) return false
  if (p.startsWith('*.')) {
    const suf = p.slice(2)
    return suf.length > 0 && host.endsWith('.' + suf)
  }
  return host === p || host.endsWith('.' + p)
}

/** Разрешён ли хост политикой? deny > allow; пустой allow = всё (кроме deny). */
export function isHostAllowed(host: string, policy: WebPolicy): { allowed: boolean; reason?: string } {
  // Trailing dot (`evil.com.`) и скобки IPv6 нормализуем — иначе `evil.com.` обходил бы
  // deny для `evil.com`, хотя DNS резолвит их идентично.
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '')
  if (policy.deny.some(p => domainMatches(p, h))) {
    return { allowed: false, reason: `домен ${host} заблокирован deny-правилом web-политики` }
  }
  if (policy.allow.length > 0 && !policy.allow.some(p => domainMatches(p, h))) {
    return { allowed: false, reason: `домен ${host} не в allow-списке web-политики (~/.verstak/web-policy.json)` }
  }
  return { allowed: true }
}

/** Проверить домен URL по политике. Невалидный URL → блок. */
export function checkUrlDomain(url: string, policy: WebPolicy): { allowed: boolean; reason?: string } {
  let host: string
  try { host = new URL(url).hostname } catch { return { allowed: false, reason: `невалидный URL: ${url}` } }
  return isHostAllowed(host, policy)
}

function readPolicyFile(path: string): Partial<WebPolicy> | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    return j && typeof j === 'object' ? j as Partial<WebPolicy> : null
  } catch { return null }
}

/** Загрузить web-политику: user (~/.verstak) + project, мерджем. Нет файлов → пусто. */
export function loadWebPolicy(projectPath: string | null): WebPolicy {
  const merged: WebPolicy = { allow: [], deny: [] }
  const add = (p: Partial<WebPolicy> | null): void => {
    if (!p) return
    if (Array.isArray(p.allow)) merged.allow.push(...p.allow.filter(x => typeof x === 'string'))
    if (Array.isArray(p.deny)) merged.deny.push(...p.deny.filter(x => typeof x === 'string'))
  }
  add(readPolicyFile(join(homedir(), '.verstak', 'web-policy.json')))
  if (projectPath) add(readPolicyFile(join(projectPath, '.verstak', 'web-policy.json')))
  return merged
}
