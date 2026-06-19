import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { EMPTY_BRIEF, isBriefReady } from '../lib/pipeline-brief'
import type { PipelineBrief, PipelineRun } from '../types/api'

interface PipelineWizardProps {
  /** Чат, к которому привязать прогон (опц.). */
  chatId?: number | null
  /** Предзаполнить бриф (напр. демо из онбординга, D10). */
  initialBrief?: PipelineBrief
  onClose: () => void
  /** Вызывается после успешного pipeline:start — прогон создан, step='plan'. */
  onStarted: (run: PipelineRun) => void
}

/**
 * Pipeline Brief→Proof, шаг 1 (Brief). Три поля — цель / границы / Definition of
 * Done. «Сформировать план» активна только когда заданы цель и DoD (isBriefReady).
 * v1 — только Dev-режим (Agency — позже через WorkflowsPanel).
 */
export function PipelineWizard({ chatId, initialBrief, onClose, onStarted }: PipelineWizardProps) {
  const t = useT()
  const [brief, setBrief] = useState<PipelineBrief>(initialBrief ?? EMPTY_BRIEF)
  const [busy, setBusy] = useState(false)
  const ready = isBriefReady(brief)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  function patch(field: keyof PipelineBrief, value: string) {
    setBrief(prev => ({ ...prev, [field]: value }))
  }

  async function handleStart() {
    if (!ready || busy) return
    setBusy(true)
    try {
      const run = await window.api.pipeline.start({ mode: 'dev', brief, chatId: chatId ?? null })
      if (run) onStarted(run)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div
        className="gg-modal gg-pipeline-wizard"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gg-pipeline-title"
      >
        <div className="gg-modal-header">
          <div className="gg-modal-title" id="gg-pipeline-title">{t.pipeline.title}</div>
          <button type="button" className="gg-modal-close" onClick={onClose} title={t.common.close}>×</button>
        </div>

        <div className="gg-modal-body">
          <div className="gg-pipeline-subtitle">{t.pipeline.subtitle}</div>

          <label className="gg-create-client-field">
            <span className="gg-create-client-label">{t.pipeline.goalLabel}</span>
            <textarea
              className="gg-input gg-pipeline-textarea"
              value={brief.goal}
              onChange={e => patch('goal', e.target.value)}
              placeholder={t.pipeline.goalPlaceholder}
              rows={3}
              autoFocus
              disabled={busy}
            />
          </label>

          <label className="gg-create-client-field">
            <span className="gg-create-client-label">{t.pipeline.constraintsLabel}</span>
            <textarea
              className="gg-input gg-pipeline-textarea"
              value={brief.constraints}
              onChange={e => patch('constraints', e.target.value)}
              placeholder={t.pipeline.constraintsPlaceholder}
              rows={2}
              disabled={busy}
            />
          </label>

          <label className="gg-create-client-field">
            <span className="gg-create-client-label">{t.pipeline.dodLabel}</span>
            <textarea
              className="gg-input gg-pipeline-textarea"
              value={brief.dod}
              onChange={e => patch('dod', e.target.value)}
              placeholder={t.pipeline.dodPlaceholder}
              rows={2}
              disabled={busy}
            />
          </label>
        </div>

        <div className="gg-modal-footer">
          <span className="gg-modal-footer-spacer" />
          <button type="button" className="gg-btn gg-btn-ghost" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="gg-btn gg-btn-primary"
            onClick={() => void handleStart()}
            disabled={!ready || busy}
          >
            {busy ? t.pipeline.starting : t.pipeline.start}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
