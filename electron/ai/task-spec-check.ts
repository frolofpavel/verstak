/**
 * Проверка качества ТЗ-шага (v3, Шаг B — enforcement). Контракт описан в
 * src/lib/task-spec.ts (TASK_SPEC_CONTRACT, идёт в промпт планировщика). Здесь —
 * серверная проверка ФАКТИЧЕСКИ созданного плана: если шаг расплывчатый (нет
 * путей/критерия/детальности), create_plan возвращает модели фидбэк, чтобы она
 * уточнила. Само-enforcing контракт — рычаг «дешёвая модель исполняет точное ТЗ».
 *
 * Логика scoreTaskSpec зеркалит renderer-проверку (src/lib не импортируется в
 * electron — разные процессы). Чистая функция, тестируется напрямую.
 */

export interface TaskSpecScore {
  ok: boolean
  /** Чего не хватает по контракту — всё, включая советы. */
  missing: string[]
  /** Пробелы, при которых план сохранять НЕЛЬЗЯ (подмножество `missing`). */
  blocking: string[]
}

/** Признак, отсутствие которого СОВЕТ, а не запрет (см. ниже — почему). */
const PATHS_ITEM = 'конкретные файлы/пути'

/** Оценить описание шага: пути к файлам + критерий готовности + детальность. */
export function scoreTaskSpec(detail: string | null | undefined): TaskSpecScore {
  const d = (detail ?? '').trim()
  const missing: string[] = []
  const hasPath = /[\w@.-]+\.[a-z]{1,5}\b/i.test(d) || /\b[\w-]+\/[\w-]+/.test(d)
  if (!hasPath) missing.push(PATHS_ITEM)
  const hasAcceptance = /критери|готов|done|acceptance|ожида|проверь|провер|должен|тест|works?|пройд/i.test(d)
  if (!hasAcceptance) missing.push('критерий готовности («сделано» = что)')
  if (d.length < 40) missing.push('детальность (минимум пара конкретных предложений)')
  // ПОЧЕМУ ПУТИ — СОВЕТ, А НЕ ЗАПРЕТ (29.07, живая проверка).
  //
  // Требование путей запрещало сохранять план ЛЮБОЙ непрограммистской задачи:
  // «настрой Директ», «собери отчёт по Ozon», «разбери переписку с клиентом» —
  // файлов в них нет и быть не должно. Плана не появлялось никогда, а человек
  // видел «модель не создала план» и не мог понять, что происходит. Вдобавок
  // проверка написана под латиницу (`\w` без флага `u`), так что русское
  // описание её не проходит в принципе. Совет остаётся — он полезен для
  // кодовых задач; запрет снят.
  const blocking = missing.filter(m => m !== PATHS_ITEM)
  return { ok: missing.length === 0, missing, blocking }
}

/**
 * Фидбэк по плану: индексы слабых шагов (1-based) + сводка. '' если все ок.
 * Не блокирует план — добавляется к результату create_plan как подсказка.
 */
export function planSpecFeedback(steps: Array<{ title: string; detail?: string | null }>): string {
  const weak: string[] = []
  steps.forEach((s, i) => {
    const score = scoreTaskSpec(s.detail)
    if (!score.ok) weak.push(`#${i + 1} «${s.title}» — не хватает: ${score.missing.join(', ')}`)
  })
  if (weak.length === 0) return ''
  return `\n⚠ Тонкое ТЗ у ${weak.length} шаг(ов) — уточни (файлы + критерий готовности), иначе дешёвая модель-исполнитель не справится:\n${weak.join('\n')}`
}

/**
 * Пробелы, при которых план сохранять НЕЛЬЗЯ. '' — сохранять можно.
 *
 * Отделено от `planSpecFeedback` сознательно: раньше «что советуем» и «что
 * запрещаем» были одним текстом, и любой совет становился запретом. Из-за этого
 * планы задач без файлов не сохранялись вовсе.
 */
export function planSpecBlockers(steps: Array<{ title: string; detail?: string | null }>): string {
  const bad: string[] = []
  steps.forEach((s, i) => {
    const score = scoreTaskSpec(s.detail)
    if (score.blocking.length > 0) bad.push(`#${i + 1} «${s.title}» — не хватает: ${score.blocking.join(', ')}`)
  })
  if (bad.length === 0) return ''
  // Формулировка намеренно та же, что у совета: для модели это один и тот же
  // разговор о качестве ТЗ, разница только в том, сохранён план или нет.
  return `\n⚠ Тонкое ТЗ у ${bad.length} шаг(ов) — уточни, иначе шаг невозможно выполнить:\n${bad.join('\n')}`
}
