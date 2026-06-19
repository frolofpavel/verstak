/**
 * Профиль проекта (v3, Шаг C). Machine-readable снимок проекта, который
 * инжектится в КАЖДУЮ сессию агента — чтобы модель не собирала контекст заново
 * каждый раз. Вдохновлено ClawCode `info/brief`+`info/analyze`: профиль пишется
 * «для AI-агентов, не для людей», структурным JSON, из брифа И/ИЛИ авто-скана репо.
 *
 * Здесь: тип + сборка блока для context-pack + safe-parse + промпт извлечения.
 * Без UI/БД — тестируется напрямую. Хранение — settings (ключ по проекту),
 * инъекция — buildContextPack.
 */

export interface ProjectProfile {
  /** 1–2 предложения: что это за проект. */
  summary?: string
  /** Цель / какую задачу решает. */
  goal?: string
  /** Кто пользователь / аудитория. */
  audience?: string
  /** Стек / ключевые технологии и инструменты. */
  stack?: string
  /** Конвенции, важные правила, чего избегать. */
  conventions?: string
  /** Ключевые файлы/директории (точки входа). */
  keyPaths?: string
}

const FIELD_LABELS: Array<[keyof ProjectProfile, string]> = [
  ['summary', 'суть'],
  ['goal', 'цель'],
  ['audience', 'аудитория'],
  ['stack', 'стек'],
  ['conventions', 'конвенции'],
  ['keyPaths', 'ключевые пути'],
]

/** Есть ли в профиле хоть одно непустое поле. */
export function profileHasContent(p: ProjectProfile | null | undefined): boolean {
  if (!p) return false
  return FIELD_LABELS.some(([k]) => (p[k] ?? '').toString().trim().length > 0)
}

/**
 * Блок профиля для context-pack. Только непустые поля. '' если профиль пуст
 * (тогда вызывающий ничего не инжектит).
 */
export function buildProfileBlock(p: ProjectProfile | null | undefined): string {
  if (!profileHasContent(p)) return ''
  const lines: string[] = ['## Профиль проекта (известно об этом проекте)']
  for (const [key, label] of FIELD_LABELS) {
    const v = (p![key] ?? '').toString().trim()
    if (v) lines.push(`${label}: ${v}`)
  }
  return lines.join('\n')
}

/** Безопасный парс профиля из JSON (из settings / вывода модели). null при мусоре. */
export function safeParseProfile(json: string | null | undefined): ProjectProfile | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') return null
    const out: ProjectProfile = {}
    for (const [key] of FIELD_LABELS) {
      const v = raw[key]
      if (typeof v === 'string' && v.trim()) out[key] = v.trim()
    }
    return profileHasContent(out) ? out : null
  } catch {
    return null
  }
}

/** Относительный путь профиля в проекте (директория-конвенция приложения). */
export const PROFILE_REL_PATH = '.verstak/profile.json'

/**
 * Загрузить профиль проекта из `.verstak/profile.json`. Никогда не бросает —
 * нет файла / битый JSON → null (context-pack просто не инжектит блок).
 */
export async function loadProjectProfile(projectPath: string): Promise<ProjectProfile | null> {
  try {
    const { readFile } = await import('fs/promises')
    const { join } = await import('path')
    const raw = await readFile(join(projectPath, '.verstak', 'profile.json'), 'utf8')
    return safeParseProfile(raw)
  } catch {
    return null
  }
}

/** Промпт извлечения профиля (для онбординга / авто-скана репо). */
export const EXTRACT_PROFILE_PROMPT = [
  'Собери профиль этого проекта для будущих сессий AI-агента. Пиши ДЛЯ АГЕНТА, не для человека:',
  'конкретно, без воды, без общих фраз. Изучи README, package.json, структуру src/, конфиги.',
  `Сохрани результат в файл ${PROFILE_REL_PATH} — валидный JSON с полями (любое опусти, если неизвестно):`,
  '{ "summary", "goal", "audience", "stack", "conventions", "keyPaths" }',
].join('\n')
