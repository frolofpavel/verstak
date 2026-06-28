import { describe, it, expect } from 'vitest'
import { suggestSkill, SUGGEST_THRESHOLD } from '../../src/lib/skill-suggest'
import type { Skill } from '../../src/types/api'

const mk = (over: Partial<Skill>): Skill => ({
  id: over.id ?? 'x',
  systemPrompt: '',
  source: 'user',
  sourceRef: '',
  ...over,
})

const REVIEW = mk({
  id: 'code-review',
  name: 'Code Review',
  description: 'Ревью кода: баги, безопасность, качество',
  suggested_prompts: ['проверь этот код на баги', 'сделай ревью безопасности'],
})
const GIT = mk({
  id: 'git-summary',
  name: 'Git Summary',
  description: 'Сводка изменений git',
  suggested_prompts: ['что изменилось в коммитах'],
})

describe('suggestSkill', () => {
  it('релевантный черновик → топ-скилл по пересечению токенов', () => {
    expect(suggestSkill('сделай ревью безопасности этого кода', [REVIEW, GIT], null)?.id).toBe('code-review')
  })

  it('пустой/короткий черновик → null', () => {
    expect(suggestSkill('', [REVIEW, GIT], null)).toBeNull()
    expect(suggestSkill('ок да', [REVIEW, GIT], null)).toBeNull() // <3 символов / стоп-слова
  })

  it('нерелевантный черновик ниже порога → null (не шумим)', () => {
    expect(suggestSkill('купи молоко завтра утром', [REVIEW, GIT], null)).toBeNull()
  })

  it('активный скилл исключён из кандидатов', () => {
    // тот же релевантный текст, но code-review уже активен → не предлагаем его снова
    expect(suggestSkill('сделай ревью безопасности кода', [REVIEW, GIT], 'code-review')).toBeNull()
  })

  it('suggested_prompts весомее meta (вес 2 vs 1)', () => {
    const a = mk({ id: 'a', name: 'баги', description: 'баги баги', suggested_prompts: [] })
    const b = mk({ id: 'b', name: 'x', description: 'y', suggested_prompts: ['баги тесты ревью'] })
    // 'баги тесты ревью' даёт 3 prompt-токена (вес 2) у b → перебивает a
    expect(suggestSkill('найди баги тесты ревью', [a, b], null)?.id).toBe('b')
  })

  it('порог экспортируется и равен 3', () => {
    expect(SUGGEST_THRESHOLD).toBe(3)
  })
})
