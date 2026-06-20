// TodoGate-хендлеры: todo_create / todo_update / todo_list (Фаза 3, Идея 2).
// Вынесено из tool-handlers.ts (распил монолита) — поведение без изменений.
import type { ToolHandler, ToolContext } from './shared'
import { emitActivity } from './shared'

// Общий формат todo-листа для tool-результата (компактно, без шума).
function formatTodoList(todos: Array<{ id: number; title: string; status: string; assigneeCallId?: string | null }>): string {
  if (todos.length === 0) return 'Todo-лист пуст.'
  const icon: Record<string, string> = { pending: '☐', in_progress: '⏳', done: '✅', blocked: '⛔' }
  const lines = todos.map(t => `${icon[t.status] ?? '☐'} #${t.id} ${t.title}${t.assigneeCallId ? ` (assignee: ${t.assigneeCallId})` : ''}`)
  const done = todos.filter(t => t.status === 'done').length
  return `Прогресс: ${done}/${todos.length}\n${lines.join('\n')}`
}

// Эфемерное событие для live-обновления секции Todo в панели Agents.
function emitTodoUpdate(ctx: ToolContext): void {
  ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'todo-updated' } })
}

export const todoCreateHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.sessionTodos) {
      return { id: call.id, name: call.name, result: '', error: 'todo_create: TodoGate недоступен в этом контексте' }
    }
    const rawItems = Array.isArray(call.args.items) ? call.args.items : []
    const titles = rawItems.map(String).map(s => s.trim()).filter(Boolean)
    if (titles.length === 0) {
      return { id: call.id, name: call.name, result: '', error: 'todo_create: items обязателен (непустой массив строк)' }
    }
    const goal = call.args.goal ? String(call.args.goal) : null
    try {
      const created = ctx.sessionTodos.createBatch({
        projectPath: ctx.projectPath,
        sessionId: ctx.parentChatId ?? null,
        goal, titles
      })
      emitTodoUpdate(ctx)
      emitActivity(ctx, call, 'ok', 'todo_create', `${created.length} пунктов${goal ? ` · ${goal.slice(0, 40)}` : ''}`)
      return { id: call.id, name: call.name, result: `Создан todo-лист (${created.length} пунктов):\n${formatTodoList(created)}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

export const todoUpdateHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.sessionTodos) {
      return { id: call.id, name: call.name, result: '', error: 'todo_update: TodoGate недоступен в этом контексте' }
    }
    const sessionId = ctx.parentChatId ?? null
    // Идентификация пункта: по числовому id ИЛИ по точному title (субу удобнее
    // по названию — он не всегда знает id).
    let todoId: number | null = null
    if (typeof call.args.id === 'number') {
      todoId = Math.floor(call.args.id)
    } else if (call.args.title) {
      const found = ctx.sessionTodos.findByTitle(ctx.projectPath, sessionId, String(call.args.title))
      todoId = found?.id ?? null
    }
    if (todoId == null) {
      return { id: call.id, name: call.name, result: '', error: 'todo_update: укажи id (число) или title (точное название существующего пункта)' }
    }
    const status = call.args.status ? String(call.args.status) : undefined
    const allowed = ['pending', 'in_progress', 'done', 'blocked']
    if (status !== undefined && !allowed.includes(status)) {
      return { id: call.id, name: call.name, result: '', error: `todo_update: status должен быть одним из ${allowed.join('/')}` }
    }
    // assignee_call_id опционален — кто взял пункт (callId суба).
    const assigneeCallId = call.args.assignee_call_id !== undefined
      ? (call.args.assignee_call_id ? String(call.args.assignee_call_id) : null)
      : undefined
    try {
      ctx.sessionTodos.update(todoId, { status, assigneeCallId })
      emitTodoUpdate(ctx)
      const list = ctx.sessionTodos.list(ctx.projectPath, sessionId)
      emitActivity(ctx, call, 'ok', 'todo_update', `#${todoId}${status ? ` → ${status}` : ''}`)
      return { id: call.id, name: call.name, result: `Обновлён пункт #${todoId}.\n${formatTodoList(list)}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

export const todoListHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    if (!ctx.sessionTodos) {
      return { id: call.id, name: call.name, result: '', error: 'todo_list: TodoGate недоступен в этом контексте' }
    }
    try {
      const list = ctx.sessionTodos.list(ctx.projectPath, ctx.parentChatId ?? null)
      emitActivity(ctx, call, 'ok', 'todo_list', `${list.length} пунктов`)
      return { id: call.id, name: call.name, result: formatTodoList(list) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}
