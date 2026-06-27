/**
 * Tier-2 #6 — file-scoped правила: `.verstak/rules/*.mdc`. Каждый .mdc имеет
 * frontmatter (`globs`, `alwaysApply`, `description`) + тело-правило. Когда агент
 * работает с файлом, подходящим под glob, тело правила инжектится в user-layer.
 * Дёшево усиливает user-layer условными правилами (как Cursor .mdc), без deps.
 */

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { parseSkillDoc } from './skills/frontmatter'

export interface FileRule {
  description: string
  globs: string[]
  alwaysApply: boolean
  body: string
}

function normalizeGlobs(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

export function parseRuleFile(content: string): FileRule {
  const { frontmatter: fm, body } = parseSkillDoc(content)
  return {
    description: typeof fm.description === 'string' ? fm.description : '',
    globs: normalizeGlobs(fm.globs),
    alwaysApply: fm.alwaysApply === true,
    body,
  }
}

/** Минимальный glob→regexp без зависимостей: `**` (через /), `*` (сегмент), `?`. */
function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` → любой префикс директорий (включая ноль); `**` в конце → всё
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else {
        re += '[^/]*' // одиночная * не пересекает /
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\/'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

/** Подходит ли путь под glob (разделители нормализуются к /). */
export function matchGlob(glob: string, filePath: string): boolean {
  return globToRegExp(glob).test(filePath.replace(/\\/g, '/'))
}

function ruleMatches(rule: FileRule, files: string[]): boolean {
  if (rule.alwaysApply) return true
  if (rule.globs.length === 0) return false // ни globs, ни alwaysApply → правило неактивно
  return rule.globs.some(g => files.some(f => matchGlob(g, f)))
}

/** Правила, активные для текущего набора файлов (alwaysApply + совпавшие по glob). */
export function selectActiveRules(rules: FileRule[], files: string[]): FileRule[] {
  return rules.filter(r => ruleMatches(r, files))
}

/** Загрузить все `.verstak/rules/*.mdc`. Graceful: нет папки/ошибка чтения → []. */
export async function loadFileScopedRules(projectRoot: string): Promise<FileRule[]> {
  const dir = join(projectRoot, '.verstak', 'rules')
  let names: string[]
  try {
    names = (await readdir(dir)).filter(n => n.toLowerCase().endsWith('.mdc'))
  } catch {
    return []
  }
  const out: FileRule[] = []
  for (const name of names.sort()) {
    try {
      const content = await readFile(join(dir, name), 'utf8')
      const rule = parseRuleFile(content)
      if (rule.body.trim()) out.push(rule)
    } catch { /* пропускаем битый файл */ }
  }
  return out
}
