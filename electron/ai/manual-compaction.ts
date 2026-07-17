import type { ChatMessage } from './types'

/**
 * Ручная компакция контекста — срез 2.0.11-B.
 *
 * Здесь ЧИСТАЯ часть: выбор границы и сборка промпта для суммаризации. Запись в БД —
 * chat-context-snapshots (со стражем гонки), сборка запроса модели — history-preparation.
 *
 * ПОЧЕМУ РУЧНАЯ. Автоматическое сжатие уже есть в прогоне (compact-history) и работает
 * молча. Ручная — это когда человек САМ решает «сожми, разговор разросся», и потому она
 * обязана быть предсказуемой: видно, что сожмётся, видно границу, ошибка ничего не портит.
 */

export interface CompactableMessage extends ChatMessage {
  dbId?: number
}

export interface CompactionBoundary {
  /** До какого сообщения ВКЛЮЧИТЕЛЬНО сжимаем. */
  throughMessageId: number
  /** Сколько сообщений уйдёт в summary. */
  compactedCount: number
  /** Сколько останется хвостом (их модель увидит дословно). */
  keptCount: number
}

export type BoundaryResult =
  | { ok: true; boundary: CompactionBoundary }
  | { ok: false; reason: 'empty' | 'nothing-to-compact'; detail: string }

/**
 * Сколько последних сообщений оставляем дословно. Сжать ВСЁ, включая только что
 * сказанное, — верный способ сделать ответ модели бессвязным: она потеряет живую нить
 * прямо посреди разговора.
 */
export const KEEP_RECENT_MESSAGES = 6

/**
 * Где резать. Берём границу так, чтобы последние KEEP_RECENT_MESSAGES остались целиком.
 *
 * Сообщения без dbId (оптимистичные, не в БД) в границу не попадают: сжимать можно только
 * то, что реально записано — иначе снапшот сослался бы на id, которого нет.
 */
export function pickBoundary(messages: CompactableMessage[], keepRecent = KEEP_RECENT_MESSAGES): BoundaryResult {
  const persisted = messages.filter(m => typeof m.dbId === 'number')
  if (persisted.length === 0) return { ok: false, reason: 'empty', detail: 'в чате нечего сжимать' }

  const cut = persisted.length - keepRecent
  if (cut <= 0) {
    return {
      ok: false,
      reason: 'nothing-to-compact',
      detail: `в чате ${persisted.length} сообщений — сжимать нечего, последние ${keepRecent} держим целиком`,
    }
  }
  const boundaryMsg = persisted[cut - 1]
  return {
    ok: true,
    boundary: {
      throughMessageId: boundaryMsg.dbId!,
      compactedCount: cut,
      keptCount: persisted.length - cut,
    },
  }
}

/** Промпт суммаризатора. Отдельный вызов вне основного прогона (карточка B п.4). */
export function buildCompactionPrompt(messages: CompactableMessage[], throughMessageId: number): {
  system: string
  user: string
} {
  const toCompact = messages.filter(m => typeof m.dbId === 'number' && m.dbId <= throughMessageId)
  const transcript = toCompact
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`)
    .join('\n\n')
  return {
    system: [
      'Ты сжимаешь начало рабочего диалога, чтобы он поместился в контекст модели.',
      'Итог прочитает та же модель, продолжая работу — пиши для неё, а не для отчёта.',
      '',
      'ОБЯЗАТЕЛЬНО сохрани: принятые решения и договорённости; конкретные файлы, пути и',
      'имена; что уже сделано и что осталось; открытые вопросы; ограничения и запреты,',
      'которые ставил человек.',
      'ВЫБРОСИ: воду, повторы, длинные листинги и выводы команд, пошаговые рассуждения.',
      '',
      'Пиши по-русски, плотно, без вступлений и без «в этом диалоге обсуждалось».',
      'Не выдумывай того, чего в диалоге не было: пропуск лучше вымысла.',
    ].join('\n'),
    user: `Сожми эту часть диалога:\n\n${transcript}`,
  }
}

/** Грубая оценка размера в токенах (~4 символа на токен). Именно ОЦЕНКА, не биллинг. */
export function estimateTokens(messages: Array<{ content: string }>): number {
  return Math.ceil(messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / 4)
}
