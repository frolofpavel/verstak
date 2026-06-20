import { createSshBackend, makeSshExec, parseSshProjectPath, type SshTarget } from './ssh-backend'

export type RemoteDoctorStatus = 'pass' | 'warn' | 'fail'

export interface RemoteDoctorCheck {
  id: string
  label: string
  status: RemoteDoctorStatus
  detail?: string
}

export interface RemoteDoctorResult {
  ok: boolean
  status: RemoteDoctorStatus
  target: {
    user: string | null
    host: string
    remoteRoot: string
  }
  checkedAt: number
  summary: string
  checks: RemoteDoctorCheck[]
  notes: string[]
}

const MARKER = '__VERSTAK_REMOTE_DOCTOR_V1__'

export function buildRemoteDoctorCommand(): string {
  return [
    `printf '${MARKER}\\n';`,
    `printf 'pwd=%s\\n' "$(pwd 2>/dev/null || echo unknown)";`,
    `printf 'uname=%s\\n' "$(uname -s 2>/dev/null || echo missing)";`,
    `if [ -d . ]; then printf 'root=ok\\n'; else printf 'root=fail\\n'; fi;`,
    `if [ -r . ]; then printf 'read=ok\\n'; else printf 'read=fail\\n'; fi;`,
    `probe=".verstak-remote-doctor-$$";`,
    `if (printf ok > "$probe" 2>/dev/null && rm -f "$probe" 2>/dev/null); then printf 'write=ok\\n'; else rm -f "$probe" 2>/dev/null; printf 'write=fail\\n'; fi;`,
    `for c in git node npm npx rg tsc; do if command -v "$c" >/dev/null 2>&1; then v=$($c --version 2>/dev/null | head -1); printf 'cmd_%s=ok|%s\\n' "$c" "$v"; else printf 'cmd_%s=missing\\n' "$c"; fi; done;`,
    `if [ -f package.json ]; then printf 'file_package=ok\\n'; else printf 'file_package=missing\\n'; fi;`,
    `if [ -f tsconfig.json ]; then printf 'file_tsconfig=ok\\n'; else printf 'file_tsconfig=missing\\n'; fi;`
  ].join(' ')
}

export async function runRemoteDoctor(projectPath: string, signal?: AbortSignal): Promise<RemoteDoctorResult> {
  const target = parseSshProjectPath(projectPath)
  if (!target) {
    return failResult(
      { user: null, host: '', remoteRoot: '' },
      'Remote Doctor работает только для SSH-проектов',
      'Нужно открыть проект вида ssh://user@host/path.'
    )
  }

  try {
    const backend = createSshBackend(target.remoteRoot, makeSshExec(target, signal))
    const result = await backend.runCommand(buildRemoteDoctorCommand())
    return parseRemoteDoctorOutput(result.stdout, result.stderr, result.exitCode, target)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return failResult(target, 'Remote Doctor не смог выполнить проверку', detail)
  }
}

export function parseRemoteDoctorOutput(
  stdout: string,
  stderr = '',
  exitCode: number | null = 0,
  target: SshTarget = { user: null, host: '', remoteRoot: '' }
): RemoteDoctorResult {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const hasMarker = lines.includes(MARKER)
  const values = new Map<string, string>()
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    values.set(line.slice(0, eq), line.slice(eq + 1))
  }

  const checks: RemoteDoctorCheck[] = []
  const notes = [
    'SSH live сейчас рассчитан на Linux/macOS remote host. Windows SSH shell пока считается неподдержанным.'
  ]

  const connectionOk = hasMarker && exitCode === 0
  checks.push({
    id: 'connection',
    label: 'SSH соединение',
    status: connectionOk ? 'pass' : 'fail',
    detail: connectionOk ? 'Команда диагностики выполнилась' : stderrTail(stderr) || `ssh exit ${exitCode ?? 'unknown'}`
  })

  const uname = values.get('uname') ?? ''
  const unixShellStatus = getUnixShellStatus(connectionOk, uname)
  checks.push({
    id: 'unix_shell',
    label: 'Unix shell',
    status: unixShellStatus,
    detail: unixShellDetail(connectionOk, uname)
  })

  addBinaryCheck(checks, 'project_root', 'Корень проекта', values.get('root'), 'Корень доступен', 'Не удалось перейти в корень проекта', connectionOk)
  addBinaryCheck(checks, 'read_access', 'Чтение', values.get('read'), 'Права на чтение есть', 'Нет прав на чтение', connectionOk)
  addBinaryCheck(checks, 'write_access', 'Запись', values.get('write'), 'Временная запись прошла', 'Нет прав на запись в корень проекта', connectionOk)

  addCommandCheck(checks, 'git', 'git', values.get('cmd_git'), 'git не найден: commit/status будут ограничены')
  addCommandCheck(checks, 'node', 'node', values.get('cmd_node'), 'node не найден: JS/TS проверки будут ограничены')
  addCommandCheck(checks, 'npm', 'npm', values.get('cmd_npm'), 'npm не найден: npm scripts недоступны')
  addCommandCheck(checks, 'npx', 'npx', values.get('cmd_npx'), 'npx не найден: локальные CLI запускать сложнее')
  addCommandCheck(checks, 'rg', 'rg', values.get('cmd_rg'), 'rg не найден: поиск будет медленнее через grep/find')
  addCommandCheck(checks, 'tsc', 'tsc', values.get('cmd_tsc'), 'tsc не найден глобально: нужен npm/npx или локальный script')

  addOptionalFileCheck(checks, 'package_json', 'package.json', values.get('file_package'), 'package.json найден', 'package.json не найден')
  addOptionalFileCheck(checks, 'tsconfig_json', 'tsconfig.json', values.get('file_tsconfig'), 'tsconfig.json найден', 'tsconfig.json не найден')

  if (checks.some(check => check.id === 'rg' && check.status === 'warn')) {
    notes.push('Без rg агент сможет искать через fallback, но на больших проектах это заметно медленнее.')
  }
  if (checks.some(check => check.id === 'tsc' && check.status === 'warn')) {
    notes.push('Если TypeScript есть только локально в node_modules, достаточно npm/npx или script в package.json.')
  }

  const status = overallStatus(checks)
  return {
    ok: status !== 'fail',
    status,
    target: {
      user: target.user,
      host: target.host,
      remoteRoot: target.remoteRoot
    },
    checkedAt: Date.now(),
    summary: summaryFor(status),
    checks,
    notes
  }
}

function addBinaryCheck(
  checks: RemoteDoctorCheck[],
  id: string,
  label: string,
  value: string | undefined,
  okDetail: string,
  failDetail: string,
  connectionOk: boolean
) {
  const ok = connectionOk && value === 'ok'
  checks.push({
    id,
    label,
    status: ok ? 'pass' : 'fail',
    detail: ok ? okDetail : failDetail
  })
}

function addCommandCheck(
  checks: RemoteDoctorCheck[],
  id: string,
  label: string,
  value: string | undefined,
  missingDetail: string
) {
  const parsed = parseProbeValue(value)
  checks.push({
    id,
    label,
    status: parsed.ok ? 'pass' : 'warn',
    detail: parsed.ok ? parsed.detail || 'Найден' : missingDetail
  })
}

function addOptionalFileCheck(
  checks: RemoteDoctorCheck[],
  id: string,
  label: string,
  value: string | undefined,
  okDetail: string,
  missingDetail: string
) {
  checks.push({
    id,
    label,
    status: value === 'ok' ? 'pass' : 'warn',
    detail: value === 'ok' ? okDetail : missingDetail
  })
}

function parseProbeValue(value: string | undefined): { ok: boolean; detail?: string } {
  if (!value) return { ok: false }
  if (!value.startsWith('ok')) return { ok: false }
  const pipe = value.indexOf('|')
  return { ok: true, detail: pipe >= 0 ? value.slice(pipe + 1).trim() : undefined }
}

function getUnixShellStatus(connectionOk: boolean, uname: string): RemoteDoctorStatus {
  if (!connectionOk) return 'fail'
  if (!uname || uname === 'missing' || uname === 'unknown') return 'fail'
  if (/mingw|msys|cygwin|windows/i.test(uname)) return 'fail'
  return 'pass'
}

function unixShellDetail(connectionOk: boolean, uname: string): string {
  if (!connectionOk) return 'Диагностика не дошла до shell probe'
  if (!uname || uname === 'missing' || uname === 'unknown') return 'uname недоступен'
  if (/mingw|msys|cygwin|windows/i.test(uname)) return `${uname}: Windows SSH shell пока не поддержан`
  return uname
}

function overallStatus(checks: RemoteDoctorCheck[]): RemoteDoctorStatus {
  if (checks.some(check => check.status === 'fail')) return 'fail'
  if (checks.some(check => check.status === 'warn')) return 'warn'
  return 'pass'
}

function summaryFor(status: RemoteDoctorStatus): string {
  if (status === 'pass') return 'Remote Doctor: сервер готов'
  if (status === 'warn') return 'Remote Doctor: есть предупреждения, но можно работать'
  return 'Remote Doctor: найдены блокирующие проблемы'
}

function failResult(target: SshTarget, summary: string, detail: string): RemoteDoctorResult {
  return {
    ok: false,
    status: 'fail',
    target: {
      user: target.user,
      host: target.host,
      remoteRoot: target.remoteRoot
    },
    checkedAt: Date.now(),
    summary,
    checks: [{
      id: 'connection',
      label: 'SSH соединение',
      status: 'fail',
      detail
    }],
    notes: [
      'SSH live сейчас рассчитан на Linux/macOS remote host. Windows SSH shell пока считается неподдержанным.'
    ]
  }
}

function stderrTail(stderr: string): string {
  const text = stderr.trim()
  if (!text) return ''
  return text.length > 400 ? text.slice(-400) : text
}
