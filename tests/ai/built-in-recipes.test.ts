import { describe, it, expect } from 'vitest'
import { BUILT_IN_SKILLS } from '../../electron/ai/skills/built-in'
import { parseRecipe } from '../../electron/ai/skills/recipe'

/**
 * Этап 4, Блок B — 6 built-in coding recipes. Проверяем: все 6 присутствуют,
 * у каждого валидный recipe с обязательными полями, старые skills не потеряны.
 */
const EXPECTED = ['small-edit', 'typescript-error', 'bugfix', 'test-fix', 'refactor-safe', 'review-before-commit']

describe('built-in coding recipes (Этап 4)', () => {
  it('все 6 recipe-скиллов присутствуют', () => {
    for (const id of EXPECTED) {
      expect(BUILT_IN_SKILLS.some(s => s.id === id), `нет recipe-скилла ${id}`).toBe(true)
    }
  })

  it('у каждого recipe-скилла валидный recipe с обязательными полями', () => {
    for (const id of EXPECTED) {
      const skill = BUILT_IN_SKILLS.find(s => s.id === id)!
      expect(skill.recipe, `${id} без recipe`).toBeDefined()
      const r = skill.recipe!
      // структура валидна с точки зрения runtime-парсера (не только TS)
      expect(parseRecipe(r), `${id} recipe невалиден для parseRecipe`).toBeDefined()
      expect(r.trigger.length, `${id} без trigger`).toBeGreaterThan(0)
      expect(r.steps.length, `${id} без steps`).toBeGreaterThan(0)
      expect(r.stop.length, `${id} без stop`).toBeGreaterThan(0)
      expect(r.verify?.commands.length, `${id} без verify.commands`).toBeGreaterThan(0)
      expect(typeof r.reviewer?.required, `${id} без reviewer`).toBe('boolean')
    }
  })

  it('recipe-скиллы имеют built-in source и slash', () => {
    for (const id of EXPECTED) {
      const skill = BUILT_IN_SKILLS.find(s => s.id === id)!
      expect(skill.source).toBe('built-in')
      expect(skill.slash).toBe(id)
      expect(skill.systemPrompt.length).toBeGreaterThan(0)
    }
  })

  it('recipe требующие ревью помечены reviewer.required=true', () => {
    const requireReview = ['bugfix', 'refactor-safe', 'review-before-commit']
    for (const id of requireReview) {
      expect(BUILT_IN_SKILLS.find(s => s.id === id)!.recipe!.reviewer!.required).toBe(true)
    }
  })

  it('старые built-in skills не потеряны', () => {
    for (const id of ['code-review', 'ai-board', 'diagnose', 'tdd', 'client-run']) {
      expect(BUILT_IN_SKILLS.some(s => s.id === id), `потерян старый скилл ${id}`).toBe(true)
    }
  })

  it('нет дублей id среди built-in', () => {
    const ids = BUILT_IN_SKILLS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
