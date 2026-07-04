import { describe, it, expect } from 'vitest'
import { EMPTY_BRIEF, SAMPLE_BRIEF, isBriefReady, buildPlanPrompt, buildExecutePrompt, pipelineStepIndex, buildPipelineSend, verifyState, resolveProofRunId, resolvePipelineRunId, resolveReviewCandidateRunIds, reviewGateState } from '../../src/lib/pipeline-brief'

describe('pipeline-brief', () => {
  it('EMPTY_BRIEF не готов', () => {
    expect(isBriefReady(EMPTY_BRIEF)).toBe(false)
  })

  it('SAMPLE_BRIEF (демо из онбординга) — готов к отправке', () => {
    expect(isBriefReady(SAMPLE_BRIEF)).toBe(true)
  })

  it('готов когда есть цель И DoD (границы опциональны)', () => {
    expect(isBriefReady({ goal: 'fix', constraints: '', dod: 'npm run type' })).toBe(true)
  })

  it('не готов без DoD или без цели', () => {
    expect(isBriefReady({ goal: 'fix', constraints: '', dod: '' })).toBe(false)
    expect(isBriefReady({ goal: '', constraints: 'x', dod: 'test' })).toBe(false)
    expect(isBriefReady({ goal: '   ', constraints: '', dod: '  ' })).toBe(false)
  })

  it('buildPlanPrompt: цель/границы/DoD + read-only инструкция', () => {
    const p = buildPlanPrompt({ goal: 'починить tsc', constraints: 'не трогать билд', dod: 'npm run type' })
    expect(p).toContain('Задача: починить tsc')
    expect(p).toContain('Не трогать: не трогать билд')
    expect(p).toContain('DoD: npm run type')
    expect(p).toContain('НЕ вноси изменений')
    expect(p).toContain('create_plan')
  })

  it('buildPlanPrompt: пустые границы → «—»', () => {
    expect(buildPlanPrompt({ goal: 'g', constraints: '', dod: 'd' })).toContain('Не трогать: —')
  })

  it('buildExecutePrompt: planId + DoD + attest_verification', () => {
    const p = buildExecutePrompt({ goal: 'g', constraints: '', dod: 'npm test' }, 42)
    expect(p).toContain('plan id=42')
    expect(p).toContain('DoD: npm test')
    expect(p).toContain('attest_verification')
  })

  it('buildExecutePrompt: agency mode требует review_before_commit', () => {
    const p = buildExecutePrompt({ goal: 'g', constraints: '', dod: 'npm test' }, 42, true)
    expect(p).toContain('review_before_commit')
    expect(p).toContain('REVIEW GATE: ПРОЙДЕНО')
  })

  it('pipelineStepIndex: plan=2/6 … proof=6/6', () => {
    expect(pipelineStepIndex('plan')).toEqual({ index: 2, total: 6 })
    expect(pipelineStepIndex('execute')).toEqual({ index: 3, total: 6 })
    expect(pipelineStepIndex('verify')).toEqual({ index: 4, total: 6 })
    expect(pipelineStepIndex('review')).toEqual({ index: 5, total: 6 })
    expect(pipelineStepIndex('proof')).toEqual({ index: 6, total: 6 })
  })

  const brief = { goal: 'fix', constraints: '', dod: 'npm test' }

  it('buildPipelineSend plan → planPrompt + mode plan', () => {
    const s = buildPipelineSend('plan', brief, null)
    expect(s?.mode).toBe('plan')
    expect(s?.text).toContain('НЕ вноси изменений')
  })

  it('buildPipelineSend execute → executePrompt c planId + mode accept-edits', () => {
    const s = buildPipelineSend('execute', brief, 17)
    expect(s?.mode).toBe('accept-edits')
    expect(s?.text).toContain('plan id=17')
  })

  it('buildPipelineSend execute в agency → требует review gate', () => {
    const s = buildPipelineSend('execute', brief, 17, { requireReviewGate: true })
    expect(s?.text).toContain('review_before_commit')
  })

  it('buildPipelineSend для verify/review/proof → null (нет авто-send)', () => {
    expect(buildPipelineSend('verify', brief, 1)).toBeNull()
    expect(buildPipelineSend('review', brief, 1)).toBeNull()
    expect(buildPipelineSend('proof', brief, 1)).toBeNull()
  })

  it('verifyState: passed→pass+canProof, failed→fail, partial/not_run/null→warn', () => {
    expect(verifyState('passed')).toEqual({ tone: 'pass', canProof: true })
    expect(verifyState('failed')).toEqual({ tone: 'fail', canProof: false })
    expect(verifyState('partial')).toEqual({ tone: 'warn', canProof: false })
    expect(verifyState('not_run')).toEqual({ tone: 'warn', canProof: false })
    expect(verifyState(null)).toEqual({ tone: 'warn', canProof: false })
  })

  it('resolveProofRunId: привязанный → он; иначе прогон чата; без точной связки → null', () => {
    const runs = [{ runId: 'r-new', chatId: 9 }, { runId: 'r-chat', chatId: 5 }]
    expect(resolveProofRunId('r-pinned', 5, runs)).toBe('r-pinned')
    expect(resolveProofRunId(null, 5, runs)).toBe('r-chat')
    expect(resolveProofRunId(null, 99, runs)).toBeNull()
    expect(resolveProofRunId(null, 1, [])).toBeNull()
  })

  it('resolvePipelineRunId: sendId точнее связки по чату, без точной связки → null', () => {
    const runs = [
      { runId: 'r-exec', chatId: 5, sendId: 42 },
      { runId: 'r-other', chatId: 5, sendId: 7 },
    ]
    expect(resolvePipelineRunId(null, 42, 5, runs)).toBe('r-exec')
    expect(resolvePipelineRunId('r-pinned', 42, 5, runs)).toBe('r-pinned')
    expect(resolvePipelineRunId(null, 99, 5, runs)).toBe('r-exec')
    expect(resolvePipelineRunId(null, 99, 9, runs)).toBeNull()
  })

  it('reviewGateState: missing/passed/failed по tool_call timeline', () => {
    expect(reviewGateState([]).state).toBe('missing')
    expect(reviewGateState([
      { kind: 'tool_call', label: 'review_before_commit', detail: 'REVIEW GATE: ПРОЙДЕНО · ok', status: 'ok' },
    ]).state).toBe('passed')
    expect(reviewGateState([
      { kind: 'tool_call', label: 'review_before_commit', detail: 'verify failed', status: 'error' },
    ]).state).toBe('failed')
  })

  it('resolveReviewCandidateRunIds: pinned run + свежие run того же чата без дублей', () => {
    const runs = [
      { runId: 'r-review', chatId: 5 },
      { runId: 'r-other-chat', chatId: 9 },
      { runId: 'r-exec', chatId: 5 },
    ]
    expect(resolveReviewCandidateRunIds('r-exec', 5, runs)).toEqual(['r-exec', 'r-review'])
    expect(resolveReviewCandidateRunIds(null, 5, runs)).toEqual(['r-review', 'r-exec'])
  })
})
