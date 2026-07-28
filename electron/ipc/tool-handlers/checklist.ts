/**
 * Чек-лист проекта как инструменты агента (§9 ТЗ VSK-TASK-FLOW-A1, блок C).
 *
 * ПОЧЕМУ НЕ `todo_create`/`todo_update`. Session todos — оркестрация внутри
 * одного прогона: они живут ровно столько, сколько идёт работа агента. Чек-лист
 * — пользовательская сущность проекта: переживает перезапуск, наполняется и
 * человеком, и Verstak'ом, и закрывается человеком руками. Разная
 * продолжительность жизни и разный владелец — разные механизмы.
 *
 * ГЛАВНОЕ ПРАВИЛО (§3.3 и §9): системный пункт закрывается ТОЛЬКО по
 * доказательству. Не по совпадению текста, не по «кажется сделано». Поэтому
 * `checklist_complete` требует evidence, а пустое evidence закрытием не является.
 */
import { evidenceExists } from '../../ai/evidence'
import type { ToolHandler } from './shared'

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export const checklistAddHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.tasks) return { id: call.id, name: call.name, result: '', error: 'CHECKLIST_STORAGE_UNAVAILABLE' }
    const body = text(call.args.text)
    if (!body) return { id: call.id, name: call.name, result: '', error: 'checklist_add: text обязателен' }
    const task = ctx.tasks.add(ctx.projectPath, body, {
      // Всё, что заводит агент, — системное. Ручные пункты заводит только человек
      // через интерфейс: источник не берётся из аргументов модели.
      source: 'system',
      planId: numberOrNull(call.args.planId),
      planStepId: numberOrNull(call.args.planStepId),
    })
    return {
      id: call.id, name: call.name,
      result: `Пункт чек-листа #${task.id} добавлен: «${task.text}». Закрыть его можно только с доказательством (checklist_complete).`,
    }
  },
}

export const checklistCompleteHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.tasks) return { id: call.id, name: call.name, result: '', error: 'CHECKLIST_STORAGE_UNAVAILABLE' }
    const id = numberOrNull(call.args.id)
    const evidence = text(call.args.evidence)
    if (id == null) return { id: call.id, name: call.name, result: '', error: 'checklist_complete: id обязателен' }
    if (!evidence) {
      return {
        id: call.id, name: call.name, result: '',
        error: 'CHECKLIST_EVIDENCE_REQUIRED: пункт закрывается только с доказательством (файл, команда, ссылка на результат).',
      }
    }
    // Ревью 28.07, дыра 1: инструмент не смотрел на источник пункта вовсе и мог
    // закрыть то, что завёл ЧЕЛОВЕК. Чек-лист — его список; Verstak закрывает
    // только свои пункты. Инструменты чек-листа живут при любом положении
    // тумблера согласования, поэтому дыра была живой всегда.
    const target = ctx.tasks.list(ctx.projectPath).find(item => item.id === id)
    if (!target) return { id: call.id, name: call.name, result: '', error: `checklist_complete: пункт #${id} не найден` }
    if (target.source !== 'system') {
      return {
        id: call.id, name: call.name, result: '',
        error: `CHECKLIST_MANUAL_ITEM: пункт #${id} завёл человек — закрывает его тоже человек. Скажи о выполнении в ответе.`,
      }
    }
    // Ревью 28.07, дыра 2: доказательством считалась любая непустая строка, и
    // `evidence='.'` закрывал пункт. Проверка теперь ОБЩАЯ с пайплайн-осью
    // (ai/evidence.ts): либо существующий путь внутри проекта, либо ссылка вида
    // run:/event:/artifact:/command:. Двух понятий доказательства в продукте нет.
    if (!evidenceExists(ctx.projectPath, evidence)) {
      return {
        id: call.id, name: call.name, result: '',
        error: 'CHECKLIST_EVIDENCE_INVALID: доказательством считается существующий файл проекта ' +
          'или ссылка вида run:/event:/artifact:/command:. Строка-заглушка не подходит.',
      }
    }
    const ok = ctx.tasks.complete(id, evidence)
    if (!ok) return { id: call.id, name: call.name, result: '', error: `checklist_complete: пункт #${id} не найден` }
    return { id: call.id, name: call.name, result: `Пункт чек-листа #${id} закрыт. Доказательство: ${evidence}` }
  },
}

export const checklistListHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    if (!ctx.tasks) return { id: call.id, name: call.name, result: '', error: 'CHECKLIST_STORAGE_UNAVAILABLE' }
    const items = ctx.tasks.list(ctx.projectPath)
    if (items.length === 0) return { id: call.id, name: call.name, result: 'Чек-лист пуст.' }
    const lines = items.map(item => {
      const mark = item.done ? '[x]' : '[ ]'
      const origin = item.source === 'system' ? 'Verstak' : 'пользователь'
      const link = item.planId ? `, план #${item.planId}` : ''
      const proof = item.evidence ? `, доказательство: ${item.evidence}` : ''
      return `${mark} #${item.id} ${item.text} (${origin}${link}${proof})`
    })
    return { id: call.id, name: call.name, result: `Чек-лист проекта (${items.length}):\n${lines.join('\n')}` }
  },
}
