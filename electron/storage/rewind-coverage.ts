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

/** Минимум полей undo-записи, нужный для оценки покрытия. */
export interface RewindEntry {
  id: number
  filePath: string
  runId: string | null
  afterHash: string | null
}

/**
 * Оценка покрытия над РЕАЛЬНЫМИ undo-записями — соединяет провенанс (E1) с логикой (E2).
 *
 * Единица покрытия — ФАЙЛ, не запись: файл могли править много раз, важна последняя запись
 * (она отражает конечное состояние). Файл считается:
 *  · непротрассированным — если у последней записи нет runId (правка мимо нашего loop);
 *  · протухшим (stale) — если текущий хеш файла разошёлся с afterHash (кто-то переписал
 *    после нас; откат перезатёр бы чужое).
 *
 * currentHash инъектируется (в проде — sha256 содержимого файла; null — файла нет).
 *
 * hasBypassWriters — ЯВНЫЙ сигнал от потребителя: прогон менял файлы МИМО undo-стека
 * (run_command, CLI-бинарь). Такие правки не оставляют undo-записей ВООБЩЕ, поэтому по
 * записям их не увидеть — потребитель (F) обязан сообщить из знания о прогоне (agent_run:
 * были ли run_command/CLI-инструменты). Без этого complete соврал бы: мы обещали полный
 * откат, не видя половину правок (ревью E — латентная дыра, закрыта до подключения).
 */
export function assessRewind(
  entries: RewindEntry[],
  opts: { currentHash: (filePath: string) => string | null; hasBypassWriters?: boolean },
): RewindCoverage {
  // Последняя запись каждого файла = с МАКСИМАЛЬНЫМ id. НЕ полагаемся на порядок входа:
  // list() отдаёт DESC, и «последняя встреченная» была бы самой СТАРОЙ — перепутали бы
  // конечное состояние файла.
  const latestByFile = new Map<string, RewindEntry>()
  for (const e of entries) {
    const prev = latestByFile.get(e.filePath)
    if (!prev || e.id > prev.id) latestByFile.set(e.filePath, e)
  }

  let tracedFiles = 0
  let untracedFiles = 0
  let staleFiles = 0
  for (const [filePath, e] of latestByFile) {
    if (e.runId == null) { untracedFiles++; continue }
    tracedFiles++
    if (opts.currentHash(filePath) !== e.afterHash) staleFiles++
  }

  // Непротрассированность — из ДВУХ источников: записи без runId (видимые) И явный сигнал
  // потребителя о bypass-writers (невидимые в стеке — run_command/CLI).
  const hasUntracedWriters = untracedFiles > 0 || opts.hasBypassWriters === true
  return computeRewindCoverage({ tracedFiles, hasUntracedWriters, staleFiles })
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
