import { ipcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { AgentRuns, AgentRunStatus, AgentRunOwner } from '../storage/agent-runs'
import type { SubSessions } from '../storage/sub-sessions'
import type { SessionTodos } from '../storage/session-todos'
import { getRunInput } from '../storage/run-inputs'

/**
 * IPC для вкладки «Задачи» (Multi-agent Manager).
 *
 * Один ai:send = одна строка agent_runs. Эта вкладка — высокоуровневый
 * командный центр прогонов (в отличие от низкоуровневого AgentsPanel,
 * который инспектит суб-сессии).
 *
 *  - agent-runs:list   → прогоны проекта (новейшие первыми, фильтры status/owner)
 *  - agent-runs:get    → агрегат одного прогона: run + events (Timeline) +
 *    субы (parentChatId == run.chatId) + todos (sessionId == run.chatId)
 *  - agent-runs:stop   → Фаза 4: переиспользует ai:stop abort по send_id,
 *    помечает прогон stopped
 *  - agent-runs:resume → Фаза 4: честный re-send из run_inputs (renderer сам
 *    переключает чат и зовёт обычный ai:send тем же текстом)
 */
export function registerAgentRunsIpc(
  agentRuns: AgentRuns,
  subSessions: SubSessions,
  sessionTodos: SessionTodos,
  db: Database,
  abortSend: (sendId: number) => boolean
): void {
  ipcMain.handle(
    'agent-runs:list',
    (_e, projectPath: string, opts?: { status?: AgentRunStatus; owner?: AgentRunOwner; limit?: number }) =>
      agentRuns.list(projectPath, opts)
  )

  ipcMain.handle('agent-runs:get', (_e, runId: string) => {
    const run = agentRuns.get(runId)
    // Прогона нет (удалён / неизвестный id) — отдаём пустой агрегат, чтобы
    // панель показала «не найдено» без падения.
    if (!run) return { run: null, events: [], subs: [], todos: [] }
    const events = agentRuns.getEvents(runId)
    // waiting_review ВЫЧИСЛЯЕТСЯ строго из данных (Фаза 4): если прогон завершён
    // (done) и последнее verify-событие = fail — переопределяем статус на
    // waiting_review (нужна доработка ревью), не трогая хранимый status. Так UI
    // показывает «ждёт ревью» только при реальном источнике, без выдумок.
    // TODO(P2): вторая ветка из роадмапа — «незакрытая review-сессия» — пока не
    // реализована: chat_sessions(kind='review') не несёт признака done/closed,
    // надёжного источника «не закрыта» нет. Добавить вместе с lifecycle ревью.
    if (run.status === 'done') {
      const lastVerify = [...events].reverse().find(e => e.kind === 'verify')
      if (lastVerify && lastVerify.status === 'fail') {
        run.status = 'waiting_review'
      }
    }
    // Субы этого прогона: суб-сессии проекта, чей parentChatId совпадает с
    // chatId прогона. Если у прогона нет chatId — субов нет.
    const subs = run.chatId != null
      ? subSessions.listByProject(run.projectPath).filter(s => s.parentChatId === run.chatId)
      : []
    // Todos прогона — оркестрационный лист той же сессии (chatId).
    const todos = run.chatId != null
      ? sessionTodos.list(run.projectPath, run.chatId)
      : []
    return { run, events, subs, todos }
  })

  // Stop (Фаза 4): прерываем активный прогон через тот же abort, что и ai:stop
  // (каскадит в субы + sub-queue.cancel через ctx.signal). После аборта явно
  // помечаем прогон stopped — finish идемпотентен (WHERE ended_at IS NULL), так
  // что естественный finally runner'а с exitReason='aborted' уже не затрёт это.
  // send_id неактивен (прогон завершён / уже без процесса) → no-op, false.
  ipcMain.handle('agent-runs:stop', (_e, runId: string): boolean => {
    const run = agentRuns.get(runId)
    if (!run || run.sendId == null) return false
    // Уже завершён — нечего останавливать.
    if (run.endedAt != null) return false
    const aborted = abortSend(run.sendId)
    if (!aborted) return false
    try {
      agentRuns.finish(runId, 'stopped', {})
    } catch { /* finish идемпотентен/best-effort — abort уже произошёл */ }
    return true
  })

  // Resume (Фаза 4) = честный re-send (НЕ checkpoint-resume). Возвращаем
  // renderer'у { chatId, userMessage } из run_inputs — панель переключится на
  // этот чат и зовёт обычный window.api.ai.send тем же текстом. Нет run_inputs
  // (старый прогон без снапшота) → { error }.
  ipcMain.handle('agent-runs:resume', (_e, runId: string): { chatId: number | null; userMessage: string } | { error: string } => {
    const run = agentRuns.get(runId)
    if (!run) return { error: 'Прогон не найден' }
    const input = getRunInput(db, runId)
    if (!input || !input.userMessage) {
      return { error: 'Нет сохранённого ввода прогона — переотправка недоступна (старый прогон).' }
    }
    return { chatId: run.chatId, userMessage: input.userMessage }
  })
}
