/**
 * Secret scanner — two layers of defence against the AI accidentally
 * (or maliciously) exfiltrating credentials.
 *
 * 1. Path policy: certain paths are off-limits even if the user opened
 *    a project that contains them. We don't want the AI loading
 *    `.ssh/id_ed25519`, `.aws/credentials`, browser cookies, etc into
 *    model context where they could end up in completions or logs.
 *
 * 2. Content scanner: any text we hand to the AI (read_file, search
 *    results, command stdout) is run through a regex pass that
 *    replaces obvious credentials with `[REDACTED:type]`.
 *
 * The system layer is told the policy so it knows why files are blocked.
 */

const FORBIDDEN_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.npmrc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'authorized_keys',
  'known_hosts',
  'credentials',
  // 'config.json' removed — too broad, hits many legitimate project configs.
  // Specific cloud configs are covered by FORBIDDEN_DIRS (.aws, .config/gcloud).
  'cookies.json',
  'hh_cookies.json'
])

const FORBIDDEN_DIRS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
  '.azure',
  '.docker',
  '.kube'
])

const FORBIDDEN_EXTENSIONS = new Set([
  '.key',
  '.pem',
  '.p12',
  '.pfx',
  '.crt',
  '.cer',
  '.jks',
  '.keystore'
])

/** True when the relative path (POSIX-style, no leading slash) looks like a secret store. */
export function isForbiddenPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').toLowerCase()
  const parts = norm.split('/').filter(Boolean)
  const basename = parts[parts.length - 1] ?? ''
  if (FORBIDDEN_BASENAMES.has(basename)) return true
  // Any dir in the path matching a forbidden dir
  for (const p of parts.slice(0, -1)) {
    if (FORBIDDEN_DIRS.has(p)) return true
  }
  // Composite (e.g. ".config/gcloud") — match against trailing path segments
  for (const forbidden of FORBIDDEN_DIRS) {
    if (forbidden.includes('/') && norm.includes('/' + forbidden + '/')) return true
    if (forbidden.includes('/') && norm.startsWith(forbidden + '/')) return true
  }
  const dotIdx = basename.lastIndexOf('.')
  if (dotIdx > 0) {
    const ext = basename.slice(dotIdx)
    if (FORBIDDEN_EXTENSIONS.has(ext)) return true
  }
  // Generic env files with extra suffix (.env.staging, .env.test, etc)
  if (basename.startsWith('.env.') || basename.startsWith('.env')) return true
  // creds*.json / credentials*.json — сервис-аккаунты Google/cloud, API-ключи.
  // Модель безопасности и CLAUDE.md прямо обещают их блокировку, но фиксированный
  // FORBIDDEN_BASENAMES не ловил `creds_google.json` и т.п. (аудит B1).
  if (/^(creds|credentials).*\.json$/.test(basename)) return true
  return false
}

interface SecretPattern {
  name: string
  re: RegExp
}

const PATTERNS: SecretPattern[] = [
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // AWS secret access key: 40 base64-ish chars. Require a contextual hint
  // (key=, secret=, aws_, AWS_) to avoid false-positives on SHA-1 hashes,
  // base64 blobs, content-hashes, etc. that share the character set.
  { name: 'aws-secret', re: /(?:aws[_-]?secret|secret[_-]?access[_-]?key|aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi },
  { name: 'github-token', re: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{30,}\b/g },
  { name: 'google-api', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'stripe-key', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----(?:[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----|[\s\S]*)/g },
  // 1C-style basic auth in URLs (http://user:pass@host)
  { name: 'http-basic-auth', re: /\b(https?:\/\/)[^\s/:]+:[^\s/@]+@/g },
  // Аудит M1: RU/TG/Yandex токены. Раньше PATTERNS знал только западные сервисы —
  // ключи 22 новых RU-коннекторов утекали бы в чат/контекст (а многие API
  // отражают auth-параметр в теле/ошибке). Distinctive-prefix токены:
  { name: 'vk-token', re: /\bvk1\.a\.[A-Za-z0-9_-]{30,}/g },
  { name: 'yandex-oauth', re: /\by0_[A-Za-z0-9_-]{20,}\b/g },
  // Telegram bot token: <digits>:<35 base64url> — формат отличимый, риск ложных мал.
  { name: 'telegram-bot-token', re: /\b\d{6,12}:[A-Za-z0-9_-]{35}\b/g },
  // Generic auth keyword → value. Ловит DaData (X-Secret/Token), Контур.Фокус
  // (api_key=<uuid>), GigaChat/OAuth (client_secret), Bearer-токены. Только при
  // явном auth-ключевом слове рядом — иначе UUID/хеши из легитимных ответов не
  // редактируем (см. спец-обработку в scanText: гасится лишь сам value).
  { name: 'auth-keyword-value', re: /\b(authorization|x-secret|x-api-key|api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key)\b\s*[:=]\s*["']?(?:bearer\s+|token\s+)?([A-Za-z0-9._\-+/]{16,})/gi }
]

export interface ScanResult {
  /** Text with secrets replaced by `[REDACTED:<type>]`. */
  redacted: string
  /** Names of patterns that fired (deduplicated). */
  hits: string[]
}

/** Имена query-параметров, чьи значения — секреты. Редактируем ПО ИМЕНИ
 *  (проактивно), дополняя value-based scanText: опаковые токены/UUID в ?token=/
 *  ?key=/?secret= не матчат форматные паттерны, но имя параметра выдаёт секрет.
 *  (Ревью 23.06 vs OpenClaw redact-sensitive-url.) */
const SENSITIVE_URL_PARAM = /^(token|token[_-]?id|api[_-]?(?:key|token)|apikey|key|secret|bearer|authorization|auth|password|passwd|pwd|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|credentials?|private[_-]?key|sig|signature|x-amz-signature|sas|session[_-]?id)$/i

function redactParams(params: URLSearchParams): boolean {
  let changed = false
  for (const name of [...params.keys()]) {
    if (SENSITIVE_URL_PARAM.test(name)) { params.set(name, '[REDACTED]'); changed = true }
  }
  return changed
}

/**
 * Редактирует значения чувствительных параметров в URL по ИМЕНИ — в query, в
 * #fragment (OAuth implicit-flow кладёт access_token туда), и пароль в userinfo
 * (user:pass@host). Возвращает url без изменений если не URL или нет секретов.
 * Применяется к `url`, который коннектор возвращает модели, чтобы токен не утёк
 * в контекст (value-based scanText опаковые значения не ловит). Ревью 23.06.
 */
export function redactUrlSecrets(url: string): string {
  try {
    const u = new URL(url)
    let changed = redactParams(u.searchParams)
    if (u.hash.length > 1) {
      const frag = new URLSearchParams(u.hash.slice(1))
      if (redactParams(frag)) { u.hash = '#' + frag.toString(); changed = true }
    }
    if (u.password) { u.password = '[REDACTED]'; changed = true }
    return changed ? u.toString() : url
  } catch {
    return url
  }
}

/** Scan text and return a redacted copy + names of patterns that matched. */
export function scanText(input: string): ScanResult {
  if (!input) return { redacted: input, hits: [] }
  let out = input
  const hitSet = new Set<string>()
  for (const { name, re } of PATTERNS) {
    if (re.test(out)) {
      hitSet.add(name)
      // Reset lastIndex (global regex state) and replace
      re.lastIndex = 0
      out = out.replace(re, (m) => {
        if (name === 'http-basic-auth') return m.replace(/(https?:\/\/)[^@]+@/, '$1[REDACTED:basic-auth]@')
        // auth-keyword-value: оставляем ключевое слово/разделитель, гасим только
        // сам секрет (он в конце совпадения после auth-ключа).
        if (name === 'auth-keyword-value') return m.replace(/([A-Za-z0-9._\-+/]{16,})$/, '[REDACTED:auth-value]')
        return `[REDACTED:${name}]`
      })
    }
    re.lastIndex = 0
  }
  return { redacted: out, hits: [...hitSet] }
}
