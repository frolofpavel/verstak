import { useT } from '../i18n'
import type { PendingSupplement, QueuedComposerMessage } from '../lib/composer-streaming'

interface ComposerPendingBarProps {
  queueItems: QueuedComposerMessage[]
  supplements: PendingSupplement[]
  expanded: boolean
  onToggle: () => void
  onRemoveQueueItem?: (id: string) => void
  onRemoveSupplement?: (id: string) => void
  onMoveQueueItemToContext?: (id: string) => void
  onEditQueueItem?: (id: string) => void
}

function formatItemTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ComposerPendingBar({
  queueItems,
  supplements,
  expanded,
  onToggle,
  onRemoveQueueItem,
  onRemoveSupplement,
  onMoveQueueItemToContext,
  onEditQueueItem,
}: ComposerPendingBarProps) {
  const t = useT()
  const queueCount = queueItems.length
  const supplementCount = supplements.length
  if (queueCount === 0 && supplementCount === 0) return null

  const queueTitle = queueCount === 1
    ? t.chat.pendingBarQueueOne
    : t.chat.pendingBarQueueMany.replace('{n}', String(queueCount))

  const supplementTitle = supplementCount === 1
    ? t.chat.pendingBarSupplementOne
    : t.chat.pendingBarSupplementMany.replace('{n}', String(supplementCount))

  const summaryParts: string[] = []
  if (queueCount > 0) summaryParts.push(queueTitle)
  if (supplementCount > 0) summaryParts.push(supplementTitle)

  return (
    <div className={`gg-composer-pending-bar${expanded ? ' is-expanded' : ''}`}>
      <button
        type="button"
        className="gg-composer-pending-bar-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="gg-composer-pending-bar-icon" aria-hidden>⏳</span>
        <span className="gg-composer-pending-bar-summary">{summaryParts.join(' · ')}</span>
        <span className="gg-composer-pending-bar-chevron" aria-hidden>{expanded ? '▾' : '▴'}</span>
      </button>

      {expanded && (
        <div className="gg-composer-pending-bar-panel">
          {supplementCount > 0 && (
            <section className="gg-composer-pending-section">
              <div className="gg-composer-pending-section-title">{t.chat.pendingBarSupplementSection}</div>
              <ul className="gg-composer-pending-list is-supplements">
                {supplements.map(item => (
                  <li key={item.id} className={`gg-composer-pending-item is-supplement is-${item.status}`}>
                    <div className="gg-composer-pending-item-head">
                      <span className="gg-composer-pending-item-badge">
                        {item.status === 'accepted'
                          ? t.chat.pendingBarSupplementAccepted
                          : t.chat.pendingBarSupplementDeferred}
                      </span>
                      <time className="gg-composer-pending-item-time">{formatItemTime(item.at)}</time>
                      {onRemoveSupplement && (
                        <button
                          type="button"
                          className="gg-composer-pending-item-remove"
                          onClick={() => onRemoveSupplement(item.id)}
                          title={item.status === 'accepted' ? t.chat.pendingBarHideAcceptedSupplement : t.chat.pendingBarRemoveSupplement}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <div className="gg-composer-pending-item-text">{item.text}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {queueCount > 0 && (
            <section className="gg-composer-pending-section">
              <div className="gg-composer-pending-section-title">{t.chat.pendingBarQueueSection}</div>
              <ol className="gg-composer-pending-list">
                {queueItems.map((item, index) => (
                  <li key={item.id} className="gg-composer-pending-item is-queue">
                    <div className="gg-composer-pending-item-head">
                      <span className="gg-composer-pending-item-order">
                        {t.chat.pendingBarQueueOrder.replace('{n}', String(index + 1))}
                      </span>
                      <time className="gg-composer-pending-item-time">{formatItemTime(item.at)}</time>
                      {(onMoveQueueItemToContext || onEditQueueItem || onRemoveQueueItem) && (
                        <span className="gg-composer-pending-item-actions">
                          {onMoveQueueItemToContext && (
                            <button
                              type="button"
                              className="gg-composer-pending-item-action"
                              onClick={() => onMoveQueueItemToContext(item.id)}
                              title={t.chat.pendingBarMoveQueueToSupplementHint}
                            >
                              {t.chat.pendingBarMoveQueueToSupplement}
                            </button>
                          )}
                          {onEditQueueItem && (
                            <button
                              type="button"
                              className="gg-composer-pending-item-action"
                              onClick={() => onEditQueueItem(item.id)}
                              title="Редактировать сообщение"
                            >
                              Править
                            </button>
                          )}
                        </span>
                      )}
                      {onRemoveQueueItem && (
                        <button
                          type="button"
                          className="gg-composer-pending-item-remove"
                          onClick={() => onRemoveQueueItem(item.id)}
                          title={t.chat.pendingBarRemoveQueue}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <div className="gg-composer-pending-item-text">{item.text}</div>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
