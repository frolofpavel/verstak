/**
 * SSH-live backend (Вариант B): файловые операции и команды на удалённом сервере
 * через системный ssh. Проект с kind='ssh' имеет project_path вида
 * `ssh://[user@]host/remotePath` — он самоописывающий, БД не нужна.
 *
 * Безопасность:
 *  - resolveRemotePath не даёт выйти за корень проекта (../ escape) → null.
 *  - команды проходят тот же classifyCommand + ssh-denylist, что и локально.
 *  - запись подтверждается mode-policy (через ctx.tools, как у локальных правок).
 */

import { spawn } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import { buildReadCmd, buildWriteCmd, buildListCmd, parseListOutput, shq } from './ssh-fs'

export interface SshTarget {
  user: string | null
  host: string
  remoteRoot: string
  keyPath?: string
}

/** Разобрать project_path `ssh://[user@]host/remotePath` обратно в target. */
export function parseSshProjectPath(projectPath: string): SshTarget | null {
  const m = /^ssh:\/\/(?:([^@/]+)@)?([^/]+)(\/.*)$/.exec(projectPath)
  if (!m) return null
  return { user: m[1] ?? null, host: m[2], remoteRoot: m[3] }
}

/**
 * Привести project-relative путь к абсолютному на сервере, не давая выйти за
 * корень. Возвращает null при попытке escape (../ выше корня).
 */
export function resolveRemotePath(remoteRoot: string, rel: string): string | null {
  const root = remoteRoot.replace(/\/+$/, '') || '/'
  const cleaned = String(rel ?? '').replace(/\\/g, '/')
  // Абсолютный путь в аргументе игнорируем как относительный к корню (без ведущего /).
  const relParts = cleaned.replace(/^\/+/, '').split('/')
  const rootParts = root.split('/').filter(Boolean)
  const stack: string[] = [...rootParts]
  for (const p of relParts) {
    if (p === '' || p === '.') continue
    if (p === '..') {
      if (stack.length <= rootParts.length) return null // escape за корень
      stack.pop()
      continue
    }
    stack.push(p)
  }
  const lead = root.startsWith('~') ? '' : '/'
  return lead + stack.join('/')
}

export interface SshExecResult { stdout: string; stderr: string; exitCode: number | null }
/** exec(cmd, stdin?) — запускает `ssh host "<cmd>"`. Инъектируется для тестов. */
export type SshExec = (cmd: string, stdin?: string) => Promise<SshExecResult>

/** Боевой exec: системный ssh с ключом, BatchMode, таймаут, abort. */
export function makeSshExec(target: SshTarget, signal?: AbortSignal): SshExec {
  const hostArg = target.user ? `${target.user}@${target.host}` : target.host
  const keyPath = target.keyPath ?? join(homedir(), '.ssh', 'id_ed25519')
  return (cmd, stdin) => new Promise<SshExecResult>(resolve => {
    const args = ['-i', keyPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new', hostArg, cmd]
    const proc = spawn('ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    const MAX = 4 * 1024 * 1024
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', c => { if (stdout.length < MAX) stdout += c })
    proc.stderr.on('data', c => { if (stderr.length < MAX) stderr += c })
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* */ } }, 120_000)
    const onAbort = () => { try { proc.kill('SIGTERM') } catch { /* */ } }
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('error', err => { clearTimeout(timer); resolve({ stdout, stderr: stderr || err.message, exitCode: null }) })
    proc.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ stdout, stderr, exitCode: code }) })
    if (stdin != null) { try { proc.stdin.write(stdin) } catch { /* */ } }
    try { proc.stdin.end() } catch { /* */ }
  })
}

export interface SshBackend {
  readFile(rel: string): Promise<string>
  writeFile(rel: string, content: string): Promise<void>
  listDir(rel: string): Promise<string[]>
  runCommand(command: string): Promise<SshExecResult>
}

/** Backend поверх exec + remoteRoot. Пути проверяются resolveRemotePath. */
export function createSshBackend(remoteRoot: string, exec: SshExec): SshBackend {
  function abs(rel: string): string {
    const p = resolveRemotePath(remoteRoot, rel)
    if (p == null) throw new Error(`Путь вне корня проекта запрещён: ${rel}`)
    return p
  }
  return {
    async readFile(rel) {
      const r = await exec(buildReadCmd(abs(rel)))
      if (r.exitCode !== 0) throw new Error(`Не прочитать ${rel}: ${r.stderr.trim() || 'ssh exit ' + r.exitCode}`)
      return r.stdout
    },
    async writeFile(rel, content) {
      const r = await exec(buildWriteCmd(abs(rel)), content)
      if (r.exitCode !== 0) throw new Error(`Не записать ${rel}: ${r.stderr.trim() || 'ssh exit ' + r.exitCode}`)
    },
    async listDir(rel) {
      const r = await exec(buildListCmd(abs(rel)))
      if (r.exitCode !== 0) throw new Error(`Не листинг ${rel}: ${r.stderr.trim() || 'ssh exit ' + r.exitCode}`)
      return parseListOutput(r.stdout).map(e => (e.isDirectory ? `${e.name}/` : e.name))
    },
    runCommand(command) {
      // Команда выполняется в корне проекта на сервере.
      return exec(`cd ${shq(remoteRoot)} && ${command}`)
    },
  }
}
