// Авто-предложение скилла по черновику сообщения — чистая логика (без React/IPC).
// Подбирает наиболее релевантный скилл к тому, что пользователь набирает, чтобы
// предложить его активацию (с явным апрувом — НЕ авто-включаем). Консервативно:
// ложное предложение раздражает сильнее, чем пропущенное.

import type { Skill } from '../types/api'

// Шумовые слова RU/EN, не несущие доменного сигнала.
const STOP = new Set([
  'для', 'что', 'как', 'это', 'при', 'без', 'про', 'мне', 'нужно', 'надо', 'есть', 'была', 'быть',
  'the', 'and', 'for', 'with', 'this', 'that', 'you', 'are', 'can', 'все', 'или', 'так', 'там',
])

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(t => !STOP.has(t))
}

/** Порог скоринга: ниже него предложение считается шумом и не показывается. */
export const SUGGEST_THRESHOLD = 3

/** Предвычисленные токены скилла. Строится один раз на список скиллов (мемо в UI),
 *  чтобы на КАЖДЫЙ keystroke не ре-токенизировать все скиллы (ревью perf). */
export interface SkillTokenIndex {
  skill: Skill
  promptTokens: Set<string>
  metaTokens: Set<string>
}

export function buildSkillIndex(skills: Skill[]): SkillTokenIndex[] {
  return skills.map(sk => ({
    skill: sk,
    promptTokens: new Set((sk.suggested_prompts ?? []).flatMap(tokenize)),
    metaTokens: new Set([...tokenize(sk.name ?? ''), ...tokenize(sk.description ?? '')]),
  }))
}

/** Скоринг черновика против готового индекса (на keystroke токенизируем только draft). */
export function suggestFromIndex(draft: string, index: SkillTokenIndex[], activeSkillId: string | null): Skill | null {
  const draftTokens = new Set(tokenize(draft))
  if (draftTokens.size === 0) return null

  let bestSkill: Skill | null = null
  let bestScore = 0
  for (const entry of index) {
    if (entry.skill.id === activeSkillId) continue
    let score = 0
    for (const t of draftTokens) {
      if (entry.promptTokens.has(t)) score += 2
      else if (entry.metaTokens.has(t)) score += 1
    }
    if (score > bestScore) { bestScore = score; bestSkill = entry.skill }
  }
  return bestScore >= SUGGEST_THRESHOLD ? bestSkill : null
}

/**
 * Наиболее релевантный скилл к черновику или null. Скоринг по пересечению токенов:
 * suggested_prompts (вес 2) + name/description (вес 1). Активный скилл исключён.
 * Удобная обёртка (строит индекс + скорит) — для разовых вызовов и тестов.
 */
export function suggestSkill(draft: string, skills: Skill[], activeSkillId: string | null): Skill | null {
  return suggestFromIndex(draft, buildSkillIndex(skills), activeSkillId)
}
