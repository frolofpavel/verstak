/**
 * Session handoff — forward-looking markdown «передача смены».
 *
 * Идея портирована из Agent Studio (app/src/main/handoff/generator.ts):
 * handoff — это документ, который фиксирует ЧТО СДЕЛАНО + ТЕКУЩЕЕ СОСТОЯНИЕ +
 * СЛЕДУЮЩИЙ ШАГ, чтобы контекст переживал смену сессии / рантайма / краш.
 * Закрывает слабое место Verstak: «resume after crash» и длинные сессии
 * (см. CLAUDE.md §5.4).
 *
 * Отличие от session-summary.ts: то резюме смотрит НАЗАД (одна строка факта в
 * память при закрытии чата). Handoff смотрит ВПЕРЁД — это полноценный markdown,
 * по которому новая сессия продолжает работу.
 *
 * Эта версия — чистая детерминированная функция над массивом сообщений
 * (эвристическое извлечение: последний ответ ассистента, tool calls, записи
 * файлов). LLM НЕ вызывается — так модуль тестируемый и работает даже без сети.
 * NOTE: опциональная LLM-polished версия (как runtime.run в AS) может прийти
 * позже отдельным слоем поверх этого baseline.
 */

import type { ChatMessage } from './types'

export interface HandoffOptions {
  /** Заголовок чата / задачи — попадает в шапку. */
  title?: string
  /** Имя провайдера / модели, на которой шла сессия. */
  provider?: string
  /** Id родительского handoff'а — для цепочки baseline → incremental. */
  parentId?: string | null
  /** Момент генерации (для тестируемости). По умолчанию — Date.now(). */
  now?: number
  /** Runtime-сводка из agent_runs: статусы, счетчики и последние события. */
  runSummary?: HandoffRunSummary | null
}

export interface HandoffRunSummary {
  runs: number
  toolCount: number
  filesCount: number
  agentsCount: number
  durationMs: number
  recentRuns?: Array<{
    title: string
    status: string
    provider?: string | null
    model?: string | null
    startedAt?: number | null
    endedAt?: number | null
    error?: string | null
    toolCount?: number | null
    filesCount?: number | null
    agentsCount?: number | null
  }>
  recentEvents?: Array<{
    label?: string | null
    detail?: string | null
    status?: string | null
    createdAt?: number | null
  }>
}

const MAX_FACTS = 6
const MAX_FILES = 12
const MAX_TURNS = 6

/** Однострочное сжатие: схлопываем пробелы и режем до лимита. */
function compactLine(text: string, limit = 200): string {
  const line = text.trim().replace(/\s+/g, ' ')
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 сек'
  const sec = Math.round(ms / 1000)
  const min = Math.floor(sec / 60)
  const rest = sec % 60
  if (min <= 0) return `${rest} сек`
  return `${min} мин ${rest} сек`
}

function formatRunSummary(summary: HandoffRunSummary | null | undefined): string[] {
  if (!summary || summary.runs <= 0) return ['- Прогоны агента не зафиксированы.']
  const lines: string[] = [
    `- Прогонов агента: ${summary.runs}; инструментов: ${summary.toolCount}; файлов: ${summary.filesCount}; субагентов: ${summary.agentsCount}; суммарное время: ${formatDuration(summary.durationMs)}.`
  ]
  for (const run of summary.recentRuns ?? []) {
    const model = [run.provider, run.model].filter(Boolean).join(' · ') || 'модель не указана'
    const parts = [
      `status=${run.status}`,
      `model=${model}`,
      `tools=${run.toolCount ?? 0}`,
      `files=${run.filesCount ?? 0}`,
    ]
    if (run.error) parts.push(`error=${compactLine(run.error, 90)}`)
    lines.push(`- ${compactLine(run.title || 'Прогон', 90)}: ${parts.join('; ')}.`)
  }
  if (summary.recentEvents?.length) {
    lines.push('- Последние события:')
    for (const event of summary.recentEvents) {
      const label = compactLine(event.label || event.status || 'Событие', 80)
      const detail = event.detail ? ` — ${compactLine(event.detail, 140)}` : ''
      lines.push(`  - ${label}${detail}`)
    }
  }
  return lines.slice(0, 14)
}

/**
 * Извлекает пути файлов, которые агент трогал в сессии.
 * Источники в порядке надёжности:
 *  1. Структурированные toolCalls (write_file / apply_patch / read_file) — args.path.
 *  2. Фоллбэк: regex по тексту assistant-сообщений (как в session-summary.ts),
 *     если toolCalls не сохранены (плоские сообщения из storage/chats.ts).
 */
function extractFiles(messages: ChatMessage[]): { written: string[]; read: string[] } {
  const written = new Set<string>()
  const read = new Set<string>()

  for (const m of messages) {
    if (m.role !== 'assistant') continue
    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const call of m.toolCalls) {
        const path = typeof call.args?.path === 'string' ? call.args.path : null
        if (!path) continue
        if (call.name === 'write_file' || call.name === 'apply_patch') written.add(path)
        else if (call.name === 'read_file') read.add(path)
      }
    } else if (m.content) {
      // Фоллбэк для плоских сообщений без структурированных toolCalls.
      const matches = m.content.matchAll(/(?:write_file|apply_patch)[^"']*["']([^"']+\.\w+)["']/g)
      for (const match of matches) {
        if (match[1]) written.add(match[1])
      }
    }
  }

  return {
    written: [...written].slice(0, MAX_FILES),
    read: [...read].slice(0, MAX_FILES)
  }
}

/** Считает tool calls по имени — для секции «Что сделано». */
function toolCallStats(messages: ChatMessage[]): { total: number; byName: Map<string, number> } {
  const byName = new Map<string, number>()
  let total = 0
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    for (const call of m.toolCalls) {
      total += 1
      byName.set(call.name, (byName.get(call.name) ?? 0) + 1)
    }
  }
  return { total, byName }
}

/** Последнее непустое сообщение ассистента — основа «следующего шага». */
function lastAssistantText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.content && m.content.trim()) return m.content.trim()
  }
  return null
}

/**
 * Эвристически выводит «следующий шаг» из последнего ответа ассистента.
 * Ищем явные маркеры (следующий шаг / next / TODO / надо / осталось). Если
 * маркеров нет — берём последний абзац как лучшее приближение.
 */
function inferNextStep(messages: ChatMessage[]): string {
  const last = lastAssistantText(messages)
  if (!last) return 'Явный следующий шаг не выделен — открой последние сообщения и продолжи с места остановки.'

  const needles = ['следующий шаг', 'next step', 'next:', 'дальше', 'осталось', 'todo', 'надо', 'нужно']
  const lines = last.split('\n').map(l => l.trim()).filter(Boolean)
  for (const line of lines) {
    const low = line.toLowerCase()
    if (needles.some(n => low.includes(n))) return compactLine(line, 240)
  }

  // Маркеров нет — последний абзац как приближение.
  const lastPara = lines[lines.length - 1] ?? last
  return compactLine(lastPara, 240)
}

/**
 * Ключевые факты для продолжения: открытые вопросы и решения.
 * Берём сообщения с маркерами решений/договорённостей (как buildDecisions в AS).
 */
function extractFacts(messages: ChatMessage[]): string[] {
  const needles = ['реш', 'договор', 'делаем', 'зафикс', 'важно', 'учти', 'баг', 'ошибк', 'не работает', 'commit']
  const facts: string[] = []
  for (const m of messages) {
    if (m.role === 'system' || !m.content) continue
    const low = m.content.toLowerCase()
    if (needles.some(n => low.includes(n))) {
      facts.push(compactLine(m.content, 200))
    }
  }
  // Берём последние — они актуальнее.
  return facts.slice(-MAX_FACTS)
}

/** Последние ходы диалога — короткий хвост для контекста. */
function lastTurns(messages: ChatMessage[]): string[] {
  return messages
    .filter(m => m.role !== 'system' && m.content && m.content.trim())
    .slice(-MAX_TURNS)
    .map(m => {
      const who = m.role === 'user' ? 'Pavel' : 'Agent'
      return `- **${who}:** ${compactLine(m.content, 200)}`
    })
}

/**
 * Генерирует markdown-handoff из массива сообщений.
 * Чистая функция: один и тот же вход (+ opts.now) → один и тот же выход.
 */
export function generateHandoff(messages: ChatMessage[], opts: HandoffOptions = {}): string {
  const now = opts.now ?? Date.now()
  const title = (opts.title ?? '').trim() || 'Сессия Verstak'
  const visible = messages.filter(m => m.role !== 'system')

  const files = extractFiles(messages)
  const stats = toolCallStats(messages)
  const facts = extractFacts(messages)
  const turns = lastTurns(messages)
  const nextStep = inferNextStep(messages)
  const runSummary = formatRunSummary(opts.runSummary)

  const userCount = visible.filter(m => m.role === 'user').length

  // --- Что сделано ---
  const doneLines: string[] = []
  doneLines.push(`- Запросов пользователя: ${userCount}, сообщений всего: ${visible.length}.`)
  if (stats.total > 0) {
    const breakdown = [...stats.byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name}×${n}`)
      .join(', ')
    doneLines.push(`- Tool calls: ${stats.total} (${breakdown}).`)
  } else {
    doneLines.push('- Tool calls: не зафиксированы.')
  }

  // --- Текущее состояние ---
  const stateLines: string[] = []
  if (files.written.length > 0) {
    stateLines.push(`- Изменённые файлы: ${files.written.join(', ')}.`)
  } else {
    stateLines.push('- Изменённых файлов не зафиксировано.')
  }
  if (files.read.length > 0) {
    stateLines.push(`- Прочитанные файлы: ${files.read.join(', ')}.`)
  }
  if (turns.length > 0) {
    stateLines.push('- Последние ходы:')
    stateLines.push(...turns)
  }

  // --- Контекст для продолжения ---
  const factLines = facts.length > 0
    ? facts.map(f => `- ${f}`)
    : ['- Явных решений / открытых вопросов не выделено.']

  const parentLine = opts.parentId ? `parent_id: \`${opts.parentId}\`` : 'parent_id: `` (baseline)'
  const providerLine = opts.provider ? `provider: \`${opts.provider}\`` : 'provider: `unknown`'

  return [
    `# Handoff: ${title}`,
    '',
    `_${new Date(now).toISOString()} · ${providerLine} · ${parentLine}_`,
    '',
    '## Что сделано',
    '',
    ...doneLines,
    '',
    '## Прогоны агента',
    '',
    ...runSummary,
    '',
    '## Текущее состояние',
    '',
    ...stateLines,
    '',
    '## Следующий шаг',
    '',
    nextStep,
    '',
    '## Контекст для продолжения',
    '',
    ...factLines,
    '',
    '---',
    '_Сгенерировано детерминированно из истории сообщений. Перед действиями сверяйся с первичными источниками (git, файлы), а не только с этим handoff._',
    ''
  ].join('\n')
}
