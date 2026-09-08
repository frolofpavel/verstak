/**
 * Внутренняя шина событий — расширяемый источник пробуждения фоновых задач.
 *
 * Заведена потому, что все три сегодняшних планировщика умеют только ВРЕМЯ, а
 * захардкодить рядом с ними изменение файла, смену статуса задачи и событие
 * коннектора значило бы завести по планировщику на источник. Здесь источник —
 * это имя события, и добавление нового не требует нового цикла опроса.
 *
 * Шина СИНХРОННАЯ и без очереди: подписчик получает сигнал в момент публикации.
 * Очередь и повторы — не её забота: долговременная правда о задачах живёт в
 * sqlite, и потерянное событие означает лишь, что задача проснётся по следующему
 * сигналу, а не что состояние разъехалось.
 */
import type { JobSignal } from '../../shared/contracts/persistent-job'

export type JobSignalListener = (signal: JobSignal) => void

export interface JobEventBus {
  publish: (signal: JobSignal) => void
  subscribe: (listener: JobSignalListener) => () => void
  /** Сколько подписчиков сейчас — для диагностики, не для логики. */
  size: () => number
}

export function createJobEventBus(): JobEventBus {
  const listeners = new Set<JobSignalListener>()

  return {
    publish(signal) {
      // Копия набора: подписчик вправе отписаться прямо в обработчике, и без
      // копии итерация по живому Set пропустила бы соседа.
      for (const listener of [...listeners]) {
        try {
          listener(signal)
        } catch {
          // Падение одного подписчика не должно глушить остальных: шина — общий
          // ресурс, и один сломанный потребитель не отменяет чужие пробуждения.
        }
      }
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    size: () => listeners.size,
  }
}
