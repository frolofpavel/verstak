import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cleanGitEnvironment, redactSecrets } from '../contracts.mjs'

const DEFAULT_TIMEOUT_MS = 420_000
const MAX_BUFFER = 16 * 1024 * 1024

export function runProcess({ command, args, cwd, input = '', timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env }) {
  const startedAt = Date.now()
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    env: cleanRunnerEnvironment(env),
    windowsHide: true,
  })
  return {
    status: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: redactSecrets(result.stdout ?? ''),
    stderr: redactSecrets(result.stderr ?? ''),
    error: result.error ? { name: result.error.name, message: redactSecrets(result.error.message) } : null,
    durationMs: Date.now() - startedAt,
  }
}

export function probeVersion(adapter, env = process.env) {
  const result = runProcess({
    command: adapter.command,
    args: adapter.versionArgs,
    cwd: process.cwd(),
    timeoutMs: 15_000,
    env,
  })
  const text = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0] ?? ''
  return {
    available: result.status === 0 && Boolean(text),
    version: result.status === 0 && text ? text : 'unavailable',
    error: result.status === 0 ? null : (result.error?.message ?? text) || 'version probe failed',
  }
}

export function assertRunnerAdapter(adapter) {
  for (const field of ['id', 'label', 'command', 'automation', 'permissionProfile']) {
    if (!adapter?.[field] || typeof adapter[field] !== 'string') {
      throw new Error(`Runner adapter field "${field}" is required`)
    }
  }
  if (!Array.isArray(adapter.versionArgs)) throw new Error('Runner adapter versionArgs must be an array')
  if (typeof adapter.buildInvocation !== 'function') throw new Error('Runner adapter buildInvocation is required')
  return adapter
}

export function resolveInstalledCommand(name, preferredSuffixes = ['.exe', '.cmd', '']) {
  if (process.platform !== 'win32') return name
  const result = spawnSync('where.exe', [name], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    env: cleanGitEnvironment(),
  })
  const candidates = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(value => value && existsSync(value))
  for (const suffix of preferredSuffixes) {
    const candidate = candidates.find(value => value.toLowerCase().endsWith(suffix))
    if (candidate) return candidate
  }
  return name
}

function cleanRunnerEnvironment(env) {
  const clean = cleanGitEnvironment(env)
  delete clean.VERSTAK_GATEWAY_API_KEY
  return clean
}
