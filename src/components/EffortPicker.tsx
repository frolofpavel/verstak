import { useEffect, useRef, useState } from 'react'
import { useProject } from '../store/projectStore'
import { useT, type Translations } from '../i18n'

export type EffortLevel = 'quick' | 'standard' | 'deep'

// §5 ревью 2.6.4: подписи главного экрана — из словаря, а не литералами.
// Английский интерфейс показывал «Стандарт» рядом с «What needs to be done?».
function optionsFor(t: Translations): Array<{ id: EffortLevel; label: string; hint: string }> {
  return [
    { id: 'quick', label: t.effort.quick, hint: t.effort.quickHint },
    { id: 'standard', label: t.effort.standard, hint: t.effort.standardHint },
    { id: 'deep', label: t.effort.deep, hint: t.effort.deepHint },
  ]
}

export function EffortPicker() {
  const t = useT()
  const OPTIONS = optionsFor(t)
  const labelFor = (level: EffortLevel): string =>
    OPTIONS.find(o => o.id === level)?.label ?? t.effort.standard
  const effortLevel = useProject(s => s.effortLevel)
  const setEffortLevel = useProject(s => s.setEffortLevel)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="gg-effort-wrap" ref={wrapRef}>
      <button
        type="button"
        className="gg-effort-trigger"
        onClick={() => setOpen(v => !v)}
        title={t.effort.title}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span>{labelFor(effortLevel)}</span>
        <span className="gg-effort-chevron" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="gg-effort-popover" role="listbox">
          {OPTIONS.map(opt => (
            <button
              key={opt.id}
              type="button"
              className={`gg-effort-option ${effortLevel === opt.id ? 'is-active' : ''}`}
              onClick={() => { setEffortLevel(opt.id); setOpen(false) }}
              role="option"
              aria-selected={effortLevel === opt.id}
            >
              <span className="gg-effort-option-label">{opt.label}</span>
              <span className="gg-effort-option-hint">{opt.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}