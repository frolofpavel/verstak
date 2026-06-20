import { describe, it, expect } from 'vitest'
import { EMPTY_BRIEF, SAMPLE_BRIEF, isBriefReady, buildPlanPrompt, buildExecutePrompt, pipelineStepIndex, buildPipelineSend, verifyState, resolveProofRunId, resolvePipelineRunId } from '../../src/lib/pipeline-brief'

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

  it('pipelineStepIndex: plan=2/5 … proof=5/5', () => {
    expect(pipelineStepIndex('plan')).toEqual({ index: 2, total: 5 })
    expect(pipelineStepIndex('execute')).toEqual({ index: 3, total: 5 })
    expect(pipelineStepIndex('verify')).toEqual({ index: 4, total: 5 })
    expect(pipelineStepIndex('proof')).toEqual({ index: 5, total: 5 })
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

  it('buildPipelineSend для verify/proof → null (нет авто-send)', () => {
    expect(buildPipelineSend('verify', brief, 1)).toBeNull()
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
})
