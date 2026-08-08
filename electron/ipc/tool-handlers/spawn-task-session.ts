// Задача 10 (оркестратор): spawn_task_session — вынести задачу в ОТДЕЛЬНУЮ ВИДИМУЮ
// сессию. Хендлер синтезирует seed и эмитит событие в renderer, который создаёт
// дочерний чат (parentChatId = активный), сеет seed и показывает карточку-след.
// Инструмент предлагается модели ТОЛЬКО при включённом orchestrator_default (гейт в
// runner-api) — за выключенным флагом сюда управление не доходит.
import type { ToolHandler } from './shared'
import { buildTaskSessionSeed } from '../../ai/orchestrator/seed'
import { SPAWN_TASK_TURNS } from '../../ai/runner-shared'
import { resolveDecision } from '../../ai/permission-rules'
import { blockReason } from '../../ai/mode-policy'

export const spawnTaskSessionHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    // ГЕЙТ РЕЖИМА (восьмой обход, 08.08): спавн ПОРОЖДАЕТ ИСПОЛНЕНИЕ, поэтому в plan
    // блокируется (родитель в «ничего не менять» не заводит исполняющую дочернюю сессию).
    // ctx.agentMode здесь = режим РОДИТЕЛЬСКОГО прогона (того, что зовёт spawn).
    const { decision, reason } = resolveDecision(call.name, call.args, ctx.agentMode, ctx.autoApprove, ctx.permissionRules)
    if (decision === 'block') {
      return { id: call.id, name: call.name, result: '', error: reason ?? blockReason(call.name, ctx.agentMode) }
    }
    const title = String(call.args.title ?? '').trim()
    const task = String(call.args.task ?? '').trim()
    if (!title || !task) {
      return { id: call.id, name: call.name, result: '', error: 'spawn_task_session: title и task обязательны' }
    }
    // Бюджет-факт в seed = ТОТ ЖЕ SPAWN_TASK_TURNS, что main даст дочернему прогону
    // (resolveTurnsBudget при isChildSession) — единый источник, «24 хода» не разъедется с фактом.
    const seed = buildTaskSessionSeed({ title, task, turnsBudget: SPAWN_TASK_TURNS })
    if (!seed) {
      return { id: call.id, name: call.name, result: '', error: 'spawn_task_session: пустая задача' }
    }
    // Видимая дочерняя сессия создаётся в renderer (тихой оркестрации нет: человек
    // увидит карточку-след). Событие эфемерное, в БД не пишется.
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      // toolsAllow РОДИТЕЛЬСКОГО прогона едет к ребёнку: дочерняя сессия не может быть
      // шире родителя (тот же принцип, что наследование режима — восьмой обход). Renderer
      // форвардит его в overrides дочернего sendWithOverrides. null = у родителя скилла нет.
      event: { type: 'spawn-task-session', callId: call.id, title, seed, toolsAllow: ctx.toolsAllow ?? null },
    })
    try {
      ctx.recordJournal(ctx.projectPath, 'tool', `Оркестратор: «${title}» → отдельная сессия`, null)
    } catch { /* журнал не критичен */ }
    return { id: call.id, name: call.name, result: { spawned: true, title } }
  }
}
