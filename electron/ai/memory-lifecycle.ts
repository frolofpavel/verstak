// Memory lifecycle — событие `pre-compress` (пакет 2.1.13).
//
// Проблема, которую решает файл: при сжатии контекста начало диалога заменяется одним
// summary. Всё, что не попало в summary, для следующих ходов просто исчезает — включая
// принятые решения, устойчивые факты о проекте и незакрытые действия. Симметричная
// проблема с другой стороны: автозахват (memory-hooks) пишет в память сырой поток tool
// call'ов, и она превращается в свалку «Записан файл X (123 символов)».
//
// Поэтому здесь ОДИН ограниченный batch на событие, а не поток:
//  · извлекаем только то, что изменит следующую работу (решения, факты, долги, ошибки);
//  · учитываем предыдущий summary — чтобы не переписывать в память то, что уже сжато;
//  · режем по количеству и длине ДО записи;
//  · редактируем секреты ДО записи;
//  · дедуплицируем и внутри пачки, и против уже сохранённого — повторное событие на том
//    же чате не должно плодить близнецов;
//  · любая осечка извлечения = пустая пачка, а не исключение: компакция и прогон обязаны
//    завершиться в любом случае.

import type { MemoryType } from '../storage/memories'
import { scanText } from './secret-scanner'

/** Максимум записей за одно событие. Память — не журнал: пачка обязана быть маленькой. */
export const MEMORY_BATCH_LIMIT = 6
/** Максимальная длина одной записи. Длиннее — это уже пересказ, а не факт. */
export const MEMORY_CONTENT_LIMIT = 280
/** Короче — мусор («ок», «сделано»), в память не берём. */
export const MEMORY_CONTENT_MIN = 12
/** Сколько последних сообщений показываем экстрактору как «хвост текущей нити». */
export const TAIL_CONTEXT_MESSAGES = 6

const MEMORY_TYPES = new Set<MemoryType>(['fact', 'decision', 'bug', 'preference', 'pattern'])

/** Тег события — по нему видно, откуда запись, и его же читает будущий session-end. */
export const PRE_COMPRESS_TAG = 'lifecycle:pre-compress'

export interface LifecycleMessage {
  role: string
  content: string
}

export interface MemoryCandidate {
  type: MemoryType
  content: string
  tags: string[]
}

/**
 * Промпт извлечения. Просим строгий JSON-массив: разбор свободного текста в память —
 * это как раз тот путь, на котором в память попадает пересказ вместо факта.
 *
 * previousSummary отдаётся отдельно и с явной инструкцией: уже сжатое повторно в память
 * не тащим. Хвост последних ходов показываем целиком — без него экстрактор не видит,
 * какая нить сейчас открыта, и «незакрытые действия» вырождаются в пересказ начала.
 */
export function buildPreCompressPrompt(input: {
  messages: LifecycleMessage[]
  previousSummary?: string | null
  tailMessages?: number
}): { system: string; user: string } {
  const tailCount = input.tailMessages ?? TAIL_CONTEXT_MESSAGES
  const tail = input.messages.slice(-tailCount)
  const body = input.messages
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`)
    .join('\n\n')
  const tailBody = tail
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`)
    .join('\n\n')

  const system = [
    'Ты извлекаешь из рабочего диалога то, что должно пережить сжатие контекста.',
    'Это НЕ пересказ. Записывай только то, что изменит следующую работу над проектом.',
    '',
    'Бери: принятые решения и их причину; устойчивые факты о проекте (пути, схемы,',
    'договорённости, ограничения); незакрытые действия и долги; ошибки, которые важно',
    'не повторить.',
    'НЕ бери: пересказ диалога, ход рассуждений, содержимое файлов и выводы команд,',
    'вежливости, промежуточные статусы («сделал», «проверяю»), то что уже есть в',
    'предыдущем итоге.',
    '',
    `Верни СТРОГО JSON-массив, не более ${MEMORY_BATCH_LIMIT} элементов, без пояснений:`,
    '[{"type":"decision|fact|bug|preference|pattern","content":"...","tags":["..."]}]',
    `content — одно плотное предложение по-русски, до ${MEMORY_CONTENT_LIMIT} символов.`,
    'Нечего сохранять — верни [].',
    'Не выдумывай: пропуск лучше вымысла.',
  ].join('\n')

  const user = [
    input.previousSummary?.trim()
      ? `Уже сжато ранее (повторно НЕ сохранять):\n${input.previousSummary.trim()}\n`
      : '',
    `Часть диалога, которая уходит под сжатие:\n\n${body}`,
    tailBody ? `\n\nТекущая нить (последние ходы, для понимания что открыто):\n\n${tailBody}` : '',
  ].filter(Boolean).join('\n')

  return { system, user }
}

/**
 * Разбор ответа модели. Терпим к обёрткам (```json, текст вокруг), но не к мусору:
 * что не разобралось — пустая пачка, а не исключение.
 */
export function parseMemoryCandidates(raw: string): MemoryCandidate[] {
  if (!raw || !raw.trim()) return []
  const attempts: string[] = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) attempts.push(fenced[1])
  attempts.push(raw)
  const bare = raw.match(/\[[\s\S]*\]/)
  if (bare?.[0]) attempts.push(bare[0])

  for (const attempt of attempts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(attempt.trim())
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    const out: MemoryCandidate[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const content = typeof rec.content === 'string' ? rec.content : ''
      if (!content.trim()) continue
      const type = typeof rec.type === 'string' && MEMORY_TYPES.has(rec.type as MemoryType)
        ? rec.type as MemoryType
        : 'fact'
      const tags = Array.isArray(rec.tags)
        ? rec.tags.filter((t): t is string => typeof t === 'string')
        : []
      out.push({ type, content, tags })
    }
    return out
  }
  return []
}

/** Ключ сравнения: регистр, пунктуация и пробелы не должны создавать «новый» факт. */
export function memoryKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export type SkipReason = 'too-short' | 'duplicate-in-batch' | 'duplicate-existing' | 'over-limit'

export interface NormalizedBatch {
  accepted: MemoryCandidate[]
  skipped: Array<{ reason: SkipReason; content: string }>
  /** Сколько записей несли секреты и были отредактированы. */
  redactedCount: number
}

/**
 * Приведение пачки к безопасному и ограниченному виду. Порядок шагов важен:
 * редакция ДО обрезки и ДО сравнения — иначе обрезанный секрет уедет в память,
 * а дедуп будет сравнивать разные тексты одного и того же факта.
 */
export function normalizeMemoryBatch(
  candidates: MemoryCandidate[],
  opts: {
    /** Уже сохранённые тексты памяти проекта — против них дедуплицируем. */
    existing?: string[]
    limit?: number
    contentLimit?: number
    minLength?: number
    /** Тег события, который добавляем каждой записи. */
    tag?: string
  } = {},
): NormalizedBatch {
  const limit = opts.limit ?? MEMORY_BATCH_LIMIT
  const contentLimit = opts.contentLimit ?? MEMORY_CONTENT_LIMIT
  const minLength = opts.minLength ?? MEMORY_CONTENT_MIN
  const eventTag = opts.tag ?? PRE_COMPRESS_TAG
  const existingKeys = new Set((opts.existing ?? []).map(memoryKey))
  const batchKeys = new Set<string>()

  const accepted: MemoryCandidate[] = []
  const skipped: NormalizedBatch['skipped'] = []
  let redactedCount = 0

  for (const candidate of candidates) {
    const scan = scanText(candidate.content.trim())
    if (scan.hits.length > 0) redactedCount++
    let content = scan.redacted.replace(/\s+/gu, ' ').trim()
    if (content.length > contentLimit) content = content.slice(0, contentLimit - 1).trimEnd() + '…'
    if (content.length < minLength) {
      skipped.push({ reason: 'too-short', content })
      continue
    }
    const key = memoryKey(content)
    if (batchKeys.has(key)) {
      skipped.push({ reason: 'duplicate-in-batch', content })
      continue
    }
    if (existingKeys.has(key)) {
      skipped.push({ reason: 'duplicate-existing', content })
      continue
    }
    if (accepted.length >= limit) {
      skipped.push({ reason: 'over-limit', content })
      continue
    }
    batchKeys.add(key)
    const tags = candidate.tags
      .map(t => t.trim().slice(0, 24))
      .filter(Boolean)
      .slice(0, 3)
    accepted.push({ type: candidate.type, content, tags: [...tags, eventTag] })
  }

  return { accepted, skipped, redactedCount }
}

export interface PreCompressCaptureResult {
  ok: boolean
  saved: number
  skipped: number
  redacted: number
  /** Причина, если пачка не записана. Диагностика, не ошибка приложения. */
  reason?: 'disabled' | 'nothing-to-extract' | 'extract-failed' | 'save-failed' | 'no-project'
  detail?: string
}

export interface PreCompressCaptureDeps {
  /** Границы памяти: запись всегда в проект чата, никогда «в общую». */
  projectPath: string | null
  messages: LifecycleMessage[]
  previousSummary?: string | null
  /** Вызов модели: тот же одноразовый путь, что и у summary компакции. */
  extract: (prompt: { system: string; user: string }) => Promise<string>
  /** Уже сохранённые тексты памяти проекта — для дедупа против прошлых событий. */
  existingContents: () => string[]
  /** ОДНА атомарная запись пачки. Атомарность обязана быть на стороне вызывающего
   *  (в IPC — транзакция БД): полупачка хуже, чем ни одной записи — часть решений
   *  сохранилась, часть нет, и понять что именно потерялось уже нельзя. */
  saveBatch: (projectPath: string, items: MemoryCandidate[]) => void
  enabled?: boolean
  limit?: number
}

/**
 * Событие `pre-compress` целиком. Никогда не бросает: вызывающий (компакция) обязан
 * завершиться независимо от того, получилось ли извлечь память.
 */
export async function capturePreCompressMemories(deps: PreCompressCaptureDeps): Promise<PreCompressCaptureResult> {
  if (deps.enabled === false) return { ok: false, saved: 0, skipped: 0, redacted: 0, reason: 'disabled' }
  if (!deps.projectPath) return { ok: false, saved: 0, skipped: 0, redacted: 0, reason: 'no-project' }
  if (deps.messages.length === 0) return { ok: false, saved: 0, skipped: 0, redacted: 0, reason: 'nothing-to-extract' }

  let raw: string
  try {
    raw = await deps.extract(buildPreCompressPrompt({
      messages: deps.messages,
      previousSummary: deps.previousSummary,
    }))
  } catch (err) {
    return {
      ok: false, saved: 0, skipped: 0, redacted: 0,
      reason: 'extract-failed',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  const parsed = parseMemoryCandidates(raw)
  if (parsed.length === 0) return { ok: true, saved: 0, skipped: 0, redacted: 0, reason: 'nothing-to-extract' }

  let existing: string[] = []
  try {
    existing = deps.existingContents()
  } catch { /* дедуп best-effort: без него хуже, но не смертельно */ }

  const batch = normalizeMemoryBatch(parsed, { existing, limit: deps.limit })
  if (batch.accepted.length === 0) {
    return { ok: true, saved: 0, skipped: batch.skipped.length, redacted: batch.redactedCount, reason: 'nothing-to-extract' }
  }
  try {
    deps.saveBatch(deps.projectPath, batch.accepted)
  } catch (err) {
    return {
      ok: false, saved: 0, skipped: batch.skipped.length, redacted: batch.redactedCount,
      reason: 'save-failed',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  return { ok: true, saved: batch.accepted.length, skipped: batch.skipped.length, redacted: batch.redactedCount }
}
