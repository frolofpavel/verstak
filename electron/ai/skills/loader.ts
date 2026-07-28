/**
 * Skill loader — собирает скиллы из 3 источников по приоритету:
 *
 *   1. SERVER API (your-skills-server.example.com/api/skills) — основной источник
 *      для команды. Эндпоинт настраивается в Settings.
 *      Реализация падает gracefully (timeout 5s) и переходит к local.
 *   2. Локальные корни — см. SKILL_ROOTS_IN_PRIORITY_ORDER: адаптеры чужих CLI
 *      (~/.claude, ~/.codex, ~/.grok) и личная ~/.verstak/skills. В каждом корне
 *      читаются ОБА формата: одиночные *.md и папки со SKILL.md внутри.
 *   3. BUILT_IN_SKILLS — гарантированный baseline в коде.
 *
 * Если скилл с одинаковым id встречается в нескольких источниках — приоритет
 * server > user > built-in (свежий перебивает старый).
 */

import { readdir, readFile, mkdir } from 'fs/promises'
import { basename, extname, join } from 'path'
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
/** Codex CLI — та же конвенция, что у Claude Code: одиночные *.md и папки со SKILL.md. */
const CODEX_SKILLS_DIR = join(homedir(), '.codex', 'skills')
/** Grok Build CLI — те же скиллы что в ~/.grok/skills/{id}/SKILL.md и bundled. */
const GROK_SKILL_ROOTS = [
  join(homedir(), '.grok', 'skills'),
  join(homedir(), '.grok', 'bundled', 'skills')
]

/**
 * Корни личных скиллов в порядке ОТ СЛАБОГО К СИЛЬНОМУ: при совпадении id
 * побеждает тот, кто ниже по списку, и делает это молча — конфликт-репорта нет.
 *
 * Адаптеры чужих CLI (claude / codex / grok) идут первыми: это чужой канон, к
 * которому Verstak подключается «как есть». Личная папка ~/.verstak/skills —
 * сильнее любого адаптера: это явный override пользователя. Ещё сильнее только
 * extraDirs (см. LoaderConfig) — папка, которую человек указал руками.
 *
 * ВАЖНО: grok раньше стоял ПОСЛЕ ~/.verstak и перебивал личные скиллы. Это
 * противоречило заявленному в комментарии приоритету «.verstak — явный
 * GG-override»; порядок приведён к нему.
 */
export const SKILL_ROOTS_IN_PRIORITY_ORDER: readonly string[] = [
  CLAUDE_SKILLS_DIR,
  CODEX_SKILLS_DIR,
  ...GROK_SKILL_ROOTS,
  USER_SKILLS_DIR
]
const SERVER_TIMEOUT_MS = 5_000

/** Конфиг loader — путь к серверу читается из settings. */
export interface LoaderConfig {
  /** Например 'https://your-skills-server.example.com'. Пусто = серверный источник пропускается. */
  serverBase?: string | null
  /** Доп. пользовательские директории помимо ~/.verstak/skills/. */
  extraDirs?: string[]
  /**
   * ПОЛНАЯ замена корней вместо `SKILL_ROOTS_IN_PRIORITY_ORDER` (порядок тот же:
   * поздние перебивают ранних). Нужен изоляции: без него любая проверка загрузчика
   * обходит РЕАЛЬНЫЕ домашние деревья машины, где их может быть сколько угодно.
   *
   * Найдено 28.07 замером: на машине с адаптерами чужих CLI это 272 скилла и 778
   * файлов, ~300 мс НА КАЖДЫЙ вызов. Для приложения это приемлемо (один раз при
   * старте), а для набора из тринадцати вызовов под параллельной нагрузкой —
   * четыре теста, упавших в общий 20-секундный таймаут. Лечение — убрать лишнюю
   * работу, а не поднять лимит: сам продукт при этом не меняется, поле
   * необязательное и прод его не передаёт.
   */
  roots?: readonly string[]
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
  const userDirs = [...(config.roots ?? SKILL_ROOTS_IN_PRIORITY_ORDER), ...(config.extraDirs ?? [])]
  let userCount = 0
  for (const dir of userDirs) {
    try {
      const skills = await loadFromRoot(dir)
      for (const s of skills) {
        byId.set(s.id, s)
        userCount++
      }
    } catch (err) {
      failed.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 3) Server API — последний, чтобы перебивал остальное
  let serverCount = 0
  let serverReachable = false
  if (config.serverBase) {
    try {
      const serverSkills = await loadFromServer(config.serverBase)
      // 2.0.0 + ре-ревью: server-скилл НЕ перебивает НИ built-in, НИ уже загруженный
      // user-скилл (своя машина). Скомпрометированный сервер иначе подменил бы и
      // доверенный baseline, и личный /deploy c tools_allow:[run_command]. byId к этому
      // моменту содержит built-in + user (server грузится последним) → блокируем override
      // любого существующего id, добавляем только НОВЫЕ server-скиллы.
      for (const s of serverSkills) {
        if (byId.has(s.id)) {
          failed.push(`server skill «${s.id}» отклонён: нельзя перебить существующий (built-in/user) id`)
          continue
        }
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

/**
 * Один корень скиллов — ОБА формата сразу:
 *   · одиночные `<root>/имя.md` — исторический формат Verstak;
 *   · папки `<root>/имя/SKILL.md` — формат Claude Code / Codex / Grok, рядом с
 *     которым обычно лежит `references/`.
 *
 * Так один и тот же корень читается независимо от того, чем скилл создан. Папки
 * сканируются ПОСЛЕ файлов: при совпадении id внутри одного корня побеждает
 * папочная форма (у неё есть собственный каталог и она обычно новее).
 *
 * Вложенные каталоги (`references/`, `assets/`) отдельными скиллами не считаются:
 * скиллом становится ровно `SKILL.md` в папке первого уровня.
 */
async function loadFromRoot(root: string): Promise<Skill[]> {
  return [...await loadSingleFiles(root), ...await loadFolderTree(root)]
}

async function loadFolderTree(root: string): Promise<Skill[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const out: Skill[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const skillPath = join(root, ent.name, 'SKILL.md')
    try {
      const raw = await readFile(skillPath, 'utf8')
      // folderId — запасной id/slash: имя папки. Frontmatter, если он их задал,
      // всё равно сильнее (см. parseSkillFile).
      const skill = parseSkillFile(raw, skillPath, 'user', ent.name)
      if (skill) out.push(skill)
    } catch {
      // в папке нет SKILL.md — молча пропускаем, это не ошибка
    }
  }
  return out
}

async function loadSingleFiles(dir: string): Promise<Skill[]> {
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
  // 2.0.0 security (аудит): server-скиллы становятся system prompt + tools_allow агента.
  // По http:// их подменяет MITM. Требуем https (кроме localhost для dev).
  const u = new URL(serverBase)
  // WHATWG URL сохраняет скобки IPv6: hostname('http://[::1]') === '[::1]' (не '::1').
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !isLocal) {
    throw new Error(`skills serverBase должен быть https:// (получено ${u.protocol}//). MITM по http подменяет system prompt агента.`)
  }
  const url = `${serverBase.replace(/\/+$/, '')}/api/skills`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SERVER_TIMEOUT_MS)
  try {
    // redirect:'error' — https-энфорс валидировал только первый URL; дефолтный follow
    // тихо пошёл бы за downgrade-редиректом на http. Скилл-endpoint редиректить не должен.
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' })
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

export function parseSkillFile(
  raw: string,
  sourceRef: string,
  source: Skill['source'],
  folderId?: string
): Skill | null {
  if (typeof raw !== 'string') return null
  const normalizedRaw = raw.replace(/^\uFEFF/, '')
  const fileId = basename(sourceRef.includes('#') ? sourceRef.slice(sourceRef.lastIndexOf('#') + 1) : sourceRef, extname(sourceRef))
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  const doc = parseSkillDoc(normalizedRaw)
  const fm = doc.frontmatter as Partial<SkillFrontmatter>
  const id =
    (typeof fm.id === 'string' && fm.id) ||
    (typeof fm.name === 'string' && fm.name) ||
    folderId ||
    (fileId && fileId.toLowerCase() !== 'skill' ? fileId : undefined)
  if (!id) {
    console.warn(`[skills] ${sourceRef}: missing id/name in frontmatter, skipping`)
    return null
  }
  const slash =
    (typeof fm.slash === 'string' && fm.slash) ||
    (typeof fm.name === 'string' && fm.name.replace(/^\//, '')) ||
    folderId ||
    id
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
