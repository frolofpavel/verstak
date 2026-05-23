import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'

/**
 * Sidecar Terminal Intelligence — toast в углу когда в терминале
 * обнаружена ошибка (TS / Python / npm / ESLint / generic).
 *
 * Источник: V3 Plan раздел 4.1 (Killer-фича / Sidecar Terminal Intelligence).
 *
 * Поведение:
 *  - При term:error-detected event → показывается toast в правом нижнем углу.
 *  - Текст: «🩹 Видно {kind}-ошибку в {file}:{line} — пофикшу?»
 *  - Кнопка «Fix in chat» — вставляет ошибку в composer как готовый промпт.
 *  - Кнопка «✕» — скрыть.
 *  - Автоскрытие через 12 секунд.
 *  - Дедупликация: если та же ошибка повторяется — не показываем.
 */

interface DetectedError {
  kind: string
  file?: string
  line?: number
  message: string
  raw: string
}

interface ToastState {
  id: number
  error: DetectedError
  ts: number
}

export function TerminalErrorToast() {
  const [toast, setToast] = useState<ToastState | null>(null)
  const [lastSeenRaw, setLastSeenRaw] = useState<string | null>(null)

  useEffect(() => {
    const off = window.api.term.onErrorDetected(({ id, error }) => {
      // Дедупликация
      if (error.raw === lastSeenRaw) return
      setLastSeenRaw(error.raw)
      setToast({ id, error, ts: Date.now() })
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeenRaw])

  // Auto-hide через 12 секунд
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 12_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  if (!toast) return null

  function fixInChat() {
    if (!toast) return
    const e = toast.error
    const locator = e.file && e.line ? `${e.file}:${e.line}` : e.file ?? '<unknown location>'
    const promptText = `В терминале только что вылетела ошибка (${e.kind}):\n\n` +
      `**${locator}**\n` +
      '```\n' + e.raw + '\n```\n\n' +
      `Найди причину и предложи фикс. Не делай write_file сразу — сначала покажи план.`
    // Inject в composer textarea через global event
    window.dispatchEvent(new CustomEvent('gg-inject-prompt', { detail: promptText }))
    setToast(null)
  }

  const e = toast.error
  const kindIcon = e.kind === 'typescript' ? 'TS' : e.kind === 'python' ? '🐍' : e.kind === 'npm' ? '📦' : e.kind === 'eslint' ? '🧹' : '⚠'

  return (
    <div className="gg-term-error-toast" role="alert">
      <div className="gg-term-error-toast-head">
        <span className="gg-term-error-toast-kind">{kindIcon} {e.kind.toUpperCase()}-ошибка</span>
        <button type="button" className="gg-term-error-toast-close" onClick={() => setToast(null)} title="Скрыть">×</button>
      </div>
      {e.file && (
        <div className="gg-term-error-toast-loc">
          <code>{e.file}{e.line ? `:${e.line}` : ''}</code>
        </div>
      )}
      <div className="gg-term-error-toast-msg">{e.message}</div>
      <div className="gg-term-error-toast-actions">
        <button type="button" className="gg-btn gg-btn-primary" onClick={fixInChat}>
          🩹 Fix in chat
        </button>
      </div>
    </div>
  )
}
