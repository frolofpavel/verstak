// Codex OAuth credential store — чтение ~/.codex/auth.json, проактивный refresh,
// atomic write. Обёртка сети/fs поверх чистых (tested) модулей auth/refresh.
//
// Единственный владелец refresh-состояния в процессе: single-flight promise, чтобы
// параллельные send'ы не гонялись за ротирующимся refresh_token (ground truth D:
// два writer'а старой копии → refresh_token_reused/expired).

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { extractAccountId, shouldRefreshToken, type CodexAuthFile } from './auth'
import { buildRefreshRequest, applyRefreshResponse } from './refresh'

export interface CodexCreds {
  accessToken: string
  accountId: string
}

function authFilePath(codexHome?: string | null): string {
  const home = codexHome || process.env.CODEX_HOME || join(homedir(), '.codex')
  return join(home, 'auth.json')
}

function readAuth(path: string): CodexAuthFile {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as CodexAuthFile
  if (!raw.tokens?.access_token) throw new Error('codex auth.json: нет tokens.access_token — залогинься (codex login)')
  return raw
}

/** Atomic write: пишем во временный файл рядом и rename'им (не рвём auth.json при краше). */
function writeAuthAtomic(path: string, auth: CodexAuthFile): void {
  const tmp = `${path}.verstak-tmp`
  writeFileSync(tmp, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Credential store с single-flight refresh. Держит путь к auth.json; при каждом
 * getCredentials перечитывает файл (другой процесс мог обновить токен), рефрешит
 * если access_token близок к exp, и переиспользует один in-flight refresh.
 */
export function createCodexCredentialStore(codexHome?: string | null) {
  const path = authFilePath(codexHome)
  let inFlight: Promise<CodexAuthFile> | null = null

  async function refresh(auth: CodexAuthFile): Promise<CodexAuthFile> {
    // single-flight: параллельные вызовы ждут один refresh
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const { url, body } = buildRefreshRequest(auth.tokens.refresh_token)
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const t = await res.text().catch(() => '')
          throw new Error(`codex refresh HTTP ${res.status}: ${t.slice(0, 200)}`)
        }
        const resp = await res.json() as { id_token?: string; access_token?: string; refresh_token?: string }
        const next = applyRefreshResponse(auth, resp, new Date().toISOString())
        try {
          writeAuthAtomic(path, next)
        } catch (e) {
          // Срез 6 (§2.3): refresh на сервере УЖЕ произошёл — старый refresh_token
          // ротирован и мёртв. Уронить здесь всю операцию = лок-аут: следующий старт
          // перечитает с диска мёртвый токен и refresh больше не пройдёт. Поэтому
          // сессия продолжается на новых токенах В ПАМЯТИ, старый файл на диске не
          // трогаем (atomic write не успел заменить его), а сбой персиста сообщаем
          // громко — после перезапуска может потребоваться повторный `codex login`.
          // В сообщение попадает только путь и fs-ошибка, содержимое токенов — никогда.
          const msg = e instanceof Error ? e.message : String(e)
          console.warn(`[codex-oauth] не удалось сохранить обновлённый auth-state (${path}): ${msg}. ` +
            'Сессия продолжается на токенах в памяти; после перезапуска может потребоваться повторный `codex login`.')
        }
        return next
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  return {
    path,
    async getCredentials(): Promise<CodexCreds> {
      if (!existsSync(path)) throw new Error(`codex auth.json не найден (${path}) — залогинься: codex login`)
      let auth = readAuth(path)
      if (shouldRefreshToken(auth.tokens.access_token, Date.now())) {
        auth = await refresh(auth)
      }
      const accountId = extractAccountId(auth)
      if (!accountId) throw new Error('codex auth.json: не извлёк account_id')
      return { accessToken: auth.tokens.access_token, accountId }
    },
    /** Реактивный refresh на 401: перечитать (мог обновить другой процесс), иначе refresh. */
    async forceRefresh(): Promise<CodexCreds> {
      let auth = readAuth(path)
      auth = await refresh(auth)
      const accountId = extractAccountId(auth)
      if (!accountId) throw new Error('codex auth.json: не извлёк account_id после refresh')
      return { accessToken: auth.tokens.access_token, accountId }
    },
  }
}
