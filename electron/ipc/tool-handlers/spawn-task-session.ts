// Задача 10 (оркестратор): spawn_task_session — вынести задачу в ОТДЕЛЬНУЮ ВИДИМУЮ
// сессию. Хендлер синтезирует seed и эмитит событие в renderer, который создаёт
// дочерний чат (parentChatId = активный), сеет seed и показывает карточку-след.
// Инструмент предлагается модели ТОЛЬКО при включённом orchestrator_default (гейт в
// runner-api) — за выключенным флагом сюда управление не доходит.
import type { ToolHandler } from './shared'
import { buildTaskSessionSeed } from '../../ai/orchestrator/seed'

export const spawnTaskSessionHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const title = String(call.args.title ?? '').trim()
    const task = String(call.args.task ?? '').trim()
    if (!title || !task) {
      return { id: call.id, name: call.name, result: '', error: 'spawn_task_session: title и task обязательны' }
    }
    const seed = buildTaskSessionSeed({ title, task })
    if (!seed) {
      return { id: call.id, name: call.name, result: '', error: 'spawn_task_session: пустая задача' }
    }
    // Видимая дочерняя сессия создаётся в renderer (тихой оркестрации нет: человек
    // увидит карточку-след). Событие эфемерное, в БД не пишется.
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      event: { type: 'spawn-task-session', callId: call.id, title, seed },
    })
    try {
      ctx.recordJournal(ctx.projectPath, 'tool', `Оркестратор: «${title}» → отдельная сессия`, null)
    } catch { /* журнал не критичен */ }
    return { id: call.id, name: call.name, result: { spawned: true, title } }
  }
}
