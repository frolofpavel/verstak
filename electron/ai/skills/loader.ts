/**
 * Skill loader — собирает скиллы из 3 источников по приоритету:
 *
 *   1. SERVER API (your-skills-server.example.com/api/skills) — основной источник
 *      для команды. Эндпоинт настраивается в Settings.
 *      Реализация падает gracefully (timeout 5s) и переходит к local.
 *   2. ~/.verstak/skills/*.md — пользовательские личные.
 *   3. BUILT_IN_SKILLS — гарантированный baseline в коде.
 *
 * Если скилл с одинаковым id встречается в нескольких источниках — приоритет
 * server > user > built-in (свежий перебивает старый).
 */

import { readdir, readFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { parseSkillDoc } from './frontmatter'
import { parseRecipe } from './recipe'
import { BUILT_IN_SKILLS } from './built-in'
import type { Skill, SkillFrontmatter } from './types'
import type { ProviderId } from '../registry'
import type { AgentMode } from '../mode-policy'

export const USER_SKILLS_DIR = join(homedir(), '.verstak', 'skills')
/** Папка скиллов Claude Code — для migration / sharing. Если у пользователя там
 *  уже лежат скиллы из Claude Code, они автоматически появятся в Verstak без
 *  копирования. Помечаются source='user'. Если в обоих директориях есть
 *  файл с одинаковым id — .verstak/skills/ имеет приоритет (это явный
 *  GG-override). */
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills')
/** Grok Build CLI — те же скиллы что в ~/.grok/skills/{id}/SKILL.md и bundled. */
const GROK_SKILL_ROOTS = [
  join(homedir(), '.grok', 'skills'),
  join(homedir(), '.grok', 'bundled', 'skills')
]
const SERVER_TIMEOUT_MS = 5_000

/** Конфиг loader — путь к серверу читается из settings. */
export interface LoaderConfig {
  /** Например 'https://your-skills-server.example.com'. Пусто = серверный источник пропускается. */
  serverBase?: string | null
  /** Доп. пользовательские директории помимо ~/.verstak/skills/. */
  extraDirs?: string[]
}

export interface LoadResult {
  skills: Skill[]
  /** Источники и сколько пришло из каждого. */
  stats: { server: number; user: number; builtIn: number; failed: string[] }
  serverReachable: boolean
}

export async function loadAllSkills(config: LoaderConfig = {}): Promise<LoadResult> {
  const failed: string[] = []
  const byId = new Map<string, Skill>()

  // 1) Built-in идут первыми, перебиваются user / server.
  for (const s of BUILT_IN_SKILLS) byId.set(s.id, s)

  // 2) User skills. Источники по приоритету (поздние перебивают):
  //    (a) ~/.claude/skills/ — если у пользователя там уже лежат скиллы из
  //        Claude Code, забираем их автоматически. Это даёт мгновенный
  //        bootstrap для пользователей которые мигрируют из Claude Code.
  //    (b) ~/.verstak/skills/ — личные скиллы пользователя (приоритетнее claude).
  //    (c) extraDirs — для тестов / опытов.
  const userDirs = [CLAUDE_SKILLS_DIR, USER_SKILLS_DIR, ...(config.extraDirs ?? [])]
  let userCount = 0
  for (const dir of userDirs) {
    try {
      const skills = await loadFromDir(dir)
      for (const s of skills) {
        byId.set(s.id, s)
        userCount++
      }
    } catch (err) {
      failed.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const root of GROK_SKILL_ROOTS) {
    try {
      const skills = await loadFromGrokTree(root)
      for (const s of skills) {
        byId.set(s.id, s)
        userCount++
      }
    } catch (err) {
      failed.push(`${root}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 3) Server API — последний, чтобы перебивал остальное
  let serverCount = 0
  let serverReachable = false
  if (config.serverBase) {
    try {
      const serverSkills = await loadFromServer(config.serverBase)
      for (const s of serverSkills) {
        byId.set(s.id, s)
        serverCount++
      }
      serverReachable = true
    } catch (err) {
      failed.push(`server ${config.serverBase}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    skills: [...byId.values()],
    stats: {
      server: serverCount,
      user: userCount,
      builtIn: BUILT_IN_SKILLS.length,
      failed
    },
    serverReachable
  }
}

async function loadFromGrokTree(root: string): Promise<Skill[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const out: Skill[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const skillPath = join(root, ent.name, 'SKILL.md')
    try {
      const raw = await readFile(skillPath, 'utf8')
      const skill = parseSkillFile(raw, skillPath, 'user', ent.name)
      if (skill) out.push(skill)
    } catch {
      // no SKILL.md in this folder — skip
    }
  }
  return out
}

async function loadFromDir(dir: string): Promise<Skill[]> {
  // Создаём директорию если её нет — это упрощает первый запуск
  try { await mkdir(dir, { recursive: true }) } catch { /* ignore */ }
  const files = await readdir(dir).catch(() => [] as string[])
  const out: Skill[] = []
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    const path = join(dir, f)
    try {
      const raw = await readFile(path, 'utf8')
      const skill = parseSkillFile(raw, path, 'user')
      if (skill) out.push(skill)
    } catch (err) {
      console.error(`[skills] load ${path} failed:`, err)
    }
  }
  return out
}

async function loadFromServer(serverBase: string): Promise<Skill[]> {
  const url = `${serverBase.replace(/\/+$/, '')}/api/skills`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SERVER_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} from /api/skills`)
    const payload = await res.json() as { skills?: Array<{ id: string; raw: string; sourceRef?: string }> }
    if (!Array.isArray(payload.skills)) {
      throw new Error('Server response: no `skills` array')
    }
    const out: Skill[] = []
    for (const entry of payload.skills) {
      // Per-entry try/catch (как в loadFromDir): один битый серверный скилл
      // (например без поля raw) не должен ронять загрузку ВСЕХ остальных (B8).
      try {
        const skill = parseSkillFile(entry.raw, entry.sourceRef ?? `server:${entry.id}`, 'server')
        if (skill) out.push(skill)
      } catch (err) {
        console.error(`[skills] server skill ${entry?.id ?? '?'} failed:`, err)
      }
    }
    return out
  } finally {
    clearTimeout(timeout)
  }
}

function parseSkillFile(
  raw: string,
  sourceRef: string,
  source: Skill['source'],
  folderId?: string
): Skill | null {
  const doc = parseSkillDoc(raw)
  const fm = doc.frontmatter as Partial<SkillFrontmatter>
  const id =
    (typeof fm.id === 'string' && fm.id) ||
    (typeof fm.name === 'string' && fm.name) ||
    folderId
  if (!id) {
    console.warn(`[skills] ${sourceRef}: missing id/name in frontmatter, skipping`)
    return null
  }
  const slash =
    (typeof fm.slash === 'string' && fm.slash) ||
    (typeof fm.name === 'string' && fm.name.replace(/^\//, '')) ||
    folderId
  return {
    id,
    name: typeof fm.name === 'string' ? fm.name : id,
    description: fm.description,
    icon: fm.icon,
    default_provider: fm.default_provider as ProviderId | undefined,
    default_model: fm.default_model,
    default_mode: fm.default_mode as AgentMode | undefined,
    slash,
    tools_allow: fm.tools_allow,
    suggested_prompts: fm.suggested_prompts,
    context_loaders: fm.context_loaders,
    // Этап 4: recipe-блок опционален и fail-soft — невалидный → undefined,
    // скилл остаётся обычным скиллом (парсинг в recipe.ts).
    recipe: parseRecipe((doc.frontmatter as { recipe?: unknown }).recipe),
    systemPrompt: doc.body,
    source,
    sourceRef
  }
}
