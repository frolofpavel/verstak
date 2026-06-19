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
  /** Чего не хватает по контракту. */
  missing: string[]
}

/** Оценить описание шага: пути к файлам + критерий готовности + детальность. */
export function scoreTaskSpec(detail: string | null | undefined): TaskSpecScore {
  const d = (detail ?? '').trim()
  const missing: string[] = []
  const hasPath = /[\w@.-]+\.[a-z]{1,5}\b/i.test(d) || /\b[\w-]+\/[\w-]+/.test(d)
  if (!hasPath) missing.push('конкретные файлы/пути')
  const hasAcceptance = /критери|готов|done|acceptance|ожида|проверь|провер|должен|тест|works?|пройд/i.test(d)
  if (!hasAcceptance) missing.push('критерий готовности («сделано» = что)')
  if (d.length < 40) missing.push('детальность (минимум пара конкретных предложений)')
  return { ok: missing.length === 0, missing }
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
