import { useCallback, useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import { meterView, compactResultText, compactedHint } from '../lib/context-meter'
import type { ContextStateDTO } from '../types/api'

/**
 * Сжатие контекста чата — срез 2.0.11-B. Содержимое подменю «Контекст».
 *
 * Тонкий слой: тексты и доступность считает src/lib/context-meter (покрыт тестами),
 * гейты и страж гонки живут в main. Здесь — только показать и позвать.
 */
export function ContextMeter() {
  const path = useProject(s => s.path)
  const activeChatId = useProject(s => s.activeChatId)
  const isStreaming = useProject(s => s.isStreaming)
  const pushActivity = useProject(s => s.pushActivity)

  const [state, setState] = useState<ContextStateDTO | null>(null)
  const [busyLocal, setBusyLocal] = useState(false)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)

  const load = useCallback(async () => {
    if (activeChatId == null) { setState(null); return }
    setState(await window.api.context.state(activeChatId))
  }, [activeChatId])

  // Перечитываем при открытии и после окончания ответа: во время стрима состояние
  // меняется (сообщений прибавилось), и старая цифра врала бы.
  useEffect(() => { void load() }, [load, isStreaming])

  const view = meterView(state, !!path)

  const compact = async () => {
    if (activeChatId == null || busyLocal) return
    setBusyLocal(true)
    setNote(null)
    try {
      const result = await window.api.context.compact(activeChatId)
      const shown = compactResultText(result)
      setNote(shown)
      if (result.ok) {
        pushActivity({
          id: `context-compact-${Date.now()}`,
          kind: 'write',
          label: '🗜 Контекст свёрнут',
          detail: shown.text,
          status: 'ok',
          timestamp: Date.now(),
        })
      }
      await load()
    } catch (err) {
      // Падение самого вызова — тоже осечка, а не потеря: контекст на месте.
      setNote({ text: err instanceof Error ? err.message : 'Не удалось свернуть — контекст не тронут', ok: false })
    } finally {
      setBusyLocal(false)
    }
  }

  if (!path) return <div className="gg-tools-empty">Открой проект слева</div>
  if (activeChatId == null) return <div className="gg-tools-empty">Нет активного чата</div>

  return (
    <>
      <button
        type="button"
        className="gg-tools-row"
        onClick={() => void compact()}
        disabled={!view.canCompact || busyLocal}
      >
        <span className="gg-tools-row-label">{busyLocal ? 'Сворачиваю…' : 'Свернуть начало разговора'}</span>
        <span className="gg-tools-row-meta">
          {busyLocal ? 'модель пишет итог' : view.canCompact ? (state ? compactedHint(state) : '') : view.blockedReason}
        </span>
      </button>
      {note && (
        <div className="gg-tools-submenu-title" role="status">{note.text}</div>
      )}
    </>
  )
}
