import { AgentProgressPanel } from './AgentProgressPanel'
import type { AgentProgressEntry } from '../lib/agent-progress'
import { useProject } from '../store/projectStore'
import type { ResumableRun } from '../types/api'

function trimRequest(text: string, limit = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1)}...`
}

function buildInterruptedRunProgress(run: ResumableRun): AgentProgressEntry[] {
  const title = run.autoResumable ? 'Ответ можно повторить' : 'Ответ прерван'
  const request = trimRequest(run.lastUserRequest)
  const toolNote = run.lastToolName ? ` Последний инструмент: ${run.lastToolName}.` : ''
  const detail = run.autoResumable
    ? `Verstak нашёл задачу, которая оборвалась при закрытии приложения. Можно повторить последний запрос: "${request}".${toolNote}`
    : `Модель начала работу, но приложение было закрыто до безопасного завершения. Последнее действие могло менять файлы или систему, поэтому автоматическое продолжение отключено. Запрос: "${request}".${toolNote}`

  return [
    {
      id: `resume-${run.runId}`,
      phase: 'final',
      title,
      detail,
      status: run.autoResumable ? 'blocked' : 'error',
      timestamp: Date.now()
    }
  ]
}

export function ResumeBanner() {
  const resumableRuns = useProject(s => s.resumableRuns)
  const dismissResumableRun = useProject(s => s.dismissResumableRun)
  const setActiveView = useProject(s => s.setActiveView)
  const switchChatSession = useProject(s => s.switchChatSession)

  if (resumableRuns.length === 0) return null

  async function resume(run: ResumableRun) {
    try {
      if (run.chatId != null) await switchChatSession(run.chatId)
    } catch {
      // Если переключение не удалось, оставляем текущий чат и не блокируем действие.
    }
    setActiveView('chat')
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('gg-resume-send', {
        detail: { text: run.lastUserRequest, resumeFromRunId: run.runId }
      }))
    }, 0)
    dismissResumableRun(run.runId)
  }

  function showWhatWasDone(run: ResumableRun) {
    setActiveView('tasks-manager')
    dismissResumableRun(run.runId)
  }

  return (
    <div className="gg-resume-progress-stack">
      {resumableRuns.map(run => (
        <div key={run.runId} className="gg-agent-progress-inline is-standalone gg-resume-progress">
          <AgentProgressPanel
            entries={buildInterruptedRunProgress(run)}
            isStreaming={false}
            finishedAt={Date.now()}
          />
          <div className="gg-resume-progress-actions">
            {run.autoResumable ? (
              <button
                type="button"
                className="gg-btn gg-btn-primary"
                onClick={() => resume(run)}
                title="Повторить последний запрос в нужном чате"
              >
                Повторить запрос
              </button>
            ) : (
              <button
                type="button"
                className="gg-btn"
                onClick={() => showWhatWasDone(run)}
                title="Открыть вкладку задач и посмотреть, на чём остановилась работа"
              >
                Показать что было
              </button>
            )}
            <button
              type="button"
              className="gg-btn"
              onClick={() => dismissResumableRun(run.runId)}
              title="Скрыть это уведомление в текущем сеансе"
            >
              Отклонить
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
