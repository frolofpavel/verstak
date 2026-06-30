/**
 * Output Styles — переключаемый ФОРМАТ/ПЕРСОНА ответа агента, ортогонально режиму.
 *
 * Аналог Claude Code output-styles. У Verstak 5 режимов агента (ask/accept/plan/
 * auto/bypass) — это политика ПРАВОК. Output style — отдельная ось «как агент
 * разговаривает/форматирует», настраиваемая пользователем БЕЗ правки скилла или
 * system-layer. Стиль инжектится в system prompt секцией поверх базового протокола
 * (не отменяет его — только формат изложения).
 *
 * Источники:
 *   built-in   — захардкоженные стили ниже (default/concise/explanatory/formal/bullet)
 *   user:<name> — .md в ~/.verstak/output-styles/  (frontmatter name/description, тело = промпт)
 *   project:<name> — {project}/.verstak/output-styles/  (перебивает user по имени)
 *
 * default → пустой промпт (стиль из system-layer/скилла, ничего не добавляем).
 */

import { readdirSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface OutputStyle {
  /** Уникальный id: 'default' | 'concise' | ... | 'user:teacher' | 'project:brief'. */
  id: string
  /** Отображаемое имя. */
  name: string
  /** Краткое описание для пикера. */
  description: string
  /** Текст, инжектируемый в system prompt. Пустой = ничего не добавлять. */
  prompt: string
  /** Источник стиля. */
  scope: 'built-in' | 'user' | 'project'
}

/** Встроенные стили. default намеренно с пустым prompt — базовый стиль без надстройки. */
export const BUILT_IN_STYLES: OutputStyle[] = [
  {
    id: 'default',
    name: 'Обычный',
    description: 'Базовый стиль (как задано в протоколе и скилле). Без надстройки.',
    prompt: '',
    scope: 'built-in'
  },
  {
    id: 'concise',
    name: 'Кратко',
    description: 'Минимум слов: только результат и следующий шаг, без преамбул.',
    prompt: '## Стиль ответа: кратко\nОтвечай предельно лаконично. Только суть: что сделано, что изменилось, следующий шаг. Никаких преамбул, повторов вопроса, извинений и «давайте я...». Маркированные списки вместо абзацев где можно. Если нечего добавить — не добавляй.',
    scope: 'built-in'
  },
  {
    id: 'explanatory',
    name: 'С пояснениями',
    description: 'Объясняет ход мысли и причины решений — обучающий тон.',
    prompt: '## Стиль ответа: с пояснениями\nКратко объясняй ПОЧЕМУ выбрал именно это решение, какие были альтернативы и в чём trade-off. Обучающий тон: пользователь должен понять подход, а не только результат. Не растекайся — 1-3 предложения контекста на ключевое решение, не на каждую строку.',
    scope: 'built-in'
  },
  {
    id: 'formal',
    name: 'Деловой',
    description: 'Формальный деловой тон, без сленга и эмодзи.',
    prompt: '## Стиль ответа: деловой\nФормальный деловой тон. Без сленга, без эмодзи, без фамильярности. Полные предложения, нейтральная лексика. Структурируй ответ заголовками и списками.',
    scope: 'built-in'
  },
  {
    id: 'bullet',
    name: 'Только списки',
    description: 'Ответ строго маркированными пунктами, без абзацев.',
    prompt: '## Стиль ответа: списками\nОтвечай ТОЛЬКО маркированными/нумерованными списками. Никаких сплошных абзацев. Каждый пункт — одна мысль, одна строка. Вложенность для деталей.',
    scope: 'built-in'
  }
]

const USER_STYLES_DIR = join(homedir(), '.verstak', 'output-styles')
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseStyleFile(raw: string): { name?: string; description?: string; body: string } {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { body: raw.trim() }
  const body = raw.slice(m[0].length).trim()
  const result: { name?: string; description?: string; body: string } = { body }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const val = kv[2].trim().replace(/^['"]|['"]$/g, '')
    if (key === 'name') result.name = val
    else if (key === 'description') result.description = val
  }
  return result
}

function loadStylesFromDir(dir: string, scope: 'user' | 'project'): OutputStyle[] {
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  let files: string[]
  try { files = readdirSync(dir) } catch { return [] }
  const out: OutputStyle[] = []
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    try {
      const parsed = parseStyleFile(readFileSync(join(dir, f), 'utf8'))
      const name = parsed.name ?? f.slice(0, -3)
      out.push({
        id: `${scope}:${f.slice(0, -3)}`,
        name,
        description: parsed.description ?? '',
        prompt: parsed.body,
        scope
      })
    } catch (err) {
      console.error(`[output-styles] load ${f} failed:`, err)
    }
  }
  return out
}

/**
 * Все доступные стили: built-in + user + project. Project перебивает user по
 * короткому имени (часть id после двоеточия).
 */
export function loadOutputStyles(projectPath: string | null): OutputStyle[] {
  const byKey = new Map<string, OutputStyle>()
  for (const s of BUILT_IN_STYLES) byKey.set(s.id, s)
  for (const s of loadStylesFromDir(USER_STYLES_DIR, 'user')) byKey.set(s.id.split(':')[1], s)
  if (projectPath) {
    for (const s of loadStylesFromDir(join(projectPath, '.verstak', 'output-styles'), 'project')) {
      byKey.set(s.id.split(':')[1], s)
    }
  }
  return [...byKey.values()]
}

/**
 * Текст стиля для инъекции в system prompt по его id. Пустая строка, если стиль
 * не задан, 'default', или не найден (graceful — не ломаем сборку промпта).
 */
export function resolveOutputStylePrompt(styleId: string | null | undefined, projectPath: string | null): string {
  if (!styleId || styleId === 'default') return ''
  const builtin = BUILT_IN_STYLES.find(s => s.id === styleId)
  if (builtin) return builtin.prompt.trim()
  // user:/project: — ищем по полному id среди загруженных
  const all = loadOutputStyles(projectPath)
  const short = styleId.includes(':') ? styleId.split(':')[1] : styleId
  const found = all.find(s => s.id === styleId || s.id === `user:${short}` || s.id === `project:${short}` || s.id.split(':')[1] === short)
  return found ? found.prompt.trim() : ''
}
