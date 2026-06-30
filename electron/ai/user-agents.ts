/**
 * Субагенты-как-файлы — декларативные .md субагенты с whitelist'ом инструментов,
 * своей моделью/провайдером. Продолжение линии «всё декларируется файлом» (как
 * commands/output-styles/skills/hooks): пользователь объявляет специализированного
 * исполнителя файлом, а агент делегирует ему подзадачу через delegate_task.
 *
 * В отличие от захардкоженных ролей (planner/critic/executor/...), это ПОЛЬЗОВА-
 * ТЕЛЬСКИЕ субагенты с произвольным набором инструментов и моделью — расширяемость
 * без правки кода. Исполнение переиспользует sub-agent-loop с tools-whitelist.
 *
 * Источники:
 *   ~/.verstak/agents/*.md         — user-scope
 *   {project}/.verstak/agents/*.md — project-scope (перебивает user по имени)
 *
 * Формат:
 *   ---
 *   name: ui-reviewer
 *   description: Ревьюит React-компоненты на доступность и craft
 *   tools: read_file, search_project, find_references   # whitelist; пусто = read-only набор
 *   model: claude-sonnet-4-6                            # опц.
 *   provider: claude                                    # опц.
 *   ---
 *   Тело = system prompt субагента (его специализация/инструкция).
 */

import { readdirSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface UserAgent {
  /** Уникальный id: 'user:ui-reviewer' | 'project:ui-reviewer'. */
  id: string
  /** Имя субагента (по нему делегируют). */
  name: string
  scope: 'user' | 'project'
  description: string
  /** Whitelist имён инструментов. Пусто → исполнитель получит read-only набор роли. */
  tools: string[]
  /** Опц. провайдер для субагента. */
  provider?: string
  /** Опц. модель в рамках провайдера. */
  model?: string
  /** Тело — system prompt субагента. */
  systemPrompt: string
  filePath: string
}

const USER_AGENTS_DIR = join(homedir(), '.verstak', 'agents')
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseAgentFile(raw: string): {
  name?: string; description?: string; tools: string[]; provider?: string; model?: string; body: string
} {
  const m = raw.match(FRONTMATTER_RE)
  const result: { name?: string; description?: string; tools: string[]; provider?: string; model?: string; body: string } = {
    tools: [], body: m ? raw.slice(m[0].length).trim() : raw.trim()
  }
  if (!m) return result
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const val = kv[2].trim().replace(/^['"]|['"]$/g, '')
    if (key === 'name') result.name = val
    else if (key === 'description') result.description = val
    else if (key === 'provider') result.provider = val
    else if (key === 'model') result.model = val
    else if (key === 'tools') result.tools = val.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
  }
  return result
}

function loadAgentsFromDir(dir: string, scope: 'user' | 'project'): UserAgent[] {
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  let files: string[]
  try { files = readdirSync(dir) } catch { return [] }
  const out: UserAgent[] = []
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    try {
      const parsed = parseAgentFile(readFileSync(join(dir, f), 'utf8'))
      const name = parsed.name ?? f.slice(0, -3)
      out.push({
        id: `${scope}:${name}`,
        name,
        scope,
        description: parsed.description ?? '',
        tools: parsed.tools,
        provider: parsed.provider,
        model: parsed.model,
        systemPrompt: parsed.body,
        filePath: join(dir, f)
      })
    } catch (err) {
      console.error(`[user-agents] load ${f} failed:`, err)
    }
  }
  return out
}

/** Все субагенты: user + project (project перебивает user по имени). */
export function loadUserAgents(projectPath: string | null): UserAgent[] {
  const byName = new Map<string, UserAgent>()
  for (const a of loadAgentsFromDir(USER_AGENTS_DIR, 'user')) byName.set(a.name, a)
  if (projectPath) {
    for (const a of loadAgentsFromDir(join(projectPath, '.verstak', 'agents'), 'project')) byName.set(a.name, a)
  }
  return [...byName.values()]
}

/** Найти субагента по имени (для delegate_task agent='...'). null если нет. */
export function findUserAgent(projectPath: string | null, name: string): UserAgent | null {
  if (!name) return null
  return loadUserAgents(projectPath).find(a => a.name === name) ?? null
}
