/**
 * SSH executor — выполнение команд на удалённой машине через системный
 * ssh клиент. Без дополнительных npm зависимостей (использует системный
 * ssh бинарь).
 *
 * Источник: V3 Plan раздел 5.3.
 *
 * Credentials (settings keys):
 *   ssh_default_host    — например 'user@your-server.example.com' или просто host
 *                         (если host берётся из ~/.ssh/config)
 *   ssh_default_user    — опционально, если не в host
 *   ssh_key_path        — путь к private key (по умолчанию ~/.ssh/id_ed25519)
 *
 * Безопасность:
 *   - DENYLIST команд: rm -rf /, mkfs.*, dd of=, passwd, su, sudo passwd,
 *     операции с /etc, /var/log, /boot. См. isDangerousCommand.
 *   - Whitelist hosts: V1 — только тот хост что в ssh_default_host. Прочие
 *     отклоняются.
 *   - Timeout 60s по умолчанию. Можно поднять до 600s через args.
 *
 * Подключение к серверу:
 *   - Главный target: your configured server
 *   - Рекомендуется создать отдельного пользователя с whitelist sudo на нужные
 *     скрипты (см. V3 Plan раздел 14 «SSH ключ»).
 */

import { spawn } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import type { Connector, ConnectorInfo, ConnectorContext } from './types'
import { scanText } from '../ai/secret-scanner'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 64 * 1024

/** Жёсткий denylist — независимо от режима agent mode. */
const DANGEROUS_PATTERNS = [
  // rm -rf корневых системных путей (но НЕ /tmp/foo, не /home/user/x)
  /\brm\s+-[rRf]+\s+\/(\s|$|var($|\/)|etc($|\/)|usr($|\/)|bin($|\/)|sbin($|\/)|lib($|\/)|boot($|\/)|opt($|\/)|root($|\/))/,
  /\bmkfs\b/,                              // форматирование
  /\bdd\s+.*of=\/dev/,                     // dd на устройство
  /\bpasswd\b/,                            // смена пароля
  /\b(su\s+-|sudo\s+su\b)/,                // su - / sudo su (не блокирует sudo команду но блокирует su без аргументов)
  /\bsudo\s+passwd\b/,
  />\s*\/etc\//,                           // запись в /etc/
  />\s*\/var\/log\//,
  /\bsystemctl\s+(stop|disable|mask)\b/,   // остановка системных служб
  /\biptables\b.*-F/,                      // сброс firewall
  /\bchmod\s+777\s+\//,
  /:\(\)\{:\|:&\};:/                       // forkbomb signature (нужно экранировать)
]

export function createSshConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'ssh',
        label: 'SSH executor',
        kind: 'ssh',
        status: 'ready',
        detail: 'Системный ssh клиент. Default host в settings (ssh_default_host).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? 'run_remote')
      switch (op) {
        case 'run_remote':         return runRemote(args, ctx)
        case 'run_python_script':  return runPythonScript(args, ctx)
        default:
          return { error: 'unknown-op', message: `Unknown ssh op: ${op}. Use run_remote or run_python_script.` }
      }
    }
  }
}

async function runRemote(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const command = String(args.command ?? '').trim()
  if (!command) return { error: 'bad-args', message: 'command обязателен' }

  const dangerReason = isDangerousCommand(command)
  if (dangerReason) {
    return { error: 'blocked', message: `Команда отклонена политикой: ${dangerReason}. Изменения в системных областях — только вручную.` }
  }

  // Если defaultHost не настроен — БЛОКИРУЕМ всё.
  // Старая логика разрешала любой host если default не задан (через fallback
  // `args.host ?? '' `) — опасно: модель может слить команды на любой сервер.
  // Теперь whitelist обязателен.
  const defaultHost = ctx.getSecret('ssh_default_host')
  if (!defaultHost) {
    return {
      error: 'no-host',
      message: 'SSH: укажите default host в Settings → Коннекторы → SSH (поле «Default host»). Без него SSH-команды заблокированы по безопасности.'
    }
  }

  // host либо берётся из defaultHost (если модель не указала), либо явно
  // совпадает с whitelist'ом. Никаких других вариантов.
  const host = String(args.host ?? defaultHost)
  if (host !== defaultHost) {
    return {
      error: 'blocked',
      message: `Хост «${host}» не в whitelist. Разрешён только «${defaultHost}» (из Settings → Коннекторы → SSH). Чтобы добавить другой — поменяй default host или дождись whitelist V2.`
    }
  }

  const keyPath = String(args.key_path ?? ctx.getSecret('ssh_key_path') ?? join(homedir(), '.ssh', 'id_ed25519'))
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS))
  const cwd = args.cwd ? `cd ${shellQuote(String(args.cwd))} && ` : ''
  const fullCmd = cwd + command

  const sshArgs = [
    '-i', keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    host,
    fullCmd
  ]

  return runSsh(sshArgs, timeoutMs, ctx)
}

async function runPythonScript(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const scriptPath = String(args.script_path ?? '')
  if (!scriptPath) return { error: 'bad-args', message: 'script_path обязателен' }
  // По умолчанию ищем venv по пути /opt/los/venv (можно переопределить через args.venv)
  const venv = String(args.venv ?? '/opt/los/venv')
  const scriptArgs = (args.args as string[] | undefined) ?? []
  const formattedArgs = scriptArgs.map(shellQuote).join(' ')
  const command = `source ${venv}/bin/activate && python ${shellQuote(scriptPath)} ${formattedArgs}`
  return runRemote({ ...args, command }, ctx)
}

interface SshResult {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out?: boolean
  duration_ms: number
}

function runSsh(sshArgs: string[], timeoutMs: number, ctx: ConnectorContext): Promise<SshResult> {
  return new Promise<SshResult>(resolve => {
    const started = Date.now()
    const proc = spawn('ssh', sshArgs, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGTERM') } catch { /* */ }
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* */ } }, 2000)
    }, timeoutMs)

    // AbortSignal интеграция
    const onAbort = () => {
      try { proc.kill('SIGTERM') } catch { /* */ }
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })

    proc.stdout.on('data', chunk => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', chunk => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
    })
    proc.on('error', err => {
      clearTimeout(timeout)
      ctx.signal?.removeEventListener('abort', onAbort)
      resolve({
        stdout: scanAndCap(stdout),
        stderr: scanAndCap(stderr || err.message),
        exit_code: null,
        duration_ms: Date.now() - started
      })
    })
    proc.on('close', code => {
      clearTimeout(timeout)
      ctx.signal?.removeEventListener('abort', onAbort)
      resolve({
        stdout: scanAndCap(stdout),
        stderr: scanAndCap(stderr),
        exit_code: code,
        timed_out: timedOut || undefined,
        duration_ms: Date.now() - started
      })
    })
  })
}

function scanAndCap(text: string): string {
  const truncated = text.length > MAX_OUTPUT_BYTES
    ? text.slice(0, MAX_OUTPUT_BYTES) + '\n…[truncated]'
    : text
  const scan = scanText(truncated)
  return scan.hits.length > 0
    ? `[secret-scanner: redacted ${scan.hits.join(', ')}]\n${scan.redacted}`
    : scan.redacted
}

export function isDangerousCommand(command: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return pattern.toString()
    }
  }
  return null
}

function shellQuote(s: string): string {
  // Quoted single — для bash. Внутри single-quote экранируется как '\''
  return `'${s.replace(/'/g, "'\\''")}'`
}
