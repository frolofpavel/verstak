/**
 * Покрытие отката — срез 2.0.11-E.
 *
 * Честный ответ на «если откачу, вернётся ли всё как было?». Не обещаем полного отката там,
 * где не видели половину правок (прогон менял файлы мимо нашего undo-стека — run_command,
 * CLI-бинарь) или где файл переписан кем-то ПОСЛЕ нашей записи (откат перезатёр бы чужое).
 */

export type RewindLevel = 'complete' | 'partial' | 'none'

export interface RewindCoverageInput {
  /** Файлов прогона, у которых ЕСТЬ наша undo-запись (протрассировано). */
  tracedFiles: number
  /** Прогон использовал непротрассированные writers (run_command/CLI) — мог менять файлы
   *  мимо undo-стека. Мы не видели этих правок → полный откат обещать нельзя. */
  hasUntracedWriters: boolean
  /** Из traced: сколько файлов переписаны ПОСЛЕ нашей записи (текущий хеш != after_hash).
   *  Откат таких перезатёр бы чужие изменения — небезопасно. */
  staleFiles: number
}

export interface RewindCoverage extends RewindCoverageInput {
  level: RewindLevel
}

export function computeRewindCoverage(input: RewindCoverageInput): RewindCoverage {
  const { tracedFiles, hasUntracedWriters, staleFiles } = input

  const level = ((): RewindLevel => {
    // ИНВАРИАНТ карточки: непротрассированные writers → НИКОГДА complete.
    if (hasUntracedWriters) {
      // Есть что откатить трассируемо → partial; совсем нечего → none.
      return tracedFiles > 0 ? 'partial' : 'none'
    }
    if (tracedFiles === 0) return 'none' // откатывать нечего
    // Всё протрассировано: чисто, если ни один файл не переписан после нас.
    return staleFiles > 0 ? 'partial' : 'complete'
  })()

  return { level, tracedFiles, hasUntracedWriters, staleFiles }
}
