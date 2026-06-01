/**
 * Реестр context loaders для скиллов.
 *
 * Каждый loader = функция которая по запросу скилла подгружает данные
 * (карточка клиента, текущая повестка HH, project_map, ...) и возвращает
 * markdown который инжектится в первое user сообщение нового чата.
 *
 * Источник: V3 Plan раздел 6.4.
 *
 * Лоадеры референсятся из frontmatter скилла:
 *   context_loaders:
 *     - id: client_card
 *       impl: load_client_card
 *       runs_on: slash_arg
 *
 * Здесь регистрируется implementation по имени.
 */

import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export interface LoaderContext {
  /** Аргумент slash-команды если она была: `/dossier alfa` → arg='alfa'. */
  arg?: string
  /** Текущий project root если есть. */
  projectPath: string | null
  /** Settings reader для лоадеров которые лезут в credentials. */
  getSecret?: (key: string) => string | null
}

export interface LoaderResult {
  /** Markdown который попадёт в первое user-message в чате. */
  markdown: string
  /** Опционально — короткий лейбл для Timeline pill «🧠 контекст: {label}». */
  label?: string
}

export type ContextLoader = (ctx: LoaderContext) => Promise<LoaderResult | null>

// ============================================================================
// Реестр
// ============================================================================

const REGISTRY: Record<string, ContextLoader> = {
  load_client_card,
  load_clients_list,
  load_today_brief
}

export function lookupLoader(impl: string): ContextLoader | null {
  return REGISTRY[impl] ?? null
}

export function listLoaders(): string[] {
  return Object.keys(REGISTRY)
}

// ============================================================================
// Реализации лоадеров — без external creds, работают сразу
// ============================================================================

/**
 * load_client_card — читает фасад клиента из ~/.claude/agents/agent-client-{slug}.md
 *
 * Используется в client-cycle скилле когда вызывается через slash с аргументом
 * («/client-cycle my-client»). Лоадер достаёт agent-client-{slug}.md,
 * вытаскивает блок «## ФАСАД» если есть, инжектит в контекст чата.
 *
 * Примечание: custom loader — требует наличия файлов agent-client-*.md
 * в ~/.claude/agents/. Если файлов нет — лоадер вернёт подсказку.
 */
async function load_client_card(ctx: LoaderContext): Promise<LoaderResult | null> {
  if (!ctx.arg) {
    return {
      markdown: '_(подсказка: укажи slug клиента — например `/client-cycle alfa-development`. Текущий запуск без slug)_',
      label: 'нет slug'
    }
  }
  const slug = ctx.arg.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const path = join(homedir(), '.claude', 'agents', `agent-client-${slug}.md`)
  try {
    const raw = await readFile(path, 'utf8')
    // Вытаскиваем фасад (между ## ФАСАД и следующим ##)
    const m = raw.match(/##\s+ФАСАД[\s\S]*?(?=\n##\s+|$)/)
    const card = m ? m[0].trim() : raw.slice(0, 2000)
    return {
      markdown: `## 📋 Карточка клиента: ${slug}\n\n${card}\n\n_Источник: ${path}_`,
      label: `карточка ${slug}`
    }
  } catch {
    return {
      markdown: `_(не нашёл карточку клиента «${slug}» по пути ${path}. Если slug правильный — создай файл, иначе уточни)_`,
      label: `нет: ${slug}`
    }
  }
}

/**
 * load_clients_list — перечисляет клиентов из
 * ~/.claude/agents/agent-client-*.md (имена и краткие описания).
 *
 * Примечание: custom loader — требует наличия файлов agent-client-*.md
 * в ~/.claude/agents/.
 */
async function load_clients_list(ctx: LoaderContext): Promise<LoaderResult | null> {
  void ctx
  const dir = join(homedir(), '.claude', 'agents')
  try {
    const files = await readdir(dir)
    const clientFiles = files.filter(f => f.startsWith('agent-client-') && f.endsWith('.md'))
    if (clientFiles.length === 0) {
      return { markdown: '_(нет файлов agent-client-*.md в ~/.claude/agents/)_', label: 'пусто' }
    }
    const lines: string[] = ['## 👥 Клиенты агентства', '']
    for (const f of clientFiles.sort()) {
      const slug = f.replace(/^agent-client-/, '').replace(/\.md$/, '')
      try {
        const raw = await readFile(join(dir, f), 'utf8')
        // Берём description из frontmatter и/или первую строку после ##
        const descM = raw.match(/description:\s*(.+)/)
        const desc = descM ? descM[1].split('|')[0].trim().slice(0, 100) : ''
        lines.push(`- **${slug}** — ${desc}`)
      } catch {
        lines.push(`- **${slug}**`)
      }
    }
    return { markdown: lines.join('\n'), label: `${clientFiles.length} клиентов` }
  } catch {
    return null
  }
}

/**
 * load_today_brief — простая дата + день недели как orientation marker.
 *
 * Используется в bos-pilot для morning brief — агент знает «сегодня
 * пятница 23 мая, до конца недели рабочий день».
 */
async function load_today_brief(ctx: LoaderContext): Promise<LoaderResult | null> {
  void ctx
  const now = new Date()
  const days = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
  const dayOfWeek = days[now.getDay()]
  const dateStr = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const isWeekend = now.getDay() === 0 || now.getDay() === 6
  return {
    markdown: `## 📅 Сейчас\n\n**${dayOfWeek}, ${dateStr}, ${time}**\n${isWeekend ? '_Выходной день._' : '_Рабочий день._'}`,
    label: dayOfWeek
  }
}
