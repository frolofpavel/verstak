import { describe, expect, it } from 'vitest'
import { decideSwarmRubric, scoreSwarmVariant } from '../../electron/ai/swarm-rubric'

describe('structured swarm rubric', () => {
  it('оценивает coverage, проверки, scope, diff, риск и confidence', () => {
    const score = scoreSwarmVariant({
      id: 'safe',
      result: 'СДЕЛАЛ: готово\nПроверка: tests PASS\nРИСКИ: откат через undo\n+const ok = true',
    })
    expect(score).toMatchObject({
      id: 'safe',
      coverage: 2,
      verification: 2,
      scopeCompliance: 2,
      diffQuality: 2,
      riskRollback: 2,
      confidence: 1,
    })
  })

  it('уверенный лидер рекомендуется, ничья и high risk уходят пользователю', () => {
    const safe = 'РЕЗУЛЬТАТ: готово\nTests PASS\nРиски и rollback описаны\n+ok'
    expect(decideSwarmRubric([{ id: 'a', result: safe }, { id: 'b', result: 'идея' }])).toMatchObject({
      recommendedId: 'a',
      needsUserDecision: false,
    })
    expect(decideSwarmRubric([{ id: 'a', result: safe }, { id: 'b', result: safe }]).needsUserDecision).toBe(true)
    expect(decideSwarmRubric([{ id: 'x', result: 'out-of-scope unrelated change' }]).needsUserDecision).toBe(true)
  })
})
