// Декомпозиция Chat.tsx (2.1.11 срез C): мелкие презентационные части сообщения.
//
// Перенесено из Chat.tsx дословно, без изменения разметки, классов и стилей.
// Отдельный модуль нужен потому, что потребители разъехались по двум файлам:
// `AttachmentChip` и `formatSize` остались нужны композеру в Chat.tsx, а
// `AttachmentPreview` и `MessageActions` уехали в поток (chat/ChatStreamMessages).
// Импорт из Chat.tsx создал бы цикл — поэтому общий низ вынесен сюда.

import { useState } from 'react'
import type { Attachment } from '../../types/api'

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Hover toolbar shown under every message — copy-to-clipboard for now.
 * Hidden by default; fades in on .gg-msg:hover (см. layout.css).
 * При наведении появляется кнопка копирования.
 */
export function MessageActions({ text, onEdit }: { text: string; onEdit?: () => void }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch { /* clipboard может быть запрещён — молча игнорим */ }
  }
  return (
    <div className="gg-msg-actions">
      {/* 2.0.11-D: «править» доступна только на своих сообщениях. Правка не меняет
          оригинал — создаёт ветку с этого места, текст ждёт черновиком в композере. */}
      {onEdit && (
        <button
          type="button"
          className="gg-msg-action"
          onClick={onEdit}
          title="Править в новой ветке (оригинал не меняется)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          <span>править</span>
        </button>
      )}
      <button
        type="button"
        className="gg-msg-action"
        onClick={() => void copy()}
        title="Скопировать текст сообщения"
      >
        {copied ? (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>скопировано</span>
          </>
        ) : (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <span>копировать</span>
          </>
        )}
      </button>
    </div>
  )
}

export function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const isImage = attachment.mimeType.startsWith('image/')
  const src = isImage ? `data:${attachment.mimeType};base64,${attachment.data}` : null
  return (
    <div className="gg-attach-chip">
      {src ? <img src={src} alt={attachment.name} className="gg-attach-thumb" /> : <div className="gg-attach-icon">📄</div>}
      <div className="gg-attach-meta">
        <div className="gg-attach-name" title={attachment.name}>{attachment.name}</div>
        <div className="gg-attach-size">{formatSize(attachment.size)}</div>
      </div>
      <button className="gg-attach-remove" onClick={onRemove} title="Убрать">×</button>
    </div>
  )
}

export function AttachmentPreview({ attachment, compact }: { attachment: Attachment; compact?: boolean }) {
  const isImage = attachment.mimeType.startsWith('image/')
  if (isImage) {
    return (
      <img
        src={`data:${attachment.mimeType};base64,${attachment.data}`}
        alt={attachment.name}
        className={compact ? 'gg-msg-image' : ''}
        style={{ maxWidth: compact ? 360 : '100%', maxHeight: compact ? 280 : '100%', borderRadius: 8, display: 'block', marginBottom: 6 }}
      />
    )
  }
  return (
    <div className="gg-attach-chip" style={{ marginBottom: 6 }}>
      <div className="gg-attach-icon">📄</div>
      <div className="gg-attach-meta">
        <div className="gg-attach-name">{attachment.name}</div>
        <div className="gg-attach-size">{formatSize(attachment.size)}</div>
      </div>
    </div>
  )
}
