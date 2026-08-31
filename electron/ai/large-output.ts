/**
 * Длинный вывод команды не должен уезжать в контекст модели целиком.
 *
 * Зачем (31.08). `npm test`, `npm run build`, установка зависимостей выдают десятки
 * тысяч символов, и до сих пор они шли модели ЦЕЛИКОМ — только через secret-scanner,
 * без единого ограничения. Один прогон тестов способен съесть окно и деньги.
 *
 * ОТЛИЧИЕ ОТ mcp/large-result.ts, из-за которого это отдельный модуль, а не общий:
 * там JSON-ответ API, и осмысленно взять НАЧАЛО. Здесь построчный лог, и главное в нём
 * почти всегда В КОНЦЕ — падения, стек, итоговая строка. Поэтому берём голову И хвост.
 * Свести их в одну функцию значило бы получить параметр «откуда резать», который на
 * каждом вызове решает вызывающий, — это не упрощение, а перекладывание решения.
 *
 * ЧЕЛОВЕКУ ВЫВОД ИДЁТ ЦЕЛИКОМ. Режется только копия для модели: в Timeline человек
 * должен видеть всё, что напечатала команда, иначе мы чиним расход модели, ломая
 * наблюдаемость.
 */

/** Порог, после которого вывод режется. */
export const COMMAND_OUTPUT_LIMIT = 12 * 1024
/** Сколько строк оставить от начала — что вообще запускалось и как пошло. */
export const HEAD_LINES = 25
/** Сколько строк оставить с конца — там падения, стек и итог. */
export const TAIL_LINES = 60

export interface LargeOutputSplit {
  /** Что уйдёт модели. */
  forModel: string
  /** Понадобилось ли резать (значит, полный текст стоит сохранить файлом). */
  truncated: boolean
}

/**
 * Режет длинный вывод, оставляя начало и конец. `filePath` подставляется в подсказку,
 * если полный текст удалось сохранить; null — честно говорим, что середины нет.
 */
export function splitLargeOutput(text: string, filePath: string | null): LargeOutputSplit {
  if (!text || text.length <= COMMAND_OUTPUT_LIMIT) {
    return { forModel: text, truncated: false }
  }
  const lines = text.split('\n')
  // Строк меньше, чем мы собирались показать, но символов много — значит строки
  // длинные (минифицированный вывод, одна гигантская строка). Резать по строкам
  // бессмысленно, режем по символам, иначе «обрезка» не обрежет ничего.
  if (lines.length <= HEAD_LINES + TAIL_LINES) {
    const half = Math.floor(COMMAND_OUTPUT_LIMIT / 2)
    const body = text.slice(0, half) + hint(text.length, filePath, 'середина') + text.slice(-half)
    return { forModel: body, truncated: true }
  }
  const head = lines.slice(0, HEAD_LINES).join('\n')
  const tail = lines.slice(-TAIL_LINES).join('\n')
  const skipped = lines.length - HEAD_LINES - TAIL_LINES
  return {
    forModel: `${head}\n${hint(text.length, filePath, `${skipped} строк`)}\n${tail}`,
    truncated: true,
  }
}

function hint(totalChars: number, filePath: string | null, what: string): string {
  const kb = Math.round(totalChars / 1024)
  // Без пути честно говорим, что пропущенного у модели НЕТ. Молчаливая обрезка хуже:
  // модель уверена, что видела весь вывод, и делает вывод по половине.
  return filePath
    ? `\n… пропущено: ${what} (всего ${kb} КБ). Полный вывод: ${filePath} — читай через read_file, если нужно\n`
    : `\n… пропущено: ${what} (всего ${kb} КБ). Сохранить полный вывод не удалось — пропущенного у тебя НЕТ\n`
}

/** Имя файла для сохранённого вывода команды. */
export function commandOutputFileName(stamp: number): string {
  return `command-output-${stamp}.log`
}
