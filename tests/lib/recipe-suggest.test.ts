import { describe, it, expect } from 'vitest'
import { suggestRecipe, hasExplicitRecipeIntent } from '../../src/lib/recipe-suggest'

/** Этап 4, Блок D — детерминированное предложение recipe по интенту. Все правила. */
describe('suggestRecipe (Этап 4)', () => {
  it('typescript-error: tsc / typescript / npm run type', () => {
    expect(suggestRecipe('tsc падает')).toBe('typescript-error')
    expect(suggestRecipe('ошибка TypeScript в модуле')).toBe('typescript-error')
    expect(suggestRecipe('npm run type выдаёт TS2339')).toBe('typescript-error')
  })

  it('test-fix: test failed / vitest / jest / npm test', () => {
    expect(suggestRecipe('test failed after change')).toBe('test-fix')
    expect(suggestRecipe('vitest красный')).toBe('test-fix')
    expect(suggestRecipe('jest suite broke')).toBe('test-fix')
    expect(suggestRecipe('npm test не проходит')).toBe('test-fix')
  })

  it('bugfix: bug / broken / не работает / ошибка', () => {
    expect(suggestRecipe('there is a bug in login')).toBe('bugfix')
    expect(suggestRecipe('feature is broken')).toBe('bugfix')
    expect(suggestRecipe('кнопка не работает')).toBe('bugfix')
    expect(suggestRecipe('какая-то ошибка при сохранении')).toBe('bugfix')
  })

  it('refactor-safe: refactor / cleanup / rename', () => {
    expect(suggestRecipe('refactor this module')).toBe('refactor-safe')
    expect(suggestRecipe('cleanup dead code')).toBe('refactor-safe')
    expect(suggestRecipe('rename the variable')).toBe('refactor-safe')
  })

  it('review-before-commit: review / commit / проверь перед коммитом', () => {
    expect(suggestRecipe('review my changes')).toBe('review-before-commit')
    expect(suggestRecipe('ready to commit')).toBe('review-before-commit')
    expect(suggestRecipe('проверь перед коммитом изменения')).toBe('review-before-commit')
  })

  it('иначе → small-edit', () => {
    expect(suggestRecipe('добавь параметр в функцию')).toBe('small-edit')
    expect(suggestRecipe('')).toBe('small-edit')
    expect(suggestRecipe('поменяй заголовок')).toBe('small-edit')
  })

  it('приоритет: typescript раньше test/bug (npm run type vs npm test)', () => {
    expect(suggestRecipe('npm run type: ошибка типов')).toBe('typescript-error')
  })

  it('hasExplicitRecipeIntent: true для явных, false для small-edit', () => {
    expect(hasExplicitRecipeIntent('tsc error')).toBe(true)
    expect(hasExplicitRecipeIntent('refactor module')).toBe(true)
    expect(hasExplicitRecipeIntent('добавь строку')).toBe(false)
    expect(hasExplicitRecipeIntent('')).toBe(false)
  })
})
