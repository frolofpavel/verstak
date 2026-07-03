import { describe, it, expect } from 'vitest'
import { parseRecipe } from '../../electron/ai/skills/recipe'

/**
 * Этап 4, Блок A — валидация recipe-блока. Ключевое: fail-soft (невалидный → undefined,
 * скилл остаётся обычным), обязательный минимум id+известные шаги, деградация полей.
 */
describe('parseRecipe (Этап 4)', () => {
  it('парсит полный валидный recipe', () => {
    const r = parseRecipe({
      id: 'typescript-error',
      kind: 'coding',
      trigger: ['typescript error', 'npm run type failed'],
      read_set: ['package.json', 'tsconfig*.json', '**/*.ts'],
      steps: ['inspect_error', 'locate_files', 'propose_patch', 'apply_patch', 'run_verify', 'summarize'],
      verify: { commands: ['npm run type'] },
      reviewer: { required: false },
      stop: ['typecheck_green', 'diff_explained', 'no_unrelated_changes'],
    })
    expect(r).toBeDefined()
    expect(r!.id).toBe('typescript-error')
    expect(r!.kind).toBe('coding')
    expect(r!.steps).toEqual(['inspect_error', 'locate_files', 'propose_patch', 'apply_patch', 'run_verify', 'summarize'])
    expect(r!.verify).toEqual({ commands: ['npm run type'] })
    expect(r!.reviewer).toEqual({ required: false })
    expect(r!.trigger).toHaveLength(2)
    expect(r!.read_set).toContain('**/*.ts')
  })

  it('kind по умолчанию coding если не задан', () => {
    const r = parseRecipe({ id: 'x', steps: ['apply_patch'] })
    expect(r!.kind).toBe('coding')
  })

  // fail-soft причины → undefined
  it('undefined: не объект', () => {
    expect(parseRecipe(undefined)).toBeUndefined()
    expect(parseRecipe(null)).toBeUndefined()
    expect(parseRecipe('recipe')).toBeUndefined()
    expect(parseRecipe(['a'])).toBeUndefined()
  })

  it('undefined: нет id', () => {
    expect(parseRecipe({ steps: ['apply_patch'] })).toBeUndefined()
    expect(parseRecipe({ id: '   ', steps: ['apply_patch'] })).toBeUndefined()
  })

  it('undefined: нет ни одного ИЗВЕСТНОГО шага', () => {
    expect(parseRecipe({ id: 'x', steps: [] })).toBeUndefined()
    expect(parseRecipe({ id: 'x', steps: ['nonsense', 'also_bad'] })).toBeUndefined()
    expect(parseRecipe({ id: 'x' })).toBeUndefined()
  })

  it('неизвестные шаги молча отбрасываются, валидные остаются', () => {
    const r = parseRecipe({ id: 'x', steps: ['apply_patch', 'nonsense', 'run_verify'] })
    expect(r!.steps).toEqual(['apply_patch', 'run_verify'])
  })

  it('деградация полей: trigger/read_set/stop → пустые массивы, verify/reviewer → undefined', () => {
    const r = parseRecipe({ id: 'x', steps: ['summarize'] })
    expect(r!.trigger).toEqual([])
    expect(r!.read_set).toEqual([])
    expect(r!.stop).toEqual([])
    expect(r!.verify).toBeUndefined()
    expect(r!.reviewer).toBeUndefined()
  })

  it('verify с пустыми commands → verify undefined, но recipe валиден', () => {
    const r = parseRecipe({ id: 'x', steps: ['apply_patch'], verify: { commands: [] } })
    expect(r).toBeDefined()
    expect(r!.verify).toBeUndefined()
  })

  it('reviewer.required не boolean → reviewer undefined', () => {
    const r = parseRecipe({ id: 'x', steps: ['apply_patch'], reviewer: { required: 'yes' } })
    expect(r!.reviewer).toBeUndefined()
  })

  it('compensation: только whitelisted значения enum', () => {
    const r = parseRecipe({
      id: 'x',
      steps: ['apply_patch'],
      compensation: { toolMode: 'json', editStrategy: 'bogus', promptStyle: 'terse', knownIssues: ['ломает generics'] },
    })
    expect(r!.compensation).toEqual({ toolMode: 'json', promptStyle: 'terse', knownIssues: ['ломает generics'] })
  })

  it('compensation пустой/мусорный → undefined', () => {
    expect(parseRecipe({ id: 'x', steps: ['apply_patch'], compensation: { editStrategy: 'nope' } })!.compensation).toBeUndefined()
    expect(parseRecipe({ id: 'x', steps: ['apply_patch'], compensation: 'x' })!.compensation).toBeUndefined()
  })
})
