import { describe, expect, it } from 'vitest'
import {
  parsePlanStepSpec,
  parseTaskContract,
  parseTaskContractJson,
  type TaskContractV1,
} from '../../shared/contracts/outcome'

export const validContract: TaskContractV1 = {
  schemaVersion: 1,
  revision: 1,
  rawRequest: 'почини вход',
  goal: 'Вход пользователя завершается созданием сессии без регрессий',
  successCriteria: [{ id: 'auth-green', text: 'Auth integration test проходит', evidence: 'command', verify: 'npm test -- auth' }],
  constraints: ['Не менять формат токена'],
  nonGoals: ['Не переделывать регистрацию'],
  assumptions: [{ text: 'Тестовая БД доступна', status: 'confirmed' }],
  blockingQuestions: [],
  repoEvidence: [{ path: 'src/auth/login.ts', symbol: 'login', why: 'Точка создания сессии' }],
  risk: 'medium',
  planningMode: 'controlled',
}

describe('TaskContractV1 runtime contract', () => {
  it('принимает валидный контракт без потерь', () => {
    expect(parseTaskContract(validContract)).toEqual({ value: validContract, diagnostics: [] })
  })

  it('invalid JSON не бросает исключение и возвращает typed diagnostic', () => {
    const parsed = parseTaskContractJson('{bad')
    expect(parsed.value).toBeNull()
    expect(parsed.diagnostics[0].code).toBe('invalid-json')
  })

  it('блокирует пустые successCriteria и неверную revision', () => {
    const parsed = parseTaskContract({ ...validContract, revision: 0, successCriteria: [] })
    expect(parsed.value).toBeNull()
    expect(parsed.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['invalid-revision', 'missing-field']))
  })
})

describe('PlanStepSpecV1 runtime contract', () => {
  it('сохраняет dependency, scope и verification', () => {
    const raw = {
      key: 'auth-fix', title: 'Исправить login', intent: 'Исправить создание сессии в login',
      files: ['src/auth/login.ts'], symbols: ['login'], actions: ['Изменить ветку ошибки'],
      dependsOn: [], readScope: ['src/auth'], writeScope: ['src/auth/login.ts'],
      acceptanceCriterionIds: ['auth-green'], verification: ['npm test -- auth'],
      expectedEvidence: ['command:npm test -- auth'], rollback: 'git revert',
      role: 'executor', execution: 'main', risk: 'medium',
    }
    expect(parsePlanStepSpec(raw).value).toEqual(raw)
  })
})
