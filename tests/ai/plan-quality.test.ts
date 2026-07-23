import { describe, expect, it } from 'vitest'
import { scorePlanQuality } from '../../electron/ai/plan-quality'
import { validContract } from '../contracts/outcome-contract.test'
import type { PlanStepSpecV1 } from '../../shared/contracts/outcome'

const step = (over: Partial<PlanStepSpecV1> = {}): PlanStepSpecV1 => ({
  key: 'auth-fix',
  title: 'Исправить создание сессии',
  intent: 'Исправить обработку успешного ответа в функции login',
  files: ['src/auth/login.ts'],
  symbols: ['login'],
  actions: ['Обновить ветку сохранения сессии'],
  dependsOn: [],
  readScope: ['src/auth'],
  writeScope: ['src/auth/login.ts'],
  acceptanceCriterionIds: ['auth-green'],
  verification: ['npm test -- auth'],
  expectedEvidence: ['command:npm test -- auth'],
  rollback: 'git revert',
  role: 'executor',
  execution: 'main',
  risk: 'medium',
  ...over,
})

describe('deterministic Plan Quality', () => {
  it('пропускает исполнимый план', () => {
    expect(scorePlanQuality(validContract, [step()], 1)).toEqual({
      score: 100, status: 'pass', hardErrors: [], warnings: [], checkedAt: 1,
    })
  })

  it('блокирует unknown dependency и цикл', () => {
    const quality = scorePlanQuality(validContract, [
      step({ key: 'a', dependsOn: ['b'] }),
      step({ key: 'b', dependsOn: ['a'], acceptanceCriterionIds: ['auth-green'] }),
    ])
    expect(quality.status).toBe('block')
    expect(quality.hardErrors.join(' ')).toContain('цикл')
  })

  it('блокирует пересечение parallel writeScope', () => {
    const quality = scorePlanQuality(validContract, [
      step({ key: 'a', execution: 'parallel-candidate' }),
      step({ key: 'b', execution: 'parallel-candidate' }),
    ])
    expect(quality.hardErrors.join(' ')).toContain('пересекаются')
  })

  it('blocking questions не позволяют планировать', () => {
    const quality = scorePlanQuality({ ...validContract, blockingQuestions: ['Какой OAuth flow?'] }, [step()])
    expect(quality.status).toBe('block')
  })
})
