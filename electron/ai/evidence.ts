/**
 * Что считается ДОКАЗАТЕЛЬСТВОМ выполнения — одно определение на весь продукт.
 *
 * Почему вынесено отдельно (ревью 28.07). Проверка жила приватной функцией в
 * `tool-handlers/outcome.ts` и применялась только на пайплайн-оси: там артефакт
 * обязан существовать физически. А чек-лист, добавленный блоком C, считал
 * доказательством любую непустую строку — `evidence='.'` закрывал пункт. Внутри
 * одного продукта оказалось два разных понятия доказательства, причём слабое
 * стояло ровно там, где ТЗ требует сильного («системный пункт закрывается только
 * после подтверждённого выполнения, не по совпадению текста»).
 *
 * Ссылка на прогон/событие/артефакт/команду принимается как есть: это указатель
 * в durable-состояние приложения, проверяемый по журналу прогона. Всё остальное
 * обязано быть путём ВНУТРИ проекта, который реально существует на диске.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/** Указатели в durable-состояние: их проверяет журнал прогона, не файловая система. */
const REFERENCE_EVIDENCE = /^(run|event|artifact|command):\S+/i

export function evidenceExists(projectPath: string, evidence: string): boolean {
  const value = (evidence ?? '').trim()
  if (!value) return false
  if (REFERENCE_EVIDENCE.test(value)) return true
  const absolute = isAbsolute(value) ? resolve(value) : resolve(projectPath, value)
  const rel = relative(projectPath, absolute)
  // Выход за корень проекта доказательством не является: путь наружу нельзя ни
  // показать человеку в интерфейсе, ни перепроверить безопасно.
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(absolute)
}
