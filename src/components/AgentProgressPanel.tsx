import { useEffect, useMemo, useRef } from 'react'

import type { AgentProgressEntry, AgentProgressStatus } from '../lib/agent-progress'

interface AgentProgressPanelProps {
  entries: AgentProgressEntry[]
  isStreaming: boolean
  elapsedMs?: number | null
  durationMs?: number | null
  finishedAt?: number | null
}

const STATUS_LABEL: Record<AgentProgressStatus, string> = {
  pending: 'ожидаю',
  running: 'идёт',
  done: 'готово',
  error: 'ошибка',
  blocked: 'остановлено'
}

function currentEntry(entries: AgentProgressEntry[]): AgentProgressEntry | null {
  const visible = entries.filter(e => e.id !== 'task-focus')
  const active = visible
    .filter(e => e.status === 'running' || e.status === 'pending')
    .sort((a, b) => b.timestamp - a.timestamp)[0]
  if (active) return active
  const terminal = visible
    .filter(e => e.id === 'done' || e.id === 'error' || e.phase === 'final')
    .sort((a, b) => b.timestamp - a.timestamp)[0]
  if (terminal) return terminal
  return [...visible].sort((a, b) => b.timestamp - a.timestamp)[0] ?? null
}

function recentEntries(entries: AgentProgressEntry[], currentId?: string): AgentProgressEntry[] {
  return entries
    .filter(e => e.id !== 'task-focus' && e.id !== currentId)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-14)
}

function historyStatus(entry: AgentProgressEntry, currentId?: string): AgentProgressStatus {
  if (entry.id === currentId) return entry.status
  if (entry.status === 'running' || entry.status === 'pending') return 'done'
  return entry.status
}

function entryTitle(entry: AgentProgressEntry, isStreaming: boolean): string {
  if (!isStreaming && entry.status === 'done') return 'Задача выполнена'
  return entry.title
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds} с`
  return `${minutes} м ${seconds.toString().padStart(2, '0')} с`
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function AgentProgressPanel({
  entries,
  isStreaming,
  elapsedMs,
  durationMs,
  finishedAt
}: AgentProgressPanelProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const current = useMemo(() => currentEntry(entries), [entries])
  const recent = useMemo(() => recentEntries(entries, current?.id), [entries, current?.id])

  useEffect(() => {
    if (!bodyRef.current) return
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [entries, current?.id, current?.timestamp, isStreaming])

  if (entries.length === 0) return null

  const fallbackFinishedAt = !isStreaming
    ? [...entries].sort((a, b) => b.timestamp - a.timestamp)[0]?.timestamp ?? null
    : null
  const effectiveFinishedAt = finishedAt ?? fallbackFinishedAt
  const effectiveDurationMs = isStreaming
    ? elapsedMs ?? null
    : durationMs ?? null
  const currentTitle = current ? entryTitle(current, isStreaming) : null
  const showCurrentState = current ? !(current.status === 'done' && !isStreaming) : false
  const timeMeta = isStreaming
    ? effectiveDurationMs != null ? formatDuration(effectiveDurationMs) : null
    : effectiveDurationMs != null
      ? `за ${formatDuration(effectiveDurationMs)}${effectiveFinishedAt ? ` · завершено ${formatClock(effectiveFinishedAt)}` : ''}`
      : effectiveFinishedAt
        ? `завершено ${formatClock(effectiveFinishedAt)}`
        : null

  return (
    <details className={`gg-agent-progress ${isStreaming ? 'is-live' : 'is-settled'}`}>
      <summary className="gg-agent-progress-summary">
        <span className="gg-agent-progress-kicker">Ход работы</span>
        {current && (
          <span className={`gg-agent-progress-current is-${current.status}`}>
            <span className="gg-agent-progress-dot" aria-hidden />
            <span className="gg-agent-progress-current-title">{currentTitle}</span>
            {showCurrentState && (
              <span className={`gg-agent-progress-state is-${current.status}`}>{STATUS_LABEL[current.status]}</span>
            )}
          </span>
        )}
        {timeMeta && (
          <span className={`gg-agent-progress-timer ${isStreaming ? 'is-live' : 'is-done'}`}>{timeMeta}</span>
        )}
      </summary>

      <div className="gg-agent-progress-body" ref={bodyRef}>
        {current && (
          <div className={`gg-agent-progress-now is-${current.status}`}>
            <div className="gg-agent-progress-now-head">
              <span className="gg-agent-progress-now-label">Сейчас</span>
              {showCurrentState && (
                <span className={`gg-agent-progress-now-state is-${current.status}`}>{STATUS_LABEL[current.status]}</span>
              )}
            </div>
            <div className="gg-agent-progress-now-title">{currentTitle}</div>
            {current.detail && <div className="gg-agent-progress-now-detail">{current.detail}</div>}
          </div>
        )}

        {recent.length > 0 && (
          <div className="gg-agent-progress-trail" aria-label="Этапы работы">
            <div className="gg-agent-progress-trail-label">Этапы работы</div>
            {recent.map(entry => {
              const eventStatus = historyStatus(entry, current?.id)
              return (
                <div key={entry.id} className={`gg-agent-progress-event is-${eventStatus}`}>
                  <span className="gg-agent-progress-event-dot" aria-hidden />
                  <div>
                    <div className="gg-agent-progress-event-title">{entry.title}</div>
                    {entry.detail && <div className="gg-agent-progress-event-detail">{entry.detail}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </details>
  )
}
