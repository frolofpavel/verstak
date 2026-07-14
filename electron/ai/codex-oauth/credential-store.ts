// Codex OAuth credential store — чтение ~/.codex/auth.json, проактивный refresh,
// atomic write. Обёртка сети/fs поверх чистых (tested) модулей auth/refresh.
//
// ВАЖНО (срез 6, §2.3): store создаётся ЗАНОВО на каждый ai:send (новый провайдер на
// ход), поэтому состояние refresh'а обязано жить НА УРОВНЕ МОДУЛЯ, ключом по пути к
// auth.json — иначе:
//  · single-flight не работает между чатами → два параллельных send'а делают два
//    refresh'а, второй получает refresh_token_reused (ротация одноразовая);
//  · «сессия на токенах в памяти» после сбоя записи не переживает следующий ход.

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { extractAccountId, shouldRefreshToken, type CodexAuthFile } from './auth'
import { buildRefreshRequest, applyRefreshResponse } from './refresh'

export interface CodexCreds {
  accessToken: string
  accountId: string
}

/** Свежий auth, который НЕ удалось записать на диск. Источник истины, пока запись не пройдёт. */
interface Unpersisted {
  auth: CodexAuthFile
  /** refresh_token, который мы ИЗРАСХОДОВАЛИ (он же лежит в мёртвом файле на диске). */
  consumedRefresh: string
}

// Состояние по пути к auth.json — переживает пересоздание store.
const inFlightByPath = new Map<string, Promise<CodexAuthFile>>()
const unpersistedByPath = new Map<string, Unpersisted>()
const persistWarningByPath = new Map<string, string>()

function authFilePath(codexHome?: string | null): string {
  const home = codexHome || process.env.CODEX_HOME || join(homedir(), '.codex')
  return join(home, 'auth.json')
}

function readAuth(path: string): CodexAuthFile {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as CodexAuthFile
  if (!raw.tokens?.access_token) throw new Error('codex auth.json: нет tokens.access_token — залогинься (codex login)')
  return raw
}

/**
 * Atomic write: временный файл рядом + rename (не рвём auth.json при краше).
 * КРИТИЧНО: во временном файле лежит ЖИВОЙ токен. Если упал любой из двух шагов
 * (особенно rename — на Windows частый транзиент от антивируса/индексатора), tmp
 * обязан быть удалён, иначе секрет навсегда осиротеет рядом с auth.json.
 */
function writeAuthAtomic(path: string, auth: CodexAuthFile): void {
  const tmp = `${path}.verstak-tmp`
  try {
    writeFileSync(tmp, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort: удаление tmp не должно маскировать исходную ошибку */ }
    throw e
  }
}

/** Персист с одной повторной попыткой: сбой записи на Windows чаще всего транзиентный. */
async function persistWithRetry(path: string, auth: CodexAuthFile): Promise<void> {
  try {
    writeAuthAtomic(path, auth)
    return
  } catch {
    await new Promise(r => setTimeout(r, 50))
  }
  writeAuthAtomic(path, auth) // вторая попытка; если снова упала — ошибка идёт наружу
}

/**
 * Credential store. При каждом getCredentials перечитывает auth.json (другой процесс
 * мог обновить токен), рефрешит если access_token близок к exp, single-flight — общий
 * для всех store'ов одного пути.
 */
export function createCodexCredentialStore(codexHome?: string | null) {
  const path = authFilePath(codexHome)

  /**
   * Актуальный auth: если прошлый refresh не удалось персистнуть, на диске лежит
   * МЁРТВЫЙ (израсходованный) refresh_token — источник истины тогда в памяти.
   * Но если файл на диске с тех пор ИЗМЕНИЛСЯ (юзер сделал `codex login` заново или
   * refresh сделал сам codex CLI), диск снова главный, а память сбрасывается.
   */
  function currentAuth(): CodexAuthFile {
    const pending = unpersistedByPath.get(path)
    if (!existsSync(path)) {
      if (pending) return pending.auth
      throw new Error(`codex auth.json не найден (${path}) — залогинься: codex login`)
    }
    const onDisk = readAuth(path)
    if (!pending) return onDisk
    if (onDisk.tokens.refresh_token === pending.consumedRefresh) {
      return pending.auth // диск всё ещё содержит мёртвый токен → живём из памяти
    }
    // Диск обновился со стороны (re-login) — он новее нашей памяти.
    unpersistedByPath.delete(path)
    persistWarningByPath.delete(path)
    return onDisk
  }

  async function refresh(auth: CodexAuthFile): Promise<CodexAuthFile> {
    const existing = inFlightByPath.get(path)
    if (existing) return existing // single-flight МЕЖДУ store'ами (= между чатами)

    const p = (async () => {
      try {
        const consumedRefresh = auth.tokens.refresh_token
        const { url, body } = buildRefreshRequest(consumedRefresh)
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
          await persistWithRetry(path, next)
          unpersistedByPath.delete(path)
          persistWarningByPath.delete(path)
        } catch (e) {
          // Refresh на сервере УЖЕ произошёл: consumedRefresh ротирован и мёртв, а на
          // диске лежит именно он. Уронить операцию = лок-аут. Поэтому новый auth
          // становится источником истины В ПАМЯТИ (переживает пересоздание store на
          // следующий ход), файл на диске не тронут, а предупреждение забирает провайдер
          // и показывает в UI. В сообщение попадает только путь и fs-ошибка — токены никогда.
          const msg = e instanceof Error ? e.message : String(e)
          unpersistedByPath.set(path, { auth: next, consumedRefresh })
          persistWarningByPath.set(path, `Не удалось сохранить обновлённый Codex-токен (${path}): ${msg}. ` +
            'Сессия продолжает работать, но после перезапуска приложения может потребоваться повторный «codex login».')
        }
        return next
      } finally {
        inFlightByPath.delete(path)
      }
    })()
    inFlightByPath.set(path, p)
    return p
  }

  return {
    path,
    async getCredentials(): Promise<CodexCreds> {
      let auth = currentAuth()
      if (shouldRefreshToken(auth.tokens.access_token, Date.now())) {
        auth = await refresh(auth)
      }
      const accountId = extractAccountId(auth)
      if (!accountId) throw new Error('codex auth.json: не извлёк account_id')
      return { accessToken: auth.tokens.access_token, accountId }
    },
    /** Реактивный refresh на 401: перечитать (мог обновить другой процесс), иначе refresh. */
    async forceRefresh(): Promise<CodexCreds> {
      const auth = await refresh(currentAuth())
      const accountId = extractAccountId(auth)
      if (!accountId) throw new Error('codex auth.json: не извлёк account_id после refresh')
      return { accessToken: auth.tokens.access_token, accountId }
    },
    /** Забрать (и погасить) предупреждение о несохранённом токене — провайдер покажет его в UI. */
    takePersistWarning(): string | null {
      const w = persistWarningByPath.get(path) ?? null
      if (w) persistWarningByPath.delete(path)
      return w
    },
  }
}

/** Только для тестов: сбросить модульное состояние между кейсами. */
export function __resetCodexCredentialStateForTests(): void {
  inFlightByPath.clear()
  unpersistedByPath.clear()
  persistWarningByPath.clear()
}
