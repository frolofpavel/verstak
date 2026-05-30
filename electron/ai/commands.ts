/**
 * User custom commands — лёгкая альтернатива скиллам, аналог opencode custom commands.
 *
 * Команды = .md файлы в двух папках:
 *   ~/.verstak/commands/   → user: область (глобальные для пользователя)
 *   {project}/.verstak/commands/ → project: область (локальные для проекта)
 *
 * Формат файла:
 *   ---
 *   name: review-diff
 *   description: Review the current git diff
 *   ---
 *   Body with $VARIABLES that are prompted before execution.
 *
 * Если команда с одинаковым именем есть и user: и project: — project: выигрывает.
 */

import { readdirSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface UserCommand {
  /** Уникальный id вида 'user:review-diff' или 'project:review-diff'. */
  id: string
  /** Имя команды — filename без .md (например 'review-diff'). */
  name: string
  /** Источник команды. */
  scope: 'user' | 'project'
  /** Описание из frontmatter. */
  description: string
  /** Тело промпта — шаблон с $VARIABLE плейсхолдерами. */
  body: string
  /** Переменные, извлечённые из тела: ['FOCUS_AREA', ...]. */
  variables: string[]
  /** Абсолютный путь к .md файлу. */
  filePath: string
}

const USER_COMMANDS_DIR = join(homedir(), '.verstak', 'commands')
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Простой парсер frontmatter: только key: value скаляры (строки). */
function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { body: raw.trim() }
  const yamlPart = m[1]
  const body = raw.slice(m[0].length).trim()
  const result: { name?: string; description?: string; body: string } = { body }
  for (const line of yamlPart.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const val = kv[2].trim().replace(/^['"]|['"]$/g, '') // снять кавычки
    if (key === 'name') result.name = val
    else if (key === 'description') result.description = val
  }
  return result
}

/** Извлечь $VARIABLE из тела команды. Только заглавные буквы и _. */
function extractVariables(body: string): string[] {
  const found = new Set<string>()
  const re = /\$([A-Z][A-Z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    found.add(m[1])
  }
  return [...found]
}

function loadFromDir(dir: string, scope: 'user' | 'project'): UserCommand[] {
  try {
    mkdirSync(dir, { recursive: true })
  } catch { /* ignore */ }
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const out: UserCommand[] = []
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    const filePath = join(dir, f)
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = parseFrontmatter(raw)
      // filename без .md как дефолтное имя команды
      const cmdName = parsed.name ?? f.slice(0, -3)
      out.push({
        id: `${scope}:${cmdName}`,
        name: cmdName,
        scope,
        description: parsed.description ?? '',
        body: parsed.body,
        variables: extractVariables(parsed.body),
        filePath
      })
    } catch (err) {
      console.error(`[commands] load ${filePath} failed:`, err)
    }
  }
  return out
}

/**
 * Загрузить все команды.
 * Project-команды перебивают user-команды с тем же именем.
 *
 * @param projectPath Путь к корню проекта (или null если проекта нет).
 */
export function loadCommands(projectPath: string | null): UserCommand[] {
  const byName = new Map<string, UserCommand>()

  // User-глобальные идут первыми
  for (const cmd of loadFromDir(USER_COMMANDS_DIR, 'user')) {
    byName.set(cmd.name, cmd)
  }

  // Project-локальные перебивают user
  if (projectPath) {
    const projectCommandsDir = join(projectPath, '.verstak', 'commands')
    for (const cmd of loadFromDir(projectCommandsDir, 'project')) {
      byName.set(cmd.name, cmd)
    }
  }

  return [...byName.values()]
}
