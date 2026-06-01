/**
 * Context Sliding Window — сжимает старые tool-results в истории сообщений,
 * чтобы длинные сессии не пробивали context window.
 *
 * Источник: V3 рефактор, recommendation #6 из аудита Grok.
 *
 * ПРОБЛЕМА:
 * Каждый turn агент-цикла добавляет в currentMessages результаты тулзов:
 * содержимое прочитанных файлов, stdout команд, project_map'ы и т.п. После
 * 10 turns с большими read_file (по 5-50KB) история раздувается до сотен KB.
 * Это:
 *   1) Бьёт лимит context window провайдеров (особенно на claude-haiku /
 *      gpt-4o-mini, где окно меньше).
 *   2) Замедляет каждый последующий turn (модель читает всё больше истории).
 *   3) Стоит денег — input_tokens растут квадратично с длиной сессии.
 *
 * СТРАТЕГИЯ:
 * Для каждой ai-сессии держим окно «последние KEEP_RECENT_TURNS turn'ов
 * целиком, старше — суммаризируем». Tool result text заменяется на короткий
 * маркер с метаданными (имя тулзы, длина оригинала, номер turn'а).
 *
 * Что НЕ трогаем:
 * - assistant content (текст ответов — нужен для continuity).
 * - tool calls (имя + args — нужны чтобы модель понимала что уже делала).
 * - user messages (это сам разговор).
 *
 * Возвращаем НОВЫЙ массив сообщений (immutable) — оригинал не модифицируем.
 */

import type { ChatMessage } from './types'
import { estimateTokens, getContextLimit, COMPACT_THRESHOLD } from './context-limits'

/** Сколько последних turn'ов оставляем целиком. */
const KEEP_RECENT_TURNS = 3

/** Максимальный размер ОДНОГО tool result в свежих turn'ах. Старше — режется
 *  до маркера. На свежих — оставляем но обрезаем до этого лимита если жирные. */
const FRESH_RESULT_HARD_CAP = 12_000

/** Размер маркера для старых tool results. Короче — экономнее токены. */
function makeOldMarker(name: string, originalLen: number, turnIdx: number): string {
  return `[compacted: ${name} (${originalLen} симв., turn ${turnIdx + 1}) — обрезано sliding window, перечитай если нужно]`
}

/** Грубо отрезаем середину если жирный, но в окне keep — оставляем хвост. */
function tailTruncate(text: string, cap: number): string {
  if (text.length <= cap) return text
  const headLen = Math.floor(cap * 0.3)
  const tailLen = cap - headLen - 60
  return `${text.slice(0, headLen)}\n[…вырезано ${text.length - cap + 60} симв., см. оригинал в исходном файле…]\n${text.slice(text.length - tailLen)}`
}

/**
 * Возвращает компактную копию messages для отправки провайдеру.
 *
 * Логика turn-индекса: каждое user-сообщение с toolResults представляет
 * собой завершение одного агент-turn (где модель вызвала тулзы и получила
 * результаты). Мы их нумеруем, и turns ниже currentTurn - KEEP_RECENT_TURNS
 * получают сжатие.
 *
 * @param messages исходная история (не модифицируется)
 * @param currentTurn сколько turn'ов уже сделано в текущей сессии
 * @returns новая история, готовая для provider.send
 */
export function compactToolHistory(messages: ChatMessage[], currentTurn: number): ChatMessage[] {
  const cutoff = currentTurn - KEEP_RECENT_TURNS
  if (cutoff < 0) {
    // Свежая сессия — есть смысл только подрезать гигантские свежие result'ы.
    return messages.map(m => capFreshResults(m))
  }
  // Считаем индекс tool-results-сообщений (это и есть turn-маркеры).
  let toolResultTurnIdx = -1
  return messages.map(m => {
    if (m.toolResults && m.toolResults.length > 0) {
      toolResultTurnIdx++
      if (toolResultTurnIdx <= cutoff) {
        return compactOldResults(m, toolResultTurnIdx)
      }
      return capFreshResults(m)
    }
    return m
  })
}

function compactOldResults(m: ChatMessage, turnIdx: number): ChatMessage {
  if (!m.toolResults?.length) return m
  return {
    ...m,
    toolResults: m.toolResults.map(r => {
      const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
      // Совсем мелкие результаты не трогаем — экономия копеечная, а сигнал
      // полезный (например, мелкий read_file у конфига).
      if (raw.length < 400) return r
      return { ...r, result: makeOldMarker(r.name, raw.length, turnIdx) }
    })
  }
}

function capFreshResults(m: ChatMessage): ChatMessage {
  if (!m.toolResults?.length) return m
  let changed = false
  const next = m.toolResults.map(r => {
    const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
    if (raw.length <= FRESH_RESULT_HARD_CAP) return r
    changed = true
    return { ...r, result: tailTruncate(raw, FRESH_RESULT_HARD_CAP) }
  })
  return changed ? { ...m, toolResults: next } : m
}

// ─── Авто-компакшн (auto-compact) ────────────────────────────────────────────
// Отдельный механизм от sliding window (compactToolHistory). Срабатывает
// значительно реже — только когда вся история приближается к 95% context window.
// Вместо того чтобы удалять старые tool results, создаёт суммаризированную
// «сжатую сессию»: системное сообщение-резюме + последние 3 поворота диалога.

/**
 * Оценивает суммарный размер истории в токенах (эвристика: 4 симв./токен).
 */
function estimateTotalTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokens(m.content ?? '')
    if (m.toolResults) {
      for (const r of m.toolResults) {
        const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
        total += estimateTokens(raw)
      }
    }
  }
  return total
}

/**
 * Возвращает true если история занимает > 95% контекстного окна модели.
 * Минимальный порог: 10 сообщений — до этого компактить бессмысленно.
 */
export function shouldAutoCompact(messages: ChatMessage[], model: string): boolean {
  if (messages.length < 10) return false
  const limit = getContextLimit(model)
  const used = estimateTotalTokens(messages)
  return used > limit * COMPACT_THRESHOLD
}

/**
 * Промпт для суммаризации: просим модель собрать сжатое резюме сессии.
 * Добавляем саму историю в конце, чтобы у модели был весь контекст.
 */
export function buildCompactSummaryPrompt(messages: ChatMessage[]): ChatMessage[] {
  // Берём только текстовые сообщения (без tool internals) для суммаризации —
  // меньше токенов, модель фокусируется на сути а не на tool payloads.
  const textHistory = messages
    .filter(m => m.role !== 'system' && (m.content ?? '').trim().length > 0)
    .map(m => `[${m.role}]: ${(m.content ?? '').slice(0, 2000)}`)
    .join('\n\n')

  return [
    {
      role: 'user',
      content:
        'Суммаризируй этот разговор кратко и чётко. ' +
        'Включи: ключевые решения, изменённые файлы (если упоминались), текущий статус задачи, нерешённые вопросы. ' +
        'Максимум 600 слов. Не включай вводные фразы вроде «Вот резюме». ' +
        'Отвечай на том же языке что и разговор.\n\n' +
        textHistory
    }
  ]
}

/** Количество последних поворотов диалога которые сохраняем после компакшна. */
const KEEP_RECENT_FOR_COMPACT = 3

/**
 * Создаёт сжатую историю: системное сообщение с резюме + последние N пар user/assistant.
 * Возвращаемый массив готов для подстановки в currentMessages.
 */
export function createCompactedHistory(summary: string, messages: ChatMessage[]): ChatMessage[] {
  // Берём последние KEEP_RECENT_FOR_COMPACT пары (user + assistant)
  // Считаем с конца: ищем user-сообщения (они маркируют начало turn'а)
  const recentTurns: ChatMessage[] = []
  let turnsFound = 0
  for (let i = messages.length - 1; i >= 0 && turnsFound < KEEP_RECENT_FOR_COMPACT; i--) {
    recentTurns.unshift(messages[i])
    if (messages[i].role === 'user' && !messages[i].toolResults) {
      // Нашли user-сообщение без tool results = начало поворота диалога
      turnsFound++
    }
  }

  return [
    {
      role: 'system',
      content:
        '[Авто-компакшн: предыдущая часть сессии сжата в резюме]\n\n' +
        summary
    },
    ...recentTurns
  ]
}

/** Статистика сжатия — для журнала / отладки. */
export function diffSize(before: ChatMessage[], after: ChatMessage[]): { savedChars: number; pct: number } {
  const charsOf = (msgs: ChatMessage[]): number =>
    msgs.reduce((sum, m) => {
      let s = (m.content ?? '').length
      if (m.toolResults) {
        for (const r of m.toolResults) {
          const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
          s += raw.length
        }
      }
      return sum + s
    }, 0)
  const a = charsOf(before)
  const b = charsOf(after)
  const saved = Math.max(0, a - b)
  return { savedChars: saved, pct: a > 0 ? Math.round((saved / a) * 100) : 0 }
}
