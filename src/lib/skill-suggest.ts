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

/**
 * Наиболее релевantный скилл к черновику или null. Скоринг по пересечению токенов:
 * suggested_prompts (вес 2 — самый сильный сигнал «для чего скилл») + name/description
 * (вес 1). Активный скилл и скиллы без сигнала исключены.
 */
export function suggestSkill(draft: string, skills: Skill[], activeSkillId: string | null): Skill | null {
  const draftTokens = new Set(tokenize(draft))
  if (draftTokens.size === 0) return null

  let bestSkill: Skill | null = null
  let bestScore = 0
  for (const sk of skills) {
    if (sk.id === activeSkillId) continue
    const promptTokens = new Set((sk.suggested_prompts ?? []).flatMap(tokenize))
    const metaTokens = new Set([...tokenize(sk.name ?? ''), ...tokenize(sk.description ?? '')])
    let score = 0
    for (const t of draftTokens) {
      if (promptTokens.has(t)) score += 2
      else if (metaTokens.has(t)) score += 1
    }
    if (score > bestScore) { bestScore = score; bestSkill = sk }
  }
  return bestScore >= SUGGEST_THRESHOLD ? bestSkill : null
}
