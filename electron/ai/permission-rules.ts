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

import { readFileSync } from 'fs'
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

function ruleMatches(rules: PermissionRule[], toolName: string, argText: string): PermissionRule | null {
  for (const r of rules) {
    if (r.tool !== toolName) continue
    if (r.argMatcher === null || r.argMatcher(argText)) return r
  }
  return null
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
  const al = ruleMatches(rules.allow, toolName, argText)
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
