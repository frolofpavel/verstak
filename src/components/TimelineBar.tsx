import { useProject } from '../store/projectStore'

/**
 * Horizontal pulse lane shown between the chat stream and the composer.
 *
 * Gemini Ultra audit (2026-05-21, idea A): users describe the agent as a
 * "black box" — they can't tell what it's doing right now without scrolling
 * through long messages. This lane gives a constant visual heartbeat: every
 * tool the agent ran in this turn appears here as a short pill.
 *
 * Source of truth is `useProject().activity` — same array the inline activity
 * list reads. We display only the most-recent N pills to keep the lane tidy.
 */

const ICONS: Record<string, string> = {
  read: '📖',
  list: '📂',
  write: '✏',
  command: '⚡',
  blocked: '🚫'
}

const MAX_VISIBLE = 14

function shortenPath(detail: string | undefined): string {
  if (!detail) return ''
  // Tool details look like "src/components/Chat.tsx · 123 символов" — strip
  // the suffix; otherwise just trim long content.
  const path = detail.split(' · ')[0] ?? detail
  // Keep last two segments so the user knows where without going wide
  const segs = path.split(/[\\/]/)
  if (segs.length > 2) return '…/' + segs.slice(-2).join('/')
  return path.length > 36 ? path.slice(0, 33) + '…' : path
}

export function TimelineBar() {
  const activity = useProject(s => s.activity)
  const isStreaming = useProject(s => s.isStreaming)

  if (activity.length === 0) return null

  // Most recent at the right, like a tape moving forward.
  const visible = activity.slice(-MAX_VISIBLE)
  const hiddenCount = activity.length - visible.length

  return (
    <div className={`gg-timeline ${isStreaming ? 'is-streaming' : ''}`} role="log" aria-label="Активность агента">
      {hiddenCount > 0 && (
        <span className="gg-timeline-overflow" title={`Ещё ${hiddenCount} событий раньше`}>+{hiddenCount}</span>
      )}
      {visible.map(a => {
        const icon = ICONS[a.kind] ?? '·'
        const detail = shortenPath(a.detail)
        const tooltip = `${a.label}${a.detail ? '\n' + a.detail : ''}\nстатус: ${a.status}`
        return (
          <span
            key={a.id}
            className={`gg-timeline-pill is-${a.kind} is-${a.status}`}
            title={tooltip}
          >
            <span className="gg-timeline-pill-icon">{icon}</span>
            {detail && <span className="gg-timeline-pill-detail">{detail}</span>}
          </span>
        )
      })}
    </div>
  )
}
