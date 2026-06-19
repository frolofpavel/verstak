import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import { useT } from '../i18n'
import { pipelineStepIndex, verifyState } from '../lib/pipeline-brief'
import type { PipelineStep, VerificationRow } from '../types/api'

interface PipelineBannerProps {
  /** Действие первичной кнопки шага (advance + оркестрация send). */
  onPrimary: (step: PipelineStep) => void
}

/**
 * Sticky-баннер Pipeline (спек §3): «Pipeline · N/5 · {шаг}» + действие шага.
 * На Verify-шаге (D6) читает реальный verifications.latest и красит статус:
 * 🟢 passed → «→ Proof», 🟡 partial/not_run → «Дожать», 🔴 failed → дожать/откат.
 */
export function PipelineBanner({ onPrimary }: PipelineBannerProps) {
  const t = useT()
  const pipeline = useProject(s => s.activePipeline)
  const cancelPipeline = useProject(s => s.cancelPipeline)
  const [verify, setVerify] = useState<VerificationRow | null>(null)

  const step = pipeline?.step
  const projectPath = pipeline?.projectPath
  const chatId = pipeline?.chatId ?? null

  // На Verify-шаге подтягиваем свежайшую верификацию проекта/чата.
  useEffect(() => {
    if (step !== 'verify' || !projectPath) { setVerify(null); return }
    let cancelled = false
    void window.api.verifications.latest(projectPath, chatId).then(v => {
      if (!cancelled) setVerify(v)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [step, projectPath, chatId])

  if (!pipeline || !step) return null
  if (step === 'completed' || step === 'cancelled') return null

  const { index, total } = pipelineStepIndex(step)
  const stepLabel: Record<string, string> = {
    plan: t.pipeline.stepPlan,
    execute: t.pipeline.stepExecute,
    verify: t.pipeline.stepVerify,
    proof: t.pipeline.stepProof,
    blocked: t.pipeline.stepBlocked,
  }
  const primaryLabel: Partial<Record<PipelineStep, string>> = {
    plan: t.pipeline.planOk,
    execute: t.pipeline.toVerify,
    proof: t.pipeline.toProof,
  }

  function reattest() {
    window.dispatchEvent(new CustomEvent('gg-resume-send', {
      detail: 'Вызови attest_verification и подтверди выполнение DoD: перепрогони проверки и собери артефакт.',
    }))
  }

  const vs = verifyState(verify?.overall)
  const verifyLabel = vs.tone === 'pass' ? t.pipeline.verifyPass
    : vs.tone === 'fail' ? t.pipeline.verifyFail
      : t.pipeline.verifyWarn

  return (
    <div className="gg-pipeline-banner" role="status">
      <span className="gg-pipeline-banner-tag">{t.pipeline.banner}</span>
      <span className="gg-pipeline-banner-step">{index}/{total} · {stepLabel[step] ?? step}</span>
      <span className="gg-pipeline-banner-goal" title={pipeline.brief.goal}>{pipeline.brief.goal}</span>
      {step === 'verify' && (
        <span className={`gg-pipeline-verify is-${vs.tone}`}>
          {verifyLabel}{verify ? ` ${verify.checksPassed}/${verify.checksTotal}` : ''}
        </span>
      )}
      <span className="gg-pipeline-banner-spacer" />

      {step === 'verify' ? (
        vs.canProof ? (
          <button type="button" className="gg-btn gg-btn-primary gg-btn-xs" onClick={() => onPrimary('verify')}>
            {t.pipeline.toProof}
          </button>
        ) : (
          <>
            <button type="button" className="gg-btn gg-btn-ghost gg-btn-xs" onClick={reattest}>
              {t.pipeline.reattest}
            </button>
            <button type="button" className="gg-btn gg-btn-ghost gg-btn-xs" onClick={() => onPrimary('verify')}>
              {t.pipeline.fixRetry}
            </button>
          </>
        )
      ) : (
        primaryLabel[step] && (
          <button type="button" className="gg-btn gg-btn-primary gg-btn-xs" onClick={() => onPrimary(step)}>
            {primaryLabel[step]}
          </button>
        )
      )}

      <button type="button" className="gg-btn gg-btn-ghost gg-btn-xs" onClick={() => void cancelPipeline()}>
        {t.pipeline.cancelRun}
      </button>
    </div>
  )
}
