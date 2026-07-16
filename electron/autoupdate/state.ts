import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { lockPath, statePath } from './paths'
import type { AutoUpdateState } from './types'
import { logAutoUpdate } from './log'

const LOCK_TTL_MS = 20 * 60 * 1000

export function nowState(patch: Omit<Partial<AutoUpdateState>, 'schemaVersion' | 'updatedAt'>): AutoUpdateState {
  const prev = readState()
  return {
    schemaVersion: 1,
    status: prev?.status ?? 'idle',
    updatedAt: Date.now(),
    ...prev,
    ...patch,
  }
}

/** Старше этого возраста tmp-файл заведомо осиротел: атомарная запись занимает миллисекунды. */
const TMP_ORPHAN_TTL_MS = 60 * 60 * 1000

/**
 * Подмести осиротевшие `<file>.<pid>.<ts>.tmp` от прерванных записей.
 *
 * Откуда берутся: writeJsonAtomic пишет tmp и делает rename. Если процесс умер МЕЖДУ этими
 * шагами (или rename не прошёл), tmp остаётся навсегда — чистить было некому. У Павла лежал
 * такой от 11.07. Функционально безвредно, но копится годами.
 *
 * Гард по возрасту (не по pid): чужая ЖИВАЯ запись длится миллисекунды, поэтому файл старше
 * часа не может принадлежать идущей прямо сейчас операции — снести его безопасно даже при
 * параллельных процессах. Best-effort: уборка мусора не смеет ронять запись состояния.
 */
function sweepOrphanTmp(path: string): void {
  try {
    const dir = dirname(path)
    const prefix = `${basename(path)}.`
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      const full = join(dir, name)
      try {
        if (now - statSync(full).mtimeMs > TMP_ORPHAN_TTL_MS) rmSync(full, { force: true })
      } catch { /* пропал сам — и хорошо */ }
    }
  } catch { /* каталога нет / нет прав — уборка не критична */ }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
  sweepOrphanTmp(path)
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim()
    if (!text) return null
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function readState(): AutoUpdateState | null {
  return readJson<AutoUpdateState>(statePath())
}

export function writeState(state: AutoUpdateState): AutoUpdateState {
  const prev = readState()
  const next = { ...state, schemaVersion: 1, updatedAt: Date.now() }
  logAutoUpdate('state.write', {
    from: prev?.status,
    to: next.status,
    version: next.version,
    payloadRoot: next.payloadRoot,
    percent: next.percent,
    step: next.step,
    error: next.error,
    errorCode: next.errorCode,
  })
  writeJsonAtomic(statePath(), next)
  return readState()!
}

export function resetState(): AutoUpdateState {
  return writeState({ schemaVersion: 1, status: 'idle', updatedAt: Date.now() })
}

function pidAlive(pid: number): boolean {
  if (!pid) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

interface LockFile { pid?: number; startedAt?: number; operation?: string; version?: string; token?: string }

/** Токен лока, которым владеет ЭТОТ процесс прямо сейчас (null — не владеем). */
let ownLockToken: string | null = null

/**
 * Продлить лок: «я жив и работаю».
 *
 * Зачем (ревью P0): TTL сравнивался со `startedAt`, который писался ОДИН раз. Загрузка 360 МБ
 * на канале РФ→GitHub идёт дольше 20 минут — это норма, не край. Значит лок протухал у ЖИВОЙ
 * РАБОТАЮЩЕЙ загрузки, `check()` его отбирал, своим `finally` удалял файл — и стартовала ВТОРАЯ
 * загрузка в тот же `.part`. Два писателя в append → каша → хеш не сходится → `.part` удаляется.
 * То есть фикс докачки без этого heartbeat стирал бы прогресс НАДЁЖНЕЕ исходного бага.
 *
 * Теперь TTL означает не «операция длится долго», а «владелец перестал подавать признаки жизни»
 * — ровно то, ради чего TTL и нужен. Зависший процесс лок всё так же теряет.
 */
export function touchLock(): void {
  if (!ownLockToken) return
  const path = lockPath()
  const lock = readJson<LockFile>(path)
  if (!lock || lock.token !== ownLockToken) return // лок уже не наш — молчим, не воруем обратно
  try { writeJsonAtomic(path, { ...lock, startedAt: Date.now() }) } catch { /* heartbeat не критичен */ }
}

export function acquireLock(operation: string, version?: string): () => void {
  const path = lockPath()
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const lock = readJson<LockFile>(path)
    const age = Date.now() - (lock?.startedAt ?? 0)
    if (lock?.pid && age < LOCK_TTL_MS && pidAlive(lock.pid)) {
      logAutoUpdate('lock.busy', { operation, version, lockedBy: lock })
      throw new Error(`AutoUpdate busy: ${lock.operation || 'unknown'}`)
    }
    logAutoUpdate('lock.steal_stale', { operation, version, staleLock: lock, ageMs: age })
    try { rmSync(path, { force: true }) } catch { /* ignore */ }
  }
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  ownLockToken = token
  writeJsonAtomic(path, { pid: process.pid, operation, version, startedAt: Date.now(), token })
  logAutoUpdate('lock.acquire', { operation, version })
  return () => {
    // Удаляем лок, ТОЛЬКО если он всё ещё наш. Иначе свой `finally` снесёт чужой живой лок
    // (ревью P0: так `check()` открывал дорогу второй параллельной загрузке).
    const current = readJson<LockFile>(path)
    if (current && current.token !== token) {
      logAutoUpdate('lock.release_skipped_not_owner', { operation, version, ownerNow: current.operation })
      if (ownLockToken === token) ownLockToken = null
      return
    }
    logAutoUpdate('lock.release', { operation, version })
    if (ownLockToken === token) ownLockToken = null
    try { rmSync(path, { force: true }) } catch { /* ignore */ }
  }
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
