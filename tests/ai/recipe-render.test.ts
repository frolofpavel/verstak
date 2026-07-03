import { describe, it, expect } from 'vitest'
import { renderRecipeProtocol, applyRecipeToSkillPrompt } from '../../electron/ai/skills/recipe'
import type { RecipeSpec } from '../../electron/ai/skills/types'

const base: RecipeSpec = {
  id: 'typescript-error',
  kind: 'coding',
  trigger: ['tsc'],
  read_set: ['tsconfig*.json', '**/*.ts'],
  steps: ['inspect_error', 'apply_patch', 'run_verify', 'summarize'],
  verify: { commands: ['npm run type'] },
  reviewer: { required: false },
  stop: ['typecheck_green', 'no_unrelated_changes'],
}

describe('renderRecipeProtocol (Этап 4, Блок C)', () => {
  it('содержит id, шаги по порядку, read_set, verify, stop', () => {
    const out = renderRecipeProtocol(base)
    expect(out).toContain('recipe: typescript-error')
    // шаги пронумерованы по порядку
    expect(out).toMatch(/1\. .*ошибк/i)
    expect(out.indexOf('1.')).toBeLessThan(out.indexOf('2.'))
    expect(out).toContain('tsconfig*.json')
    expect(out).toContain('`npm run type`')
    expect(out).toContain('typecheck_green')
    expect(out).toContain('baseline')
  })

  it('reviewer.required=false → нет упоминания review_before_commit', () => {
    expect(renderRecipeProtocol(base)).not.toContain('review_before_commit')
  })

  it('reviewer.required=true → жёсткий gate с review_before_commit и confidence 0.7', () => {
    const out = renderRecipeProtocol({ ...base, reviewer: { required: true } })
    expect(out).toContain('review_before_commit')
    expect(out).toContain('0.7')
    expect(out).toMatch(/fail-closed/i)
  })

  it('пустой read_set → общая инструкция без globs', () => {
    const out = renderRecipeProtocol({ ...base, read_set: [] })
    expect(out).toContain('только файлы, прямо относящиеся к задаче')
  })

  it('profile (forward-compat) перекрывает и дополняет compensation', () => {
    const out = renderRecipeProtocol(
      { ...base, compensation: { knownIssues: ['ломает generics'] } },
      { editStrategy: 'whole-file', knownIssues: ['слабый JSON'] },
    )
    expect(out).toContain('whole-file')
    expect(out).toContain('ломает generics')
    expect(out).toContain('слабый JSON')
  })
})

describe('applyRecipeToSkillPrompt (инъекция в skill-промпт)', () => {
  it('нет recipe → возвращает исходный промпт как есть', () => {
    expect(applyRecipeToSkillPrompt('SKILL BODY', undefined)).toBe('SKILL BODY')
    expect(applyRecipeToSkillPrompt(null, undefined)).toBeNull()
    expect(applyRecipeToSkillPrompt(undefined, undefined)).toBeUndefined()
  })

  it('есть recipe → протокол дописан к skill-промпту (provider получит его в system prompt)', () => {
    const out = applyRecipeToSkillPrompt('SKILL BODY', base)
    expect(out).toContain('SKILL BODY')
    expect(out).toContain('recipe: typescript-error')
    // порядок: сначала тело скилла, потом протокол
    expect((out as string).indexOf('SKILL BODY')).toBeLessThan((out as string).indexOf('recipe: typescript-error'))
  })

  it('recipe без skill-промпта → возвращает только протокол', () => {
    const out = applyRecipeToSkillPrompt(null, base)
    expect(out).toContain('recipe: typescript-error')
  })
})
