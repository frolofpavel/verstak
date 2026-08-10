/**
 * V2 ось B (волна 2.6.0): плавность потока — склейка текстовых чанков.
 *
 * ДЕФЕКТ. Каждая текстовая дельта провайдера уходила отдельным IPC-событием
 * (`sender.send('ai:event', …)` на чанк), а renderer на каждое такое событие
 * обновлял zustand и перерисовывал сообщение. У API-провайдеров дельта — это
 * несколько символов, поэтому один средний ответ давал сотни, а длинный —
 * тысячи IPC-сообщений и столько же перерисовок. Глазу это видно как рывки.
 *
 * РЕШЕНИЕ И ЕГО ГЛАВНОЕ ОГРАНИЧЕНИЕ. Чанки склеиваются окном ~30 мс, НО первый
 * после паузы уходит НЕМЕДЛЕННО (leading edge). Иначе склейка воевала бы с осью
 * A: «время до первого символа» — главная метрика волны, и добавить к ней даже
 * 30 мс ради плавности было бы разменом не в ту сторону.
 *
 * ЧТО НЕЛЬЗЯ ПОТЕРЯТЬ. Порядок событий: текст, накопленный до tool-вызова или
 * до `done`, обязан уйти РАНЬШЕ них — иначе ответ приедет после инструмента, и
 * лента соврёт о ходе работы. Поэтому у склейки есть явный `flush()`, и
 * вызывающий обязан звать его перед любым не-текстовым событием и в финале.
 */

export interface TextCoalescerOptions {
  /** Окно склейки. 30 мс ≈ два кадра — глаз видит поток, а не ступени. */
  windowMs?: number
  /** Шов таймера для тестов (детерминизм вместо ожидания реального времени). */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void }
}

export interface TextCoalescer {
  /** Добавить дельту. Первая после паузы уходит сразу, остальные — окном. */
  push: (text: string) => void
  /** Немедленно отдать накопленное. Обязателен перед НЕ-текстовым событием. */
  flush: () => void
  /** Снять таймер, ничего не отправляя (abort). Накопленное теряется осознанно. */
  dispose: () => void
  /** Сколько IPC-отправок сделано — для замера и пинов. */
  emits: () => number
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms)
  if (typeof t.unref === 'function') t.unref()
  return { cancel: () => clearTimeout(t) }
}

export function createTextCoalescer(sink: (text: string) => void, opts: TextCoalescerOptions = {}): TextCoalescer {
  const windowMs = opts.windowMs ?? 30
  const schedule = opts.schedule ?? defaultSchedule
  let buffer = ''
  let timer: { cancel: () => void } | null = null
  let emits = 0

  const emit = (text: string): void => {
    emits++
    sink(text)
  }

  const flush = (): void => {
    if (timer) { timer.cancel(); timer = null }
    if (!buffer) return
    const text = buffer
    buffer = ''
    emit(text)
  }

  return {
    push: (text: string) => {
      if (!text) return
      if (!timer) {
        // Leading edge: пауза кончилась — отдаём немедленно и открываем окно.
        // Так первый символ ответа не платит за плавность последующих.
        emit(text)
        timer = schedule(() => { timer = null; flush() }, windowMs)
        return
      }
      buffer += text
    },
    flush,
    dispose: () => {
      if (timer) { timer.cancel(); timer = null }
      buffer = ''
    },
    emits: () => emits,
  }
}
