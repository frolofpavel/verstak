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

/** Запятые-разделители ВНЕ скобок {…} (чтобы `src/{a,b}/**` не дробилось). */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '{') { depth++; cur += ch }
    else if (ch === '}') { depth = Math.max(0, depth - 1); cur += ch }
    else if (ch === ',' && depth === 0) { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map(x => x.trim()).filter(Boolean)
}

function normalizeGlobs(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return splitTopLevelCommas(v)
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

const MAX_GLOB_LEN = 256
const NEVER = /(?!)/ // не матчит ничего
const globCache = new Map<string, RegExp>()

// Минимальный glob→regexp без зависимостей: двойная-звёздочка (через слэш), одиночная
// (сегмент), '?', '{a,b}' (альтернация). АНТИ-ReDoS: dir-сегменты компилируются в
// (?:[^/]+/)* — не пересекаются, нет catastrophic backtracking от соседних .*; повторы
// схлопываются; патологично длинный glob не компилируется. Результат мемоизируется.
function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob)
  if (cached) return cached

  let result: RegExp
  if (glob.length > MAX_GLOB_LEN) {
    result = NEVER
  } else {
    // схлопываем `(**/)+`→`**/` и `***+`→`**` — убирает соседние unbounded-группы.
    const g = glob.replace(/\\/g, '/').replace(/(\*\*\/)+/g, '**/').replace(/\*{3,}/g, '**')
    let re = ''
    let braceDepth = 0
    for (let i = 0; i < g.length; i++) {
      const c = g[i]
      if (c === '*') {
        if (g[i + 1] === '*') {
          if (g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2 } else { re += '.*'; i += 1 }
        } else {
          re += '[^/]*'
        }
      } else if (c === '?') {
        re += '[^/]'
      } else if (c === '{') {
        re += '(?:'; braceDepth++
      } else if (c === '}' && braceDepth > 0) {
        re += ')'; braceDepth--
      } else if (c === ',' && braceDepth > 0) {
        re += '|'
      } else if ('.+^$()|[]\\/'.includes(c)) {
        re += '\\' + c
      } else {
        re += c
      }
    }
    try {
      result = new RegExp('^' + re + '$')
    } catch {
      result = NEVER // несбалансированные скобки и т.п.
    }
  }
  globCache.set(glob, result)
  return result
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
