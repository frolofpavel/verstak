/**
 * Logout / relogin для CLI-провайдеров (Claude Code, Gemini CLI, Grok Build,
 * Codex CLI). До этого «Отключить» для CLI было disabled — единственный
 * способ перелогиниться был руками в терминале. Теперь:
 *
 * - logoutCli(providerId): сначала пытается `<bin> logout` (это поддерживают
 *   большинство современных CLI), если exit != 0 — fallback удаляет известный
 *   credentials-файл провайдера. НИКОГДА не удаляет директории целиком —
 *   только специфичные .credentials.json / oauth.json / auth.json файлы,
 *   чтобы случайно не снести данные пользователя в ~/.claude/.
 *
 * - reloginCli(providerId): запускает CLI в НОВОМ окне терминала
 *   (Windows Terminal → PowerShell → cmd, по убыванию) detached, чтобы
 *   пользователь прошёл интерактивный OAuth. Наше Electron-окно не блокируется.
 *
 * Безопасность:
 * - Не трогаем ~/.ssh/, *.key, creds*.json вне списка CLI-credentials.
 * - Бинари ищем через тот же findBinary() что и провайдеры (хождение по PATH +
 *   стандартные локации). Если бинаря нет — возвращаем clear error, не падаем.
 */

import { spawn, spawnSync } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { ProviderId } from './registry'

export type CliProviderId = Extract<ProviderId, 'claude-cli' | 'gemini-cli' | 'grok-cli' | 'codex-cli'>

/** Описание одного CLI-провайдера для auth-операций. */
interface CliAuthDescriptor {
  /** Имя бинаря (без расширения; на Windows пробуем .cmd / .exe варианты). */
  bin: string
  /** Стандартные пути credentials-файлов в HOME (относительно $HOME / %USERPROFILE%).
   *  Удаляем ВСЕ что нашли — некоторые CLI хранят несколько файлов
   *  (token + refresh + user.json). */
  credFiles: string[]
  /** Subcommand для интерактивного логина. Запускаем в новом терминале. */
  loginCmd: string
  /** Subcommand для logout (если CLI поддерживает). null = только удаление файлов. */
  logoutSubcmd: string | null
  /** Человекочитаемое имя провайдера для сообщений об ошибках. */
  label: string
}

const DESCRIPTORS: Record<CliProviderId, CliAuthDescriptor> = {
  'claude-cli': {
    bin: 'claude',
    credFiles: ['.claude/.credentials.json'],
    loginCmd: 'claude',
    logoutSubcmd: 'logout',
    label: 'Claude Code'
  },
  'gemini-cli': {
    bin: 'gemini',
    credFiles: ['.gemini/oauth_creds.json', '.gemini/credentials.json'],
    loginCmd: 'gemini',
    logoutSubcmd: 'logout',
    label: 'Gemini CLI'
  },
  'grok-cli': {
    bin: 'grok',
    credFiles: ['.grok/credentials.json', '.grok/auth.json', '.grok/oauth.json'],
    loginCmd: 'grok',
    // grok CLI на момент написания не имел стабильной logout subcommand —
    // полагаемся на удаление credentials.
    logoutSubcmd: null,
    label: 'Grok Build'
  },
  'codex-cli': {
    bin: 'codex',
    credFiles: ['.codex/auth.json'],
    loginCmd: 'codex',
    logoutSubcmd: 'logout',
    label: 'Codex CLI'
  }
}

/**
 * Возвращает абсолютный путь к бинарю CLI или null если не найден.
 * Использует системную команду where/which — она ищет по PATH.
 */
function whichBin(bin: string): string | null {
  const cmd = platform() === 'win32' ? 'where' : 'which'
  try {
    const res = spawnSync(cmd, [bin], { encoding: 'utf8', timeout: 5000 })
    if (res.status === 0 && res.stdout) {
      // where на Windows возвращает несколько строк (.cmd / .ps1 / .exe);
      // берём первую — обычно .cmd shim который умеет логиниться.
      const first = res.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0]
      return first || null
    }
  } catch { /* fall through */ }
  return null
}

/** Удаляет credentials-файлы провайдера. Возвращает список путей которые удалил. */
function deleteCreds(d: CliAuthDescriptor): string[] {
  const home = homedir()
  const removed: string[] = []
  for (const rel of d.credFiles) {
    const abs = join(home, rel)
    if (existsSync(abs)) {
      try {
        unlinkSync(abs)
        removed.push(abs)
      } catch (err) {
        // Файл есть но удалить нельзя (permissions, lock) — пробрасываем дальше
        // через текст, не падаем.
        throw new Error(`Не удалось удалить ${abs}: ${(err as Error).message}`)
      }
    }
  }
  return removed
}

export interface LogoutResult {
  ok: boolean
  method: 'logout-cmd' | 'creds-deleted' | 'both'
  removedFiles: string[]
  stdout?: string
  stderr?: string
  message?: string
}

/**
 * Logout для CLI-провайдера.
 * Алгоритм:
 *  1. Если у CLI есть logout subcmd — запускаем `<bin> logout` (timeout 15s).
 *     Если exit=0 → success (method='logout-cmd'). Но даже при success'е
 *     дополнительно удаляем известные credentials-файлы — некоторые CLI
 *     оставляют их валяться (после `claude logout` credentials могут
 *     остаться и логин сохраняется в новом запуске).
 *  2. Иначе (или если subcmd упал) — fallback: только удаление файлов
 *     (method='creds-deleted').
 *  3. Если бинарь не найден И файлов нет → ok:false с понятным сообщением.
 */
export async function logoutCli(providerId: CliProviderId): Promise<LogoutResult> {
  const d = DESCRIPTORS[providerId]
  const binPath = whichBin(d.bin)
  let logoutCmdOk = false
  let stdout = ''
  let stderr = ''

  if (binPath && d.logoutSubcmd) {
    try {
      const res = spawnSync(binPath, [d.logoutSubcmd], {
        encoding: 'utf8',
        timeout: 15_000,
        shell: binPath.endsWith('.cmd') || binPath.endsWith('.ps1'),
        windowsHide: true
      })
      stdout = (res.stdout ?? '').toString()
      stderr = (res.stderr ?? '').toString()
      logoutCmdOk = res.status === 0
    } catch (err) {
      stderr = (err as Error).message
    }
  }

  let removedFiles: string[] = []
  try {
    removedFiles = deleteCreds(d)
  } catch (err) {
    return {
      ok: false,
      method: logoutCmdOk ? 'logout-cmd' : 'creds-deleted',
      removedFiles: [],
      stdout, stderr,
      message: (err as Error).message
    }
  }

  if (!logoutCmdOk && removedFiles.length === 0 && !binPath) {
    return {
      ok: false,
      method: 'creds-deleted',
      removedFiles: [],
      stdout, stderr,
      message: `${d.label}: бинарь не найден в PATH и credentials-файлов нет — нечего отключать. Возможно CLI вообще не установлен.`
    }
  }

  return {
    ok: true,
    method: logoutCmdOk && removedFiles.length > 0 ? 'both' : logoutCmdOk ? 'logout-cmd' : 'creds-deleted',
    removedFiles,
    stdout, stderr
  }
}

export interface ReloginResult {
  ok: boolean
  message?: string
  /** Команда которая была запущена — для отображения пользователю что мы открыли. */
  command?: string
}

/**
 * Запускает CLI в новом окне терминала detached, чтобы пользователь
 * интерактивно прошёл OAuth. На Windows пробуем Windows Terminal (`wt.exe`),
 * затем PowerShell, затем cmd. На *nix — открываем системный терминал
 * (xdg-terminal-exec / x-terminal-emulator).
 *
 * Не ждём завершения — наше окно не должно блокироваться. Возвращаем
 * как только спавн прошёл.
 */
export async function reloginCli(providerId: CliProviderId): Promise<ReloginResult> {
  const d = DESCRIPTORS[providerId]
  const binPath = whichBin(d.bin)
  if (!binPath) {
    return { ok: false, message: `${d.label}: бинарь \`${d.bin}\` не найден в PATH. Установи CLI и попробуй снова.` }
  }

  if (platform() === 'win32') {
    // Windows консоль по умолчанию использует кодировку cp866 (на ru-RU),
    // а CLI (grok / claude / gemini / codex) пишут в UTF-8. Без переключения
    // на cp65001 + Console.OutputEncoding=UTF-8 их ascii-art / русский текст
    // отображается как «тАйтАйтАйтАй». Префикс делает консоль UTF-8-ready
    // ПЕРЕД запуском CLI и не падает если cmd уже UTF-8.
    const prefix = 'chcp 65001 > $null; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
    const cmdLine = prefix + d.loginCmd

    // Пробуем Windows Terminal — у него красивее UX и tabs. wt.exe есть на
    // Win11 по умолчанию и устанавливается на Win10 через Store.
    const wt = whichBin('wt')
    if (wt) {
      try {
        const child = spawn(wt, ['new-tab', 'powershell', '-NoExit', '-Command', cmdLine], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        })
        child.unref()
        return { ok: true, command: `wt new-tab powershell -NoExit -Command ${cmdLine}` }
      } catch { /* fall through to powershell */ }
    }
    // Fallback: PowerShell в новом окне через start
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', cmdLine], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        shell: false
      })
      child.unref()
      return { ok: true, command: `powershell -NoExit -Command ${cmdLine}` }
    } catch (err) {
      return { ok: false, message: `Не удалось открыть терминал: ${(err as Error).message}` }
    }
  }

  // *nix
  try {
    const child = spawn('x-terminal-emulator', ['-e', `${d.loginCmd}; read -p "Enter to close..."`], {
      detached: true, stdio: 'ignore'
    })
    child.unref()
    return { ok: true, command: d.loginCmd }
  } catch (err) {
    return { ok: false, message: `Не удалось открыть терминал: ${(err as Error).message}. Запусти вручную: ${d.loginCmd}` }
  }
}

/** Список поддерживаемых CLI providerId — для UI чтобы знать какие кнопки рендерить. */
export function isCliProvider(id: string): id is CliProviderId {
  return id === 'claude-cli' || id === 'gemini-cli' || id === 'grok-cli' || id === 'codex-cli'
}

export interface CliStatus {
  /** Бинарь найден в PATH. */
  installed: boolean
  /** Найден хотя бы один из known credentials-файлов. */
  loggedIn: boolean
  /** Путь к найденному credentials-файлу (для тултипа). */
  credPath?: string
}

/**
 * Синхронный статус одного CLI: установлен ли бинарь + есть ли credentials.
 * НЕ запускает CLI (был бы overhead 200-500мс на каждый). credentials-файл
 * = достаточный индикатор «залогинен» для всех 4 CLI (они после login
 * сохраняют OAuth/API key в этот файл).
 */
export function getCliStatus(providerId: CliProviderId): CliStatus {
  const d = DESCRIPTORS[providerId]
  const installed = whichBin(d.bin) !== null
  const home = homedir()
  let credPath: string | undefined
  for (const rel of d.credFiles) {
    const abs = join(home, rel)
    if (existsSync(abs)) { credPath = abs; break }
  }
  return { installed, loggedIn: credPath !== undefined, credPath }
}

/** Bulk status для всех 4 CLI — для одного IPC-вызова на загрузку Settings. */
export function getAllCliStatus(): Record<CliProviderId, CliStatus> {
  return {
    'claude-cli': getCliStatus('claude-cli'),
    'gemini-cli': getCliStatus('gemini-cli'),
    'grok-cli':   getCliStatus('grok-cli'),
    'codex-cli':  getCliStatus('codex-cli')
  }
}
