import { useEffect, useRef, useState } from 'react'
import { MULTI_AGENT_LIST } from '../lib/multi-agent-templates'

/**
 * Multi-agent picker — кнопка ⚡ в composer-toolbar + popup с 3 пунктами
 * (Оркестратор / Рой / Параллельно).
 *
 * Делает мультиагентные инструменты (orchestrate / swarm / delegate_parallel)
 * доступными пользователю осознанно — раньше их вызывала только модель.
 * Каждый пункт инжектит готовый ИМПЕРАТИВНЫЙ шаблон в композер через onInject
 * (тот же текст, что и slash-команды /orchestrate /swarm /parallel).
 *
 * Поведение копирует SkillPicker: открытие/закрытие по клику вне popup и Esc.
 */
export function MultiAgentPicker({ onInject }: { onInject: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Закрытие popup по клику вне + Esc (паттерн из SkillPicker).
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  function pick(template: string) {
    onInject(template)
    setOpen(false)
  }

  return (
    <div className="gg-maac-wrap" ref={wrapRef}>
      <button
        type="button"
        className="gg-skill-picker-btn"
        onClick={() => setOpen(v => !v)}
        title="Мультиагент — оркестратор, рой, параллельные задачи"
      >
        <span className="gg-skill-icon">⚡</span>
        <span>Мультиагент</span>
      </button>
      {open && (
        <div className="gg-skill-popup gg-maac-popup">
          <div className="gg-skill-popup-header">
            <span className="gg-skill-popup-title">Мультиагент</span>
          </div>
          {MULTI_AGENT_LIST.map(t => (
            <button
              key={t.trigger}
              type="button"
              className="gg-skill-popup-item"
              onClick={() => pick(t.template)}
            >
              <span className="gg-skill-icon">{t.icon}</span>
              <span className="gg-skill-popup-item-body">
                <span className="gg-skill-popup-item-name">
                  {t.label}
                  <code className="gg-skill-popup-slash">/{t.trigger}</code>
                </span>
                <span className="gg-skill-popup-item-desc">{t.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
