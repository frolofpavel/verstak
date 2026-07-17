import { useState, useEffect, useCallback } from 'react'
import { useProject } from '../store/projectStore'
import { useProvider } from '../hooks/useProvider'
import { isolationIneffectiveWarning } from '../lib/worktree-honesty'

/**
 * #5 worktree-lifecycle: панель изоляции чата. «Изолировать» создаёт отдельную
 * git-копию — правки агента накапливаются в ней, основное дерево не трогается до
 * «Применить» (локальный merge, без push) или «Отбросить». Требует git-проект.
 */
type Status = { active: false } | { active: true; worktreePath: string; fileCount: number; hasChanges: boolean }

export function WorktreeBar() {
  const { activeChatId, path, isStreaming, helpMode } = useProject()
  const provider = useProvider()
  const [status, setStatus] = useState<Status>({ active: false })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false) // не-git проект → прячем после первой ошибки

  const refresh = useCallback(() => {
    if (helpMode || activeChatId == null) { setStatus({ active: false }); return }
    void window.api.worktree.status(activeChatId).then(setStatus).catch(() => {})
  }, [activeChatId, helpMode])

  useEffect(() => { refresh() }, [refresh, isStreaming])

  if (helpMode || activeChatId == null || !path || hidden) return null

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setErr(null)
    try {
      const r = await fn()
      if (!r.ok) {
        setErr(r.error ?? 'ошибка')
        if (/git-репозиторий/.test(r.error ?? '')) setHidden(true) // не-git → больше не показываем
      } else { refresh() }
    } catch { setErr('ошибка') } finally { setBusy(false) }
  }

  if (!status.active) return null

  // Ре-ревью honesty #2: изоляция активна, но провайдер чата стал CLI (переключили
  // постфактум). CLI правит реальный проект — «🌿 Изолировано» тут ложь. Говорим правду.
  const ineffective = isolationIneffectiveWarning(status.active, {
    transport: provider.transport,
    supportsTools: provider.supportsTools,
    label: provider.label,
  })

  return (
    <div className={`gg-worktree-bar is-active${ineffective ? ' is-warn' : ''}`}>
      <span className="gg-worktree-label">
        {ineffective
          ? `⚠ Изоляция не действует · ${provider.label}`
          : `🌿 Изолировано${status.hasChanges ? ` · ${status.fileCount} файл(ов) изменено` : ' · без изменений'}`}
      </span>
      {ineffective && <span className="gg-worktree-err" role="status">{ineffective}</span>}
      <button
        className="gg-btn gg-btn-success"
        disabled={busy || isStreaming || !status.hasChanges}
        onClick={() => void run(() => window.api.worktree.merge(activeChatId))}
        title="Применить накопленные изменения в основное дерево (локально, без push)"
      >✓ Применить в main</button>
      <button
        className="gg-btn gg-btn-ghost"
        disabled={busy || isStreaming}
        onClick={() => void run(() => window.api.worktree.snapshot(activeChatId))}
        title="Сохранить snapshot изолированной сессии для восстановления"
      >◇ Снимок</button>
      <button
        className="gg-btn gg-btn-ghost"
        disabled={busy || isStreaming}
        onClick={() => void run(() => window.api.worktree.discard(activeChatId))}
        title="Отбросить изоляцию и все её изменения"
      >✕ Отбросить</button>
      {err && <span className="gg-worktree-err">{err}</span>}
    </div>
  )
}
