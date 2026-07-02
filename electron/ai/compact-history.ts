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
import { CACHE_BREAKPOINT } from './compose-prompt'

/** Сколько последних turn'ов оставляем целиком. */
const KEEP_RECENT_TURNS = 3

/** Максимальный размер ОДНОГО tool result в свежих turn'ах. Старше — режется
 *  до маркера. На свежих — оставляем но обрезаем до этого лимита если жирные. */
const FRESH_RESULT_HARD_CAP = 12_000

/** Размер маркера для старых tool results. Короче — экономнее токены. */
function makeOldMarker(name: string, originalLen: number, turnIdx: number): string {
  return `[compacted: ${name} (${originalLen} симв., turn ${turnIdx + 1}) — обрезано sliding window, перечитай если нужно]`
}

// ─── Smart compression helpers ────────────────────────────────────────────────

function truncateWithContext(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = Math.floor(max * 0.3)
  return text.slice(0, head) + `\n... (${text.length - head - tail} chars omitted) ...\n` + text.slice(-tail)
}

function keepTail(text: string, max: number): string {
  if (text.length <= max) return text
  const lines = text.split('\n')
  const result: string[] = []
  let len = 0
  for (let i = lines.length - 1; i >= 0 && len < max; i--) {
    result.unshift(lines[i])
    len += lines[i].length + 1
  }
  const omitted = lines.length - result.length
  const marker = omitted > 0 ? `(${omitted} lines omitted)\n` : ''
  // Жёсткий потолок по символам: одна гигантская строка без переносов
  // (curl, минифицированный JSON, base64) иначе попадает в result целиком
  // и обходит max (push-then-check в цикле выше).
  const budget = Math.max(0, max - marker.length)
  const body = result.join('\n')
  return marker + (body.length > budget ? body.slice(body.length - budget) : body)
}

function truncateList(text: string, max: number): string {
  if (text.length <= max) return text
  const lines = text.split('\n').filter(l => l.trim())
  const keepN = Math.min(lines.length, Math.max(10, Math.floor(max / 80)))
  const remaining = lines.length - keepN
  const kept = lines.slice(0, keepN).join('\n') + (remaining > 0 ? `\n... (${remaining} more results)` : '')
  // Немного очень длинных строк сами по себе превышают max — финальный потолок.
  return kept.length > max ? truncateWithContext(kept, max) : kept
}

/**
 * Умное сжатие tool result с учётом типа инструмента.
 * Вместо единого tailTruncate — подбираем стратегию по имени тулзы.
 */
export function smartCompressResult(toolName: string, result: string, maxLen: number): string {
  if (result.length <= maxLen) return result

  switch (toolName) {
    case 'read_file':
      // Файл: голова + хвост — начало и конец чаще всего важнее середины
      return truncateWithContext(result, maxLen)

    case 'run_command':
      // Команда: последние строки самые релевантные (итог, ошибки)
      return keepTail(result, maxLen)

    case 'search_project':
    case 'find_files':
      // Список совпадений: первые N результатов + счётчик остатка
      return truncateList(result, maxLen)

    case 'list_directory':
      // Листинг: та же логика что и для списков
      return truncateList(result, maxLen)

    case 'get_project_map':
    case 'refresh_project_map':
      // Карта проекта: голова + хвост сохраняют структуру лучше
      return truncateWithContext(result, maxLen)

    default:
      // Generic: первые 60% + последние 30%
      return truncateWithContext(result, maxLen)
  }
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
    return { ...r, result: smartCompressResult(r.name, raw, FRESH_RESULT_HARD_CAP) }
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
    if (m.toolCalls) {
      // args write_file/apply_patch несут полное содержимое файла — без их учёта
      // shouldAutoCompact недосчитывает и не срабатывает вовремя.
      for (const c of m.toolCalls) {
        total += estimateTokens(c.name + JSON.stringify(c.args ?? {}))
      }
    }
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
  // Резервируем бюджет под ВЫВОД модели: вход + ожидаемый output не должны пробить
  // окно. Раньше порог брался от ПОЛНОГО лимита → на 95% входа модель уже не могла
  // сгенерить ответ без переполнения. Резерв = 10% лимита, кап 16k (ревью 23.06 #5).
  const effectiveLimit = limit - Math.min(Math.floor(limit * 0.1), 16_000)
  const used = estimateTotalTokens(messages)
  return used > effectiveLimit * COMPACT_THRESHOLD
}

// Реальные файловые тулзы (ревью 24.06): edit_file/create_file — фантомы (нет в
// TOOL_DEFS). propose_edits — основной мульти-файловый редактор, его пути лежат в
// массиве args.edits[].path, а не args.path.
const FILE_TOOLS = new Set(['read_file', 'write_file', 'apply_patch', 'propose_edits'])

/**
 * Пути файлов, затронутых тулзами сессии (read/write/patch/propose_edits). Чтобы
 * провенанс файлов не терялся при компакции — модель сохранит их в разделе ФАЙЛЫ (T1.6).
 */
export function extractTouchedFiles(messages: ChatMessage[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (p: unknown) => {
    if (typeof p === 'string' && p && !seen.has(p)) { seen.add(p); out.push(p) }
  }
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      if (!FILE_TOOLS.has(c.name)) continue
      const args = (c.args ?? {}) as Record<string, unknown>
      // propose_edits — мульти-файловый: пути в массиве edits[].path.
      if (c.name === 'propose_edits' && Array.isArray(args.edits)) {
        for (const e of args.edits) {
          if (e && typeof e === 'object') add((e as Record<string, unknown>).path)
        }
        continue
      }
      add(typeof args.path === 'string' ? args.path : args.file_path)
    }
  }
  return out
}

/**
 * Промпт компакции (T1.6): СТРУКТУРИРОВАННАЯ схема (Goal/Progress/Files) вместо
 * free-form + протяжка тронутых файлов + ИТЕРАТИВНОЕ обновление прошлого резюме
 * (previousSummary — двигаем «В работе»→«Сделано», не ре-суммаризируем с нуля).
 * Из конкурентного исследования (OpenClaw/Cursor — главная боль агентов на хвосте
 * длинных сессий: потеря провенанса файлов и деградация резюме).
 */
export function buildCompactSummaryPrompt(
  messages: ChatMessage[],
  opts?: { previousSummary?: string }
): ChatMessage[] {
  const textHistory = messages
    .filter(m => m.role !== 'system' && (m.content ?? '').trim().length > 0)
    .map(m => `[${m.role}]: ${(m.content ?? '').slice(0, 2000)}`)
    .join('\n\n')

  const files = extractTouchedFiles(messages)
  const filesBlock = files.length
    ? `\nФайлы, затронутые в сессии (отрази релевантные в разделе ФАЙЛЫ):\n${files.map(f => `- ${f}`).join('\n')}\n`
    : ''

  const prev = opts?.previousSummary?.trim()
  const iterative = prev
    ? '\n\nНиже ПРЕДЫДУЩЕЕ резюме — ОБНОВИ его (двигай «В работе»→«Сделано», добавь новое, не теряй старое), НЕ пиши с нуля:\n\n' + prev + '\n'
    : ''

  const schema =
    'Сожми сессию в СТРУКТУРИРОВАННОЕ резюме строго по схеме (заполни каждый раздел, пустой → «—»):\n\n' +
    'ЦЕЛЬ: <что делаем, одна строка>\n' +
    'ОГРАНИЧЕНИЯ: <ключевые правила/требования>\n' +
    'ПРОГРЕСС:\n  Сделано: <завершённое>\n  В работе: <текущее>\n  Заблокировано: <если есть>\n' +
    'КЛЮЧЕВЫЕ РЕШЕНИЯ: <важные выборы>\n' +
    'СЛЕДУЮЩИЕ ШАГИ: <что дальше>\n' +
    'ФАЙЛЫ: <релевантные файлы и их роль>\n\n' +
    'Без вводных фраз. На языке разговора. Лаконично, но не теряй провенанс файлов и решений.'

  return [{ role: 'user', content: schema + iterative + filesBlock + '\n\nИстория сессии:\n' + textHistory }]
}

/** Количество последних поворотов диалога которые сохраняем после компакшна. */
const KEEP_RECENT_FOR_COMPACT = 3

/**
 * Создаёт сжатую историю: системное сообщение с резюме + последние N пар user/assistant.
 * Возвращаемый массив готов для подстановки в currentMessages.
 */
export function createCompactedHistory(summary: string, messages: ChatMessage[], focusBlock?: string | null, baseSystem?: string | null): ChatMessage[] {
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

  const summaryMsg: ChatMessage = {
    role: 'system',
    content:
      '[Авто-компакшн: предыдущая часть сессии сжата в резюме]\n\n' +
      summary +
      // Focus Chain (ось 3 C): незакрытый todo-лист — ЯКОРЬ, чтобы он пережил сжатие и
      // агент не потерял исходные пункты задачи (анти-дрейф §5.4).
      (focusBlock ? '\n\n' + focusBlock : '')
  }

  // Ревью: сохраняем БАЗОВЫЙ system-префикс (протокол/правила/skill), иначе после
  // компакции агент терял immutable-протокол → off-policy (как чинил new_task-фикс), а
  // prompt-каша с маркером терялась. Для claude — стабильный префикс + маркер (кэш
  // продолжает попадать, старый volatile-pack отброшен, его заменяет summary). Для
  // не-claude (маркера нет — снят) — базовый префикс как есть, маркер НЕ добавляем.
  const systemMsgs: ChatMessage[] = []
  if (baseSystem && baseSystem.trim()) {
    const bpIdx = baseSystem.indexOf(CACHE_BREAKPOINT)
    systemMsgs.push({
      role: 'system',
      content: bpIdx >= 0 ? baseSystem.slice(0, bpIdx) + CACHE_BREAKPOINT : baseSystem
    })
  }
  systemMsgs.push(summaryMsg)

  return [...systemMsgs, ...recentTurns]
}

/**
 * Focus Chain (ось 3 C): активные (НЕ done) пункты todo-листа сессии как чеклист-якорь.
 * Держит фокус длинной одиночной сессии — переживает компакцию и реинъектится по cadence.
 * null если нет незавершённых пунктов (нечего держать).
 */
/**
 * H (ось 3): контекст после new_task. СОХРАНЯЕТ базовый system-промпт (протокол/память/
 * правила живут только в нём) + исходную задачу юзера, затем дистиллят агента + Focus Chain.
 * Без сохранения base-system агент уходит off-policy на весь остаток прогона (ревью HIGH).
 */
export function buildNewTaskContext(
  baseSystem: ChatMessage | null,
  originalUser: ChatMessage | null,
  distillate: string,
  focusBlock?: string | null
): ChatMessage[] {
  const out: ChatMessage[] = []
  if (baseSystem) out.push(baseSystem)
  if (originalUser) out.push(originalUser)
  out.push({ role: 'system', content: '[Новая задача — предыдущий контекст очищен по запросу агента (new_task). Дистиллят прогресса:]\n\n' + distillate })
  if (focusBlock) out.push({ role: 'system', content: focusBlock })
  return out
}

export function formatFocusChain(todos: ReadonlyArray<{ title: string; status: string }>): string | null {
  const active = todos.filter(t => t.status !== 'done')
  if (active.length === 0) return null
  const mark = (s: string) => s === 'in_progress' ? '⏳' : s === 'blocked' ? '⛔' : '☐'
  const lines = active.slice(0, 12).map(t => `${mark(t.status)} ${t.title}`)
  const more = active.length > 12 ? `\n…ещё ${active.length - 12}` : ''
  return '[Focus Chain — незакрытые пункты задачи (держи в фокусе, не дрейфуй):\n' + lines.join('\n') + more + ']'
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

// ─── Microcompact (Tier-2 #2) ─────────────────────────────────────────────────
// Дешёвый ОБРАТИМЫЙ прунинг между sliding-window и full-compact. В отличие от
// sliding-window (режет по ВОЗРАСТУ) — режет по РАЗМЕРУ: маркерует самые большие
// старые tool-результаты, пока не наберём target. Без LLM-вызова (full-compact
// дорогой). Обратимо: маркер говорит агенту перечитать файл/перезапустить команду.

function makeMicroMarker(name: string, originalLen: number): string {
  return `[microcompacted: ${name} (${originalLen} симв.) — прунинг по размеру; перечитай файл / перезапусти команду, если результат снова нужен]`
}

export interface MicrocompactResult {
  messages: ChatMessage[]
  reclaimedChars: number
  pruned: number
}

/**
 * Замаркерить самые крупные tool-результаты (старше keepRecentTurns) по убыванию
 * размера, пока суммарно не наберём targetReclaimChars. Возвращает НОВЫЙ массив
 * (immutable); если резать нечего — исходный массив и pruned=0.
 */
export function microcompact(
  messages: ChatMessage[],
  opts: { targetReclaimChars: number; keepRecentTurns?: number; minResultChars?: number }
): MicrocompactResult {
  const keepRecent = opts.keepRecentTurns ?? 2
  const minChars = opts.minResultChars ?? 2000

  const trMsgIdx: number[] = []
  messages.forEach((m, i) => { if (m.toolResults?.length) trMsgIdx.push(i) })
  const protectedFrom = trMsgIdx.length - keepRecent

  const candidates: Array<{ mi: number; ri: number; size: number }> = []
  let turnNo = 0
  for (const mi of trMsgIdx) {
    const isProtected = turnNo >= protectedFrom
    turnNo++
    if (isProtected) continue
    messages[mi].toolResults!.forEach((r, ri) => {
      const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
      if (raw.length >= minChars && !raw.startsWith('[microcompacted:') && !raw.startsWith('[compacted:')) {
        candidates.push({ mi, ri, size: raw.length })
      }
    })
  }
  candidates.sort((a, b) => b.size - a.size)

  const toPrune = new Set<string>()
  let reclaimed = 0
  for (const c of candidates) {
    if (reclaimed >= opts.targetReclaimChars) break
    toPrune.add(`${c.mi}:${c.ri}`)
    reclaimed += c.size
  }
  if (toPrune.size === 0) return { messages, reclaimedChars: 0, pruned: 0 }

  const next = messages.map((m, mi) => {
    if (!m.toolResults?.length) return m
    let changed = false
    const trs = m.toolResults.map((r, ri) => {
      if (!toPrune.has(`${mi}:${ri}`)) return r
      changed = true
      const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
      return { ...r, result: makeMicroMarker(r.name, raw.length) }
    })
    return changed ? { ...m, toolResults: trs } : m
  })
  return { messages: next, reclaimedChars: reclaimed, pruned: toPrune.size }
}

/** Порог microcompact — ниже full-compact (COMPACT_THRESHOLD). Дешёвый прунинг
 *  включается раньше дорогой суммаризации. */
const MICRO_THRESHOLD = 0.7

export function shouldMicrocompact(messages: ChatMessage[], model: string): boolean {
  if (messages.length < 6) return false
  const limit = getContextLimit(model)
  const effectiveLimit = limit - Math.min(Math.floor(limit * 0.1), 16_000)
  const used = estimateTotalTokens(messages)
  return used > effectiveLimit * MICRO_THRESHOLD
}

/** Обёртка для ai.ts: при превышении MICRO_THRESHOLD прунит крупные результаты в
 *  `messages` до ~55% окна. Порог/цель считаются по `estimateMessages` (что РЕАЛЬНО
 *  уходит провайдеру — sliding-window-сжатая копия; по умолчанию = messages), чтобы
 *  не срабатывать ложно, когда отправляемый payload уже мал (ревью 26.06). chars ≈ tokens×4. */
export function microcompactIfNeeded(messages: ChatMessage[], model: string, estimateMessages?: ChatMessage[]): MicrocompactResult {
  const estimate = estimateMessages ?? messages
  if (!shouldMicrocompact(estimate, model)) return { messages, reclaimedChars: 0, pruned: 0 }
  const limit = getContextLimit(model)
  const effectiveLimit = limit - Math.min(Math.floor(limit * 0.1), 16_000)
  const used = estimateTotalTokens(estimate)
  const targetReclaimChars = Math.max(0, used - Math.floor(effectiveLimit * 0.55)) * 4
  return microcompact(messages, { targetReclaimChars })
}
