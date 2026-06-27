import { describe, it, expect } from 'vitest'
import { parseRuleFile, matchGlob, selectActiveRules, type FileRule } from '../../electron/ai/file-rules'

// Tier-2 #6 — file-scoped правила: .verstak/rules/*.mdc с frontmatter globs/alwaysApply.
// Инжектятся в user-layer когда активный файл подходит под glob (+ alwaysApply всегда).
describe('parseRuleFile', () => {
  it('frontmatter (globs массивом) + тело', () => {
    const r = parseRuleFile('---\ndescription: Python\nglobs: ["**/*.py", "src/**"]\nalwaysApply: false\n---\nИспользуй type hints.')
    expect(r.description).toBe('Python')
    expect(r.globs).toEqual(['**/*.py', 'src/**'])
    expect(r.alwaysApply).toBe(false)
    expect(r.body).toBe('Используй type hints.')
  })
  it('globs строкой через запятую', () => {
    const r = parseRuleFile('---\nglobs: **/*.ts, **/*.tsx\n---\nстрого typed')
    expect(r.globs).toEqual(['**/*.ts', '**/*.tsx'])
  })
  it('alwaysApply: true', () => {
    expect(parseRuleFile('---\nalwaysApply: true\n---\nвсегда').alwaysApply).toBe(true)
  })
  it('без frontmatter → пустые globs, тело целиком', () => {
    const r = parseRuleFile('просто текст')
    expect(r.globs).toEqual([])
    expect(r.body).toBe('просто текст')
  })
})

describe('matchGlob', () => {
  it('**/*.py матчит на любой глубине, не .ts', () => {
    expect(matchGlob('**/*.py', 'src/a.py')).toBe(true)
    expect(matchGlob('**/*.py', 'a.py')).toBe(true)
    expect(matchGlob('**/*.py', 'src/deep/b.py')).toBe(true)
    expect(matchGlob('**/*.py', 'src/a.ts')).toBe(false)
  })
  it('src/** — только внутри src', () => {
    expect(matchGlob('src/**', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/**', 'src/a/b.ts')).toBe(true)
    expect(matchGlob('src/**', 'lib/a.ts')).toBe(false)
  })
  it('* не пересекает / (только сегмент)', () => {
    expect(matchGlob('*.py', 'a.py')).toBe(true)
    expect(matchGlob('*.py', 'src/a.py')).toBe(false)
  })
  it('src/**/*.tsx', () => {
    expect(matchGlob('src/**/*.tsx', 'src/a.tsx')).toBe(true)
    expect(matchGlob('src/**/*.tsx', 'src/x/y/b.tsx')).toBe(true)
    expect(matchGlob('src/**/*.tsx', 'src/a.ts')).toBe(false)
  })
  it('обратные слэши нормализуются', () => {
    expect(matchGlob('**/*.py', 'src\\a.py')).toBe(true)
  })
})

describe('selectActiveRules', () => {
  const rule = (globs: string[], alwaysApply: boolean, body: string): FileRule => ({ description: '', globs, alwaysApply, body })
  it('alwaysApply → всегда, даже без активных файлов', () => {
    const r = selectActiveRules([rule([], true, 'A')], [])
    expect(r.map(x => x.body)).toEqual(['A'])
  })
  it('glob-правило только при совпадении активного файла', () => {
    const rules = [rule(['**/*.py'], false, 'PY'), rule(['**/*.go'], false, 'GO')]
    expect(selectActiveRules(rules, ['src/app.py']).map(x => x.body)).toEqual(['PY'])
  })
  it('нет globs и не alwaysApply → неактивно', () => {
    expect(selectActiveRules([rule([], false, 'X')], ['a.py'])).toEqual([])
  })
})
