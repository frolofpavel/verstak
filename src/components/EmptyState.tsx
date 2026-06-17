import type { ReactNode } from 'react'

type EmptyStateProps = {
  icon?: ReactNode
  title: string
  hint?: string
  action?: ReactNode
  className?: string
}

/** Единый блок «пусто» для панелей задач, агентов, dev-task и т.п. */
export function EmptyState({ icon, title, hint, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`gg-empty-state ${className}`.trim()}>
      {icon ? <div className="gg-empty-state-icon" aria-hidden>{icon}</div> : null}
      <div className="gg-empty-state-title">{title}</div>
      {hint ? <div className="gg-empty-state-hint">{hint}</div> : null}
      {action ? <div className="gg-empty-state-action">{action}</div> : null}
    </div>
  )
}