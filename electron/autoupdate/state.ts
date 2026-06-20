import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'
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

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
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

export function acquireLock(operation: string, version?: string): () => void {
  const path = lockPath()
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const lock = readJson<{ pid?: number; startedAt?: number; operation?: string }>(path)
    const age = Date.now() - (lock?.startedAt ?? 0)
    if (lock?.pid && age < LOCK_TTL_MS && pidAlive(lock.pid)) {
      logAutoUpdate('lock.busy', { operation, version, lockedBy: lock })
      throw new Error(`AutoUpdate busy: ${lock.operation || 'unknown'}`)
    }
    try { rmSync(path, { force: true }) } catch { /* ignore */ }
  }
  writeJsonAtomic(path, { pid: process.pid, operation, version, startedAt: Date.now() })
  logAutoUpdate('lock.acquire', { operation, version })
  return () => {
    logAutoUpdate('lock.release', { operation, version })
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
