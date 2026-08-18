import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { redactForDisplay } from './ai/secret-scanner'

// Headless-контур (Этап 1а, разведка 04.08 §1): этот модуль
// импортируют runner-api/runner-plain, поэтому он обязан грузиться в чистом Node без
// electron. app.getPath берём ЛЕНИВО через createRequire: в headless require('electron')
// либо кидает (пакета нет), либо отдаёт строку-путь к бинарю — оба случая уходят в
// фолбэк. ipcMain-регистрация вынесена в runtime-log-ipc.ts тем же движением.
const nodeRequire = createRequire(import.meta.url)

const MAX_LOG_BYTES = 10 * 1024 * 1024
const RETENTION_DAYS = 14
const REDACT_KEY = /api[_-]?key|token|secret|password|authorization|cookie|credential/i

type LogLevel = 'info' | 'warn' | 'error'
type LogData = Record<string, unknown>

let configuredBaseDir: string | null = null

/** Явная конфигурация каталога логов (headless-хост, тест-сетап). Побеждает electron-путь.
 *  null — СНЯТЬ конфигурацию (вернуться к electron/APPDATA-фолбэку): нужно тестам, которые
 *  проверяют сам фолбэк, когда глобальный тест-сетап уже перенаправил лог во временный каталог. */
export function configureRuntimeLogDir(dir: string | null): void {
  configuredBaseDir = dir
}

function electronLogsDir(): string | null {
  try {
    const electron = nodeRequire('electron') as { app?: { getPath: (name: string) => string } } | string
    if (typeof electron === 'string' || !electron?.app) return null
    return join(electron.app.getPath('userData'), 'logs')
  } catch {
    return null
  }
}

function baseDir(): string {
  if (configuredBaseDir) return configuredBaseDir
  return electronLogsDir() ?? join(process.env.APPDATA || process.cwd(), 'Verstak', 'logs')
}

export function runtimeLogsDir(): string {
  return baseDir()
}

function logFile(level: LogLevel): string {
  return join(baseDir(), level === 'error' ? 'errors.jsonl' : 'runtime.jsonl')
}

// export для security-теста (1.9.8 #6): редакция значений, не только по имени ключа.
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[MaxDepth]'
  if (value == null) return value
  if (value instanceof Error) {
    return {
      name: value.name,
      // 1.9.8 #6: message/stack могут нести токены (напр. в тексте ошибки API) → редактируем.
      message: redactForDisplay(value.message),
      stack: typeof value.stack === 'string' ? redactForDisplay(value.stack.slice(0, 4000)) : undefined
    }
  }
  if (typeof value === 'string') {
    // 1.9.8 #6: раньше строковые значения только обрезались — секрет под НЕ-секрет
    // ключом (grok stderr под 'stderr', сообщения) утекал сырым. Теперь redactForDisplay.
    const truncated = value.length > 2000 ? `${value.slice(0, 2000)}...[truncated ${value.length}]` : value
    return redactForDisplay(truncated)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 50).map(v => sanitize(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY.test(key) ? '[redacted]' : sanitize(child, depth + 1)
    }
    return out
  }
  return String(value)
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_LOG_BYTES) return
    const rotated = `${file}.1`
    if (existsSync(rotated)) unlinkSync(rotated)
    renameSync(file, rotated)
  } catch {
    // Logging must never break the app.
  }
}

function cleanupOldLogs(dir: string): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    for (const name of readdirSync(dir)) {
      if (!/\.jsonl(\.\d+)?$/.test(name)) continue
      const file = join(dir, name)
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
    }
  } catch {
    // Best-effort retention.
  }
}

export function logRuntime(event: string, data: LogData = {}, level: LogLevel = 'info'): void {
  try {
    const dir = baseDir()
    mkdirSync(dir, { recursive: true })
    cleanupOldLogs(dir)
    const file = logFile(level)
    rotateIfNeeded(file)
    const line = {
      ts: new Date().toISOString(),
      pid: process.pid,
      level,
      event,
      ...(sanitize(data) as LogData)
    }
    appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
  } catch {
    // Logging must never break runtime flow.
  }
}

export function logRuntimeError(event: string, error: unknown, data: LogData = {}): void {
  logRuntime(event, { ...data, error }, 'error')
}

/** Пути лог-файлов для UI-вкладки логов; IPC-обёртка живёт в runtime-log-ipc.ts. */
export function runtimeLogFiles(): { dir: string; runtime: string; errors: string } {
  return {
    dir: runtimeLogsDir(),
    runtime: logFile('info'),
    errors: logFile('error')
  }
}
