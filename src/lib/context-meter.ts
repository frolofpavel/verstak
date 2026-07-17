import type { ContextStateDTO, CompactResultDTO } from '../types/api'

/**
 * Тексты и доступность кнопки сжатия — срез 2.0.11-B.
 *
 * Вынесено из компонента, чтобы формулировки проверялись тестами. Правило здесь одно:
 * человек должен понимать, что произойдёт и что уже произошло, БЕЗ жаргона. «Сжали
 * контекст до 12k токенов» ничего не говорит маркетологу; «начало разговора свёрнуто в
 * итог — модель помнит суть, вы видите переписку целиком» — говорит.
 */

/** Порог, с которого сжатие имеет смысл предлагать заметно. ~4 символа на токен. */
export const LONG_CHAT_TOKENS = 20_000

export interface MeterView {
  /** Строка-состояние рядом с пунктом меню. */
  meta: string
  canCompact: boolean
  /** Почему нельзя (для подписи под кнопкой). Пусто — можно. */
  blockedReason: string
  /** Разговор разросся — стоит подсветить. */
  suggest: boolean
}

export function meterView(state: ContextStateDTO | null, hasProject: boolean): MeterView {
  if (!hasProject) return { meta: 'нет проекта', canCompact: false, blockedReason: 'Открой проект слева', suggest: false }
  if (!state) return { meta: '—', canCompact: false, blockedReason: 'Состояние ещё не загружено', suggest: false }

  if (state.busy) {
    return {
      meta: 'идёт ответ',
      canCompact: false,
      // Сжать под работающей моделью = увести историю у неё из-под ног на полуслове.
      blockedReason: 'Дождись окончания ответа',
      suggest: false,
    }
  }
  if (!state.canCompact) {
    return {
      meta: state.compacted ? 'свёрнут' : 'короткий',
      canCompact: false,
      blockedReason: 'Разговор ещё короткий — сворачивать нечего',
      suggest: false,
    }
  }

  const suggest = state.estimatedTokens >= LONG_CHAT_TOKENS
  return {
    meta: state.compacted ? 'свёрнут' : suggest ? 'разросся' : `${state.totalMessages} сообщений`,
    canCompact: true,
    blockedReason: '',
    suggest,
  }
}

/** Что показать после нажатия. Осечка — не ошибка приложения: контекст цел. */
export function compactResultText(result: CompactResultDTO): { text: string; ok: boolean } {
  if (result.ok) {
    return {
      ok: true,
      text: `Начало разговора свёрнуто в итог (${result.compactedCount} сообщений). Переписку видно целиком — свернулось только то, что уходит модели.`,
    }
  }
  // detail приходит с main уже человеческим — не переписываем его тут заново.
  return { ok: false, text: result.detail }
}

/** Подпись про уже сделанное сжатие — без цифр, которых человек не проверит. */
export function compactedHint(state: ContextStateDTO): string {
  if (!state.compacted) return 'Начало свернётся в короткий итог. Переписка останется на месте.'
  return 'Начало уже свёрнуто в итог. Можно свернуть ещё раз — прошлые итоги сохраняются.'
}
