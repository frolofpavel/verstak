import { useState, useEffect } from 'react'
import { diffLines, type Change } from 'diff'
import { useProject } from '../store/projectStore'

interface FileDiffStats {
  added: number
  removed: number
  parts: Change[]
}

function computeDiff(before: string, after: string): FileDiffStats {
  const parts = diffLines(before, after)
  let added = 0, removed = 0
  for (const p of parts) {
    const lines = p.value.split('\n').filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === '')).length
    if (p.added) added += lines
    else if (p.removed) removed += lines
  }
  return { added, removed, parts }
}

export function DiffView() {
  const { pendingWrites, resolvePendingWrite, updateActivity, path } = useProject()
  const [activeCallId, setActiveCallId] = useState<string | null>(null)

  // Whenever the queue changes, keep activeCallId pointing at something valid
  useEffect(() => {
    if (pendingWrites.length === 0) {
      setActiveCallId(null)
      return
    }
    if (!activeCallId || !pendingWrites.some(w => w.callId === activeCallId)) {
      setActiveCallId(pendingWrites[0].callId)
    }
  }, [pendingWrites, activeCallId])

  const active = pendingWrites.find(w => w.callId === activeCallId) ?? pendingWrites[0] ?? null

  // Keyboard shortcuts while the modal is open. The handler closes over
  // pendingWrites / active.callId via the dependency array.
  useEffect(() => {
    if (!active) return
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        void rejectAll()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        e.stopPropagation()
        void acceptAll()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        if (active) void acceptOne(active.callId)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        if (pendingWrites.length < 2 || !active) return
        e.preventDefault()
        const idx = pendingWrites.findIndex(w => w.callId === active.callId)
        const next = pendingWrites[(idx + 1) % pendingWrites.length]
        if (next) setActiveCallId(next.callId)
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        if (pendingWrites.length < 2 || !active) return
        e.preventDefault()
        const idx = pendingWrites.findIndex(w => w.callId === active.callId)
        const next = pendingWrites[(idx - 1 + pendingWrites.length) % pendingWrites.length]
        if (next) setActiveCallId(next.callId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.callId, pendingWrites.length])

  if (pendingWrites.length === 0 || !active) return null
  const diff = computeDiff(active.before, active.after)

  async function acceptOne(callId: string) {
    const w = pendingWrites.find(x => x.callId === callId)
    if (!w) return
    const d = computeDiff(w.before, w.after)
    await window.api.ai.resolveWrite(callId, true, w.sendId)
    updateActivity(callId, { status: 'ok', detail: `${w.path} (+${d.added} −${d.removed})` })
    if (path) {
      void window.api.journal.append(path, 'tool', `Изменён файл: ${w.path}`, `+${d.added} −${d.removed} строк`)
    }
    resolvePendingWrite(callId)
  }
  async function rejectOne(callId: string) {
    const w = pendingWrites.find(x => x.callId === callId)
    await window.api.ai.resolveWrite(callId, false, w?.sendId)
    updateActivity(callId, { status: 'rejected' })
    resolvePendingWrite(callId)
  }
  async function acceptAll() {
    const ids = pendingWrites.map(w => w.callId)
    for (const id of ids) await acceptOne(id)
  }
  async function rejectAll() {
    const ids = pendingWrites.map(w => w.callId)
    for (const id of ids) await rejectOne(id)
  }

  return (
    <div className="gg-modal-backdrop" onClick={() => void rejectAll()}>
      <div className="gg-modal gg-modal-large" onClick={e => e.stopPropagation()}>
        <div className="gg-modal-header">
          <div>
            <div className="gg-modal-title">
              {pendingWrites.length === 1 ? 'Изменение файла' : `Изменения в ${pendingWrites.length} файлах`}
            </div>
            <div className="gg-diff-path" style={{ marginTop: 4 }}>{active.path}</div>
          </div>
          <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)' }}>
            <span style={{ color: 'var(--diff-add)' }}>+{diff.added}</span>{' '}
            <span style={{ color: 'var(--diff-remove)' }}>−{diff.removed}</span>
          </div>
        </div>

        <div className="gg-modal-body" style={{ display: 'flex', padding: 0, gap: 0, minHeight: 0 }}>
          {pendingWrites.length > 1 && (
            <div className="gg-diff-files">
              {pendingWrites.map(w => {
                const d = computeDiff(w.before, w.after)
                const isActive = w.callId === active.callId
                return (
                  <div key={w.callId} className={`gg-diff-file-row ${isActive ? 'is-active' : ''}`}>
                    <button className="gg-diff-file-pick" onClick={() => setActiveCallId(w.callId)}>
                      <div className="gg-diff-file-path" title={w.path}>{w.path}</div>
                      <div className="gg-diff-file-stats">
                        <span style={{ color: 'var(--diff-add)' }}>+{d.added}</span>{' '}
                        <span style={{ color: 'var(--diff-remove)' }}>−{d.removed}</span>
                      </div>
                    </button>
                    <div className="gg-diff-file-actions">
                      <button className="gg-diff-file-act is-accept" onClick={() => void acceptOne(w.callId)} title="Принять только этот">✓</button>
                      <button className="gg-diff-file-act is-reject" onClick={() => void rejectOne(w.callId)} title="Отклонить только этот">×</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <div className="gg-diff-body" style={{ flex: 1, margin: '16px 22px', maxHeight: '60vh' }}>
            {diff.parts.map((part, i) => {
              const lines = part.value.split('\n')
              if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
              const cls = part.added ? 'gg-diff-line-add' : part.removed ? 'gg-diff-line-remove' : 'gg-diff-line-context'
              const prefix = part.added ? '+ ' : part.removed ? '− ' : '  '
              return lines.map((line, j) => (
                <div key={`${i}-${j}`} className={`gg-diff-line ${cls}`}>{prefix + line}</div>
              ))
            })}
          </div>
        </div>

        <div className="gg-modal-footer">
          <div className="gg-modal-footer-hint">
            <span className="gg-kbd">Enter</span> принять
            {' · '}<span className="gg-kbd">Esc</span> отклонить
            {pendingWrites.length > 1 && (
              <>{' · '}<span className="gg-kbd">Ctrl+Enter</span> принять все{' · '}<span className="gg-kbd">←→</span> между файлами</>
            )}
          </div>
          {pendingWrites.length > 1 ? (
            <>
              <button className="gg-btn gg-btn-danger" onClick={() => void rejectAll()}>Отклонить все</button>
              <button className="gg-btn gg-btn-success" onClick={() => void acceptAll()}>Принять все ({pendingWrites.length})</button>
            </>
          ) : (
            <>
              <button className="gg-btn gg-btn-danger" onClick={() => void rejectOne(active.callId)}>Отклонить</button>
              <button className="gg-btn gg-btn-success" onClick={() => void acceptOne(active.callId)}>Принять</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
