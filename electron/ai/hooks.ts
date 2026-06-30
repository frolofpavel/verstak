/**
 * Пользовательский lifecycle-hooks движок — детерминированный контроль ВНЕ LLM.
 *
 * Аналог Claude Code hooks / Codex hooks.json / Cursor hooks.json. Превращает главную
 * ценность Verstak «высококонтролируемость» из лозунга в программируемый механизм:
 * пользователь вешает свой скрипт на событие жизненного цикла («перед run_command»,
 * «после ответа»), а харнес (не модель) его исполняет.
 *
 * События:
 *   SessionStart     — старт прогона. stdout.additionalContext инжектится в контекст.
 *   UserPromptSubmit — пользователь отправил запрос. additionalContext инжектится.
 *   PreToolUse       — ПЕРЕД вызовом тула. exit code 2 ИЛИ stdout {block:true} = ЗАБЛОКИРОВАТЬ.
 *   PostToolUse      — ПОСЛЕ вызова тула. additionalContext идёт в следующий ход.
 *   Stop             — завершение прогона.
 *
 * Контракт хука: на stdin приходит JSON события { event, tool_name?, tool_input?, cwd,
 * ... }; хук может вернуть на stdout JSON { block?, reason?, additionalContext? }.
 * Exit code 2 в PreToolUse = блок (как у Claude Code). Прочие коды игнорируются.
 *
 * БЕЗОПАСНОСТЬ: хуки исполняют произвольные shell-команды из конфига проекта —
 * это потенциальный supply-chain риск (вредоносный .verstak/hooks.json мог бы
 * выполнить код при открытии проекта). Поэтому движок ВЫКЛЮЧЕН по умолчанию
 * (настройка hooks_enabled). Включается явно пользователем. Вывод хука пропускается
 * через secret-scanner перед инъекцией в контекст.
 *
 * Конфиг (JSON):
 *   ~/.verstak/hooks.json        — user-scope
 *   {project}/.verstak/hooks.json — project-scope (оба набора исполняются)
 * Формат:
 *   { "PreToolUse": [{ "matcher": "run_command", "command": "node guard.js", "timeout": 5000 }],
 *     "PostToolUse": [{ "matcher": "write_file", "command": "npm run lint -- $FILE" }] }
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { treeKill } from './child-kill'
import { scanText } from './secret-scanner'

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop'

export const HOOK_EVENTS: HookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']

export interface HookEntry {
  /** Glob по имени тула (для Pre/PostToolUse). Пусто/'*' = любой тул. */
  matcher: string | null
  /** Shell-команда хука. */
  command: string
  /** Таймаут мс (по умолчанию 5000). */
  timeout: number
  /** Источник (для отладки). */
  scope: 'user' | 'project'
}

export type CompiledHooks = Record<HookEvent, HookEntry[]>

export interface HookPayload {
  event: HookEvent
  cwd: string | null
  tool_name?: string
  tool_input?: unknown
  tool_output?: unknown
  prompt?: string
}

/** Результат прогона хуков события: блок (для PreToolUse) + контекст для инъекции. */
export interface HookOutcome {
  block: boolean
  reason?: string
  additionalContext?: string
}

const DEFAULT_TIMEOUT = 5000
const MAX_TIMEOUT = 30000

function emptyHooks(): CompiledHooks {
  return { SessionStart: [], UserPromptSubmit: [], PreToolUse: [], PostToolUse: [], Stop: [] }
}

/** Движок включён? Дефолт — ВЫКЛЮЧЕН (opt-in, security). */
export function hooksEnabled(getSecret: ((key: string) => string | null) | undefined): boolean {
  return getSecret?.('hooks_enabled') === 'true'
}

/** Доверять project-scope хукам ({project}/.verstak/hooks.json)? Отдельный гейт,
 *  ВЫКЛЮЧЕН по умолчанию даже при hooks_enabled — чтобы хуки чужого склонированного
 *  репо не исполнялись молча (ревью: supply-chain). По умолчанию бегут только
 *  user-хуки (~/.verstak), которые писал сам пользователь. */
export function hooksProjectEnabled(getSecret: ((key: string) => string | null) | undefined): boolean {
  return getSecret?.('hooks_project_enabled') === 'true'
}

function parseEntries(raw: unknown, scope: 'user' | 'project'): HookEntry[] {
  if (!Array.isArray(raw)) return []
  const out: HookEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const command = typeof o.command === 'string' ? o.command.trim() : ''
    if (!command) continue
    const matcherRaw = typeof o.matcher === 'string' ? o.matcher.trim() : ''
    const matcher = (matcherRaw === '' || matcherRaw === '*') ? null : matcherRaw
    let timeout = typeof o.timeout === 'number' && o.timeout > 0 ? o.timeout : DEFAULT_TIMEOUT
    if (timeout > MAX_TIMEOUT) timeout = MAX_TIMEOUT
    out.push({ matcher, command, timeout, scope })
  }
  return out
}

/** Скомпилировать объект конфига { Event: [entries] } в CompiledHooks. */
export function compileHooksConfig(raw: unknown, scope: 'user' | 'project'): CompiledHooks {
  const hooks = emptyHooks()
  if (!raw || typeof raw !== 'object') return hooks
  const o = raw as Record<string, unknown>
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = parseEntries(o[ev], scope)
  }
  return hooks
}

function readJsonFile(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/**
 * Загрузить хуки: user (~/.verstak) всегда + project ТОЛЬКО при opts.projectEnabled.
 * По умолчанию project-хуки НЕ грузятся (security: чужой репо). См. hooksProjectEnabled.
 */
export function loadHooks(projectPath: string | null, opts: { projectEnabled?: boolean } = {}): CompiledHooks {
  const merged = compileHooksConfig(readJsonFile(join(homedir(), '.verstak', 'hooks.json')), 'user')
  if (projectPath && opts.projectEnabled) {
    const proj = compileHooksConfig(readJsonFile(join(projectPath, '.verstak', 'hooks.json')), 'project')
    for (const ev of HOOK_EVENTS) merged[ev].push(...proj[ev])
  }
  return merged
}

/** Матчит ли хук данный тул. Glob по имени (* в пределах сегмента не нужен — имена плоские). */
export function matchHook(entry: HookEntry, toolName: string | undefined): boolean {
  if (entry.matcher === null) return true
  if (!toolName) return false
  if (entry.matcher === toolName) return true
  // простой glob: '*' → .*
  if (entry.matcher.includes('*')) {
    const re = new RegExp('^' + entry.matcher.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    return re.test(toolName)
  }
  return false
}

/**
 * Интерпретировать результат одного хука (pure — тестируемо отдельно от spawn).
 * exit code 2 в PreToolUse = блок. stdout может быть JSON { block, reason, additionalContext }.
 */
export function interpretHookResult(
  event: HookEvent,
  res: { exitCode: number | null; stdout: string; stderr: string }
): HookOutcome {
  const outcome: HookOutcome = { block: false }
  // exit code 2 = блок (только PreToolUse имеет смысл блокировать)
  if (event === 'PreToolUse' && res.exitCode === 2) {
    outcome.block = true
    // reason идёт модели/в UI — редактируем секреты (вдруг хук вывел токен в stderr).
    outcome.reason = scanText((res.stderr || res.stdout || '').trim()).redacted || 'Заблокировано PreToolUse-хуком (exit 2).'
  }
  // stdout JSON — структурированный ответ
  const trimmed = res.stdout.trim()
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (event === 'PreToolUse' && obj.block === true) {
        outcome.block = true
        if (typeof obj.reason === 'string' && obj.reason) outcome.reason = scanText(obj.reason).redacted
      }
      if (typeof obj.additionalContext === 'string' && obj.additionalContext.trim()) {
        outcome.additionalContext = obj.additionalContext.trim()
      }
    } catch { /* не JSON — игнорируем структурный разбор */ }
  }
  return outcome
}

/** Спавн одного хука: payload на stdin, capture stdout/stderr, таймаут с treeKill. */
function runHook(entry: HookEntry, payload: HookPayload): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(entry.command, {
        shell: true,
        cwd: payload.cwd ?? undefined,
        // Прокидываем удобные переменные окружения для простых хуков
        env: {
          ...process.env,
          VERSTAK_HOOK_EVENT: payload.event,
          VERSTAK_TOOL_NAME: payload.tool_name ?? '',
          FILE: typeof (payload.tool_input as { path?: string })?.path === 'string'
            ? (payload.tool_input as { path?: string }).path! : '',
        },
      })
    } catch (err) {
      resolve({ exitCode: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (exitCode: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr })
    }
    const timer = setTimeout(() => {
      treeKill(child)
      stderr += `\n[hook timeout ${entry.timeout}ms]`
      finish(null)
    }, entry.timeout)
    child.stdout?.on('data', (d) => { stdout += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('error', (err) => { stderr += err.message; finish(null) })
    child.on('close', (code) => finish(code))
    // payload на stdin. EPIPE/ECONNRESET приходит АСИНХРОННО событием 'error' (хук
    // не читает stdin / быстро завершился) — ловим и его, иначе uncaught в main.
    child.stdin?.on('error', () => { /* stdin закрыт раньше записи — не фатально */ })
    try {
      child.stdin?.write(JSON.stringify(payload))
      child.stdin?.end()
    } catch { /* stdin может быть недоступен */ }
  })
}

/**
 * Прогнать все хуки события. Для PreToolUse/PostToolUse фильтрует по matcher.
 * Агрегирует: block=true если ЛЮБОЙ хук заблокировал; additionalContext склеивается
 * (через secret-scanner). Хуки одного события исполняются последовательно (детерминизм
 * + ранний блок). Никогда не бросает — ошибка хука = пропуск.
 */
export async function runHooks(
  event: HookEvent,
  hooks: CompiledHooks,
  payload: HookPayload
): Promise<HookOutcome> {
  const entries = hooks[event] ?? []
  const matched = (event === 'PreToolUse' || event === 'PostToolUse')
    ? entries.filter(e => matchHook(e, payload.tool_name))
    : entries
  if (matched.length === 0) return { block: false }

  const contexts: string[] = []
  let block = false
  let reason: string | undefined
  for (const entry of matched) {
    let res
    try {
      res = await runHook(entry, payload)
    } catch {
      continue
    }
    const outcome = interpretHookResult(event, res)
    if (outcome.additionalContext) contexts.push(scanText(outcome.additionalContext).redacted)
    if (outcome.block) {
      block = true
      reason = outcome.reason
      break // ранний блок — дальше нет смысла
    }
  }
  return {
    block,
    reason,
    additionalContext: contexts.length ? contexts.join('\n\n') : undefined,
  }
}
