import { useProject } from '../store/projectStore'
import type { ResumableRun } from '../types/api'

/**
 * Crash-resume (P1) — баннер «сессия была прервана».
 *
 * При открытии проекта projectStore.loadResumableRuns подтягивает зависшие
 * после краха прогоны (agent_runs, помеченные failed реконсайлом этого старта,
 * с сохранённым вводом). Баннер ненавязчиво предлагает что с ними сделать.
 *
 * КРИТИЧНО (безопасность): деструктив НИКОГДА не доигрывается сам. Гард
 * считается на стороне main (isAutoResumable → ResumableRun.autoResumable):
 *  - autoResumable=true  (read-only последний tool + режим ask/accept-edits/plan)
 *    → кнопка «Возобновить» = честный re-send последнего запроса (gg-resume-send,
 *    тот же путь что Multi-agent Manager resume).
 *  - autoResumable=false (last_tool ∈ write_file/apply_patch/run_command/ssh/
 *    delegate/connector ИЛИ режим auto/bypass) → НЕТ авто-resume; вместо неё
 *    «Показать что было» (открывает вкладку «Задачи» на этом прогоне) + «Отклонить».
 *
 * Re-send переиспользует существующий механизм gg-resume-send (Chat.tsx) —
 * новый путь отправки не вводим.
 */
export function ResumeBanner() {
  const resumableRuns = useProject(s => s.resumableRuns)
  const dismissResumableRun = useProject(s => s.dismissResumableRun)
  const setActiveView = useProject(s => s.setActiveView)
  const switchChatSession = useProject(s => s.switchChatSession)

  if (resumableRuns.length === 0) return null

  async function resume(run: ResumableRun) {
    // Честный re-send: тот же gg-resume-send, что у Manager-resume. КРИТИЧНО —
    // сначала переключаемся на чат прогона (run.chatId), иначе re-send уедет в
    // текущий активный чат (чужой контекст), если пользователь успел сменить
    // чат/проект после старта app (аудит P0). Паттерн — как AgentRunsPanel.
    try {
      if (run.chatId != null) await switchChatSession(run.chatId)
    } catch { /* переключение не критично — уйдёт в текущий чат */ }
    setActiveView('chat')
    // Следующий тик — даём чату перерендериться на нужной сессии до автоотправки.
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('gg-resume-send', { detail: run.lastUserRequest }))
    }, 0)
    dismissResumableRun(run.runId)
  }

  function showWhatWasDone(run: ResumableRun) {
    // Деструктив/auto: не доигрываем — открываем вкладку «Задачи», где видны
    // Timeline прогона, затронутые файлы и проверки. Решение принимает человек.
    setActiveView('tasks-manager')
    dismissResumableRun(run.runId)
  }

  return (
    <div className="gg-resume-banner-stack">
      {resumableRuns.map(run => {
        const req = run.lastUserRequest.length > 90
          ? run.lastUserRequest.slice(0, 90) + '…'
          : run.lastUserRequest
        const toolNote = run.lastToolName ? `, последний инструмент: ${run.lastToolName}` : ''
        return (
          <div key={run.runId} className="gg-resume-banner" role="status">
            <span className="gg-resume-banner-icon">⏸</span>
            <div className="gg-resume-banner-body">
              <div className="gg-resume-banner-title">Сессия была прервана</div>
              <div className="gg-resume-banner-detail">
                «{req}» (ход {run.turnIndex}{toolNote})
              </div>
              {!run.autoResumable && (
                <div className="gg-resume-banner-warn">
                  ⚠ Последнее действие могло менять файлы/систему — авто-возобновление отключено.
                </div>
              )}
            </div>
            <div className="gg-resume-banner-actions">
              {run.autoResumable ? (
                <button
                  type="button"
                  className="gg-btn gg-btn-primary"
                  onClick={() => resume(run)}
                  title="Переотправить последний запрос (read-only последний шаг — безопасно)"
                >
                  ↻ Возобновить
                </button>
              ) : (
                <button
                  type="button"
                  className="gg-btn"
                  onClick={() => showWhatWasDone(run)}
                  title="Открыть задачу: Timeline, затронутые файлы, проверки — решите вручную"
                >
                  Показать что было
                </button>
              )}
              <button
                type="button"
                className="gg-btn"
                onClick={() => dismissResumableRun(run.runId)}
                title="Скрыть — больше не предлагать в этом сеансе"
              >
                Отклонить
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
