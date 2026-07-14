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
  /**
   * refresh_token, который РЕАЛЬНО ЛЕЖИТ НА ДИСКЕ (мёртвый, израсходованный первым
   * неудачным персистом). Ре-ревью #1 (HIGH): раньше здесь хранился «последний
   * израсходованный» токен — при ВТОРОМ подряд сбое записи он уезжал вперёд, а диск
   * стоял на месте, и currentAuth() ошибочно принимал нетронутый диск за «новый логин»,
   * выбрасывал единственную живую копию токенов и брал мёртвый → лок-аут на 3-м ходу.
   * Ориентир обязан быть привязан к ДИСКУ и не двигаться при повторных сбоях.
   */
  diskRefresh: string
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
 * обязан исчезнуть, иначе секрет навсегда осиротеет рядом с auth.json.
 * Уборка двухступенчатая: удалить; если удалить не дают (файл держат) — хотя бы
 * ЗАТЕРЕТЬ содержимое, чтобы токен не остался читаемым на диске (ре-ревью #5).
 */
function writeAuthAtomic(path: string, auth: CodexAuthFile): void {
  const tmp = `${path}.verstak-tmp`
  try {
    writeFileSync(tmp, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      try { writeFileSync(tmp, '', { encoding: 'utf8', mode: 0o600 }) } catch { /* последний рубеж: больше сделать нечего */ }
    }
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
   * Актуальный auth. Если прошлый refresh не удалось персистнуть, на диске лежит
   * МЁРТВЫЙ (израсходованный) refresh_token — источник истины тогда в памяти. Память
   * сбрасывается в двух случаях: файл на диске изменился со стороны (re-login или
   * refresh самим codex CLI) либо файла нет вовсе (logout).
   */
  function currentAuth(): CodexAuthFile {
    const pending = unpersistedByPath.get(path)

    if (!existsSync(path)) {
      // Ре-ревью #2: файла нет = пользователь вышел (`codex logout`). Продолжать на
      // токенах СТАРОГО аккаунта из памяти нельзя — это чужая сессия. Забываем и честно
      // просим залогиниться. (Atomic write идёт через rename, файл не «мигает», поэтому
      // отсутствие — это именно logout, а не гонка записи.)
      unpersistedByPath.delete(path)
      persistWarningByPath.delete(path)
      throw new Error(`codex auth.json не найден (${path}) — залогинься: codex login`)
    }

    const onDisk = readAuth(path)
    if (!pending) return onDisk

    if (onDisk.tokens.refresh_token === pending.diskRefresh) {
      return pending.auth // на диске всё тот же мёртвый токен → живём из памяти
    }

    // Диск обновился со стороны — он новее памяти.
    unpersistedByPath.delete(path)
    persistWarningByPath.delete(path)
    return onDisk
  }

  async function refresh(auth: CodexAuthFile): Promise<CodexAuthFile> {
    const existing = inFlightByPath.get(path)
    if (existing) return existing // single-flight МЕЖДУ store'ами (= между чатами)

    const p = (async (): Promise<CodexAuthFile> => {
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
        // Refresh на сервере УЖЕ произошёл: consumedRefresh ротирован и мёртв, а на диске
        // лежит именно он. Уронить операцию = лок-аут. Поэтому новый auth становится
        // источником истины В ПАМЯТИ (переживает пересоздание store на следующий ход),
        // файл на диске не тронут, а предупреждение забирает провайдер и показывает в UI.
        // В сообщение попадает только путь и fs-ошибка — содержимое токенов никогда.
        const msg = e instanceof Error ? e.message : String(e)
        // Ориентир — то, что ЛЕЖИТ НА ДИСКЕ, и он НЕ двигается при повторных сбоях
        // (иначе currentAuth примет нетронутый диск за re-login → лок-аут, ре-ревью #1).
        const prev = unpersistedByPath.get(path)
        unpersistedByPath.set(path, { auth: next, diskRefresh: prev?.diskRefresh ?? consumedRefresh })
        persistWarningByPath.set(path, `Не удалось сохранить обновлённый Codex-токен (${path}): ${msg}. ` +
          'Сессия продолжает работать, но после перезапуска приложения может потребоваться повторный «codex login».')
      }
      return next
    })()

    inFlightByPath.set(path, p)
    // Ре-ревью #4: снимать in-flight ВНУТРИ (finally) нельзя — если fetch бросит
    // СИНХРОННО, finally отработает ДО set(), и в кэш ляжет уже отклонённый промис,
    // «отравляющий» все последующие refresh'и до перезапуска. Чистим строго ПОСЛЕ set,
    // микротаском. Оба обработчика возвращают undefined → производный промис резолвится
    // и не даёт unhandled rejection (исходный p обрабатывает вызывающий).
    const clear = (): void => { inFlightByPath.delete(path) }
    void p.then(clear, clear)
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
