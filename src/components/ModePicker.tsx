import { useEffect, useRef, useState } from 'react'
import { modeControlInfo } from '../lib/runtime-capability'
import { useProvider } from '../hooks/useProvider'

/**
 * Agent mode picker — visible toggle для пяти режимов работы агента.
 * По аналогии с Claude Code (Ask / Accept / Plan / Auto / Bypass).
 *
 * Mode хранится в settings под ключом 'agent_mode'. Main процесс
 * читает его через getAgentMode() при каждом ai:send и пробрасывает
 * в ToolContext, где tool-handlers решают confirm/auto-accept/block.
 */

export type AgentMode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'

interface ModeOption {
  id: AgentMode
  label: string
  description: string
  icon: string
  shortcut: string
}

const MODES: ModeOption[] = [
  { id: 'ask',          icon: '🛡', label: 'Запрос разрешений',  description: 'Подтверждение каждого изменения. Безопасно.',           shortcut: '1' },
  { id: 'accept-edits', icon: '✏', label: 'Принимать правки',   description: 'Файлы авто, команды через подтверждение.',              shortcut: '2' },
  { id: 'plan',         icon: '📋', label: 'Режим планирования', description: 'Только чтение и планирование. Без изменений.',          shortcut: '3' },
  { id: 'auto',         icon: '⚡', label: 'Авто-режим',         description: 'Всё авто-принимается. Осторожно.',                       shortcut: '4' },
  { id: 'bypass',       icon: '🚀', label: 'Без подтверждения',  description: 'Никаких диалогов. Для опытных и CI.',                    shortcut: '5' }
]

function shortLabel(mode: AgentMode): string {
  return MODES.find(m => m.id === mode)?.label ?? mode
}

function shortIcon(mode: AgentMode): string {
  return MODES.find(m => m.id === mode)?.icon ?? '?'
}

interface Props {
  /** Current mode, polled from settings. */
  mode: AgentMode
  /** Called when user picks a different mode. */
  onChange: (next: AgentMode) => void
  /** Справка: режим зафиксирован, переключение недоступно. */
  locked?: boolean
}

export function ModePicker({ mode, onChange, locked = false }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const provider = useProvider()
  const control = modeControlInfo(provider.id, provider.transport)
  const showControlNote = control.level !== 'verstak'

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // Keyboard shortcuts 1-5 when popover is open
  useEffect(() => {
    if (!open || locked) return
    function onKey(e: KeyboardEvent) {
      const idx = parseInt(e.key, 10)
      if (idx >= 1 && idx <= MODES.length) {
        e.preventDefault()
        onChange(MODES[idx - 1].id)
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onChange, locked])

  return (
    <div className="gg-mp-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`gg-mode-pill is-mode-${mode}${locked ? ' is-locked' : ''}`}
        onClick={() => { if (!locked) setOpen(v => !v) }}
        disabled={locked}
        aria-disabled={locked}
        title={locked
          ? `Режим справки: ${shortLabel(mode)} (заблокирован)`
          : `Режим агента: ${shortLabel(mode)}. Клик чтобы сменить.`}
      >
        <span className="gg-mode-icon">{shortIcon(mode)}</span>
        <span className="gg-mode-label">{shortLabel(mode)}</span>
        {showControlNote && <span className={`gg-mode-control-badge is-${control.tone}`}>{control.shortLabel}</span>}
      </button>

      {open && !locked && (
        <div className="gg-mp-popover gg-mp-popover-opaque">
          <div className="gg-mp-section">
            <div className="gg-mp-section-title">Режим работы агента</div>
            <div className={`gg-mode-control-note is-${control.tone}`}>
              <span>{control.label}</span>
              <small>{control.hint}</small>
            </div>
            {MODES.map(m => (
              <button
                key={m.id}
                type="button"
                className={`gg-mp-row gg-mp-row-stack ${mode === m.id ? 'is-active' : ''}`}
                onClick={() => { onChange(m.id); setOpen(false) }}
              >
                <span className="gg-mp-row-top">
                  <span className="gg-mp-row-label">{m.label}</span>
                  <span className="gg-mp-row-shortcut">{m.shortcut}</span>
                </span>
                <span className="gg-mp-row-desc">{m.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
