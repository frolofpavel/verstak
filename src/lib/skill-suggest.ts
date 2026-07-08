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

type SkillDomain =
  | 'client-marketing'
  | 'client-account'
  | 'wordstat'
  | 'metrika'
  | 'direct-search-minusation'
  | 'direct-rsya-sites-minusation'
  | 'direct-semantics'
  | 'direct-cross-minusation'
  | 'metrika-conversions-audit'
  | 'direct-campaign-setup'
  | 'client-weekly-report'
  | null

/** Предвычисленные токены скилла. Строится один раз на список скиллов (мемо в UI),
 *  чтобы на КАЖДЫЙ keystroke не ре-токенизировать все скиллы (ревью perf). */
export interface SkillTokenIndex {
  skill: Skill
  promptTokens: Set<string>
  metaTokens: Set<string>
  autoSuggestable: boolean
  domain: SkillDomain
}

interface ScoredSkillSuggestion {
  entry: SkillTokenIndex
  score: number
}

const BLOCKED_SKILL_IDS = new Set([
  'verstak-guide',
  'client-run',
])

function isAutoSuggestableSkill(skill: Skill): boolean {
  if (BLOCKED_SKILL_IDS.has(skill.id)) return false
  const name = (skill.name ?? '').toLowerCase()
  const description = (skill.description ?? '').toLowerCase()
  if (name.includes('справка') || name.includes('ночная смена')) return false
  if (description.includes('интерфейс') && description.includes('verstak')) return false
  return true
}

function skillDomain(skill: Skill): SkillDomain {
  const id = skill.id.toLowerCase()
  const slash = (skill.slash ?? '').toLowerCase()
  const name = (skill.name ?? '').toLowerCase()
  const description = (skill.description ?? '').toLowerCase()
  if (id === 'direct-search-minusation' || slash === 'direct-search-minusation') return 'direct-search-minusation'
  if (id === 'direct-rsya-sites-minusation' || slash === 'direct-rsya-sites-minusation') return 'direct-rsya-sites-minusation'
  if (id === 'direct-semantics' || slash === 'direct-semantics') return 'direct-semantics'
  if (id === 'direct-cross-minusation' || slash === 'direct-cross-minusation') return 'direct-cross-minusation'
  if (id === 'metrika-conversions-audit' || slash === 'metrika-conversions-audit') return 'metrika-conversions-audit'
  if (id === 'direct-campaign-setup' || slash === 'direct-campaign-setup') return 'direct-campaign-setup'
  if (id === 'client-weekly-report' || slash === 'client-weekly-report') return 'client-weekly-report'
  if (id.includes('wordstat') || slash.includes('wordstat') || name.includes('wordstat') || description.includes('вордстат')) return 'wordstat'
  if (id.includes('metrika') || slash.includes('metrika') || name.includes('метрика') || description.includes('метрик')) return 'metrika'
  if (id === 'client-mkt' || slash === 'client-mkt') return 'client-marketing'
  if (
    description.includes('директ') ||
    description.includes('яндекс') ||
    description.includes('реклам') ||
    description.includes('аккаунт') ||
    name === id
  ) {
    return 'client-account'
  }
  return null
}

function hasAnyNeedle(haystack: string, needles: readonly string[]): boolean {
  return needles.some(needle => haystack.includes(needle))
}

function marketingIntentScore(draft: string, draftTokens: Set<string>): number {
  const text = draft.toLowerCase()
  let score = 0
  if (hasAnyNeedle(text, ['рк', 'рекламн', 'кампани', 'директ', 'яндекс директ'])) score += 1
  if (hasAnyNeedle(text, ['минусац', 'минусова', 'проминус', 'отминус', 'мусорн'])) score += 2
  if (hasAnyNeedle(text, ['поисков', 'поиск', 'запрос'])) score += 1
  if (hasAnyNeedle(text, ['рся', 'площад'])) score += 1
  if (hasAnyNeedle(text, ['семантик', 'ключев', 'ключи', 'wordstat', 'вордстат'])) score += 1
  if (draftTokens.has('вт') || hasAnyNeedle(text, ['темати'])) score += 1
  return score
}

function wordstatIntentScore(draft: string): number {
  const text = draft.toLowerCase()
  let score = 0
  if (hasAnyNeedle(text, ['вордстат', 'wordstat', 'toprequests', 'dynamics'])) score += 6
  if (hasAnyNeedle(text, ['частотност', 'частота'])) score += 4
  if (hasAnyNeedle(text, ['семантик', 'семантическ'])) score += 4
  if (hasAnyNeedle(text, ['подбор фраз', 'подобрать фраз', 'собрать фраз'])) score += 3
  if (hasAnyNeedle(text, ['ключев', 'ключи', 'ключевик'])) score += 2
  if (hasAnyNeedle(text, ['seo', 'директ'])) score += 1
  return score
}

function hasExplicitWordstatIntent(draft: string): boolean {
  const text = draft.toLowerCase()
  return hasAnyNeedle(text, ['вордстат', 'wordstat', 'toprequests', 'dynamics', 'частотност', 'частота'])
}

function metrikaIntentScore(draft: string): number {
  const text = draft.toLowerCase()
  let score = 0
  if (hasAnyNeedle(text, ['метрик', 'metrika', 'ym:s:', 'stat/v1/data', 'apisegment'])) score += 6
  if (hasAnyNeedle(text, ['счётчик', 'счетчик', 'цель', 'цели', 'конверс'])) score += 3
  if (hasAnyNeedle(text, ['сегмент', 'аудитори', 'ретаргет'])) score += 3
  if (hasAnyNeedle(text, ['визит', 'хит', 'logs api', 'лог', 'отчёт', 'отчет'])) score += 2
  if (hasAnyNeedle(text, ['расход', 'crm', 'офлайн'])) score += 1
  return score
}

function operationIntentScore(domain: SkillDomain, draft: string): number {
  const text = draft.toLowerCase()
  let score = 0
  switch (domain) {
    case 'direct-search-minusation':
      if (hasAnyNeedle(text, ['проминус', 'минусац', 'минусова', 'мусорн'])) score += 3
      if (hasAnyNeedle(text, ['поисков', 'поиск', 'запрос', 'фраз'])) score += 4
      if (hasAnyNeedle(text, ['отчёт поисков', 'отчет поисков'])) score += 3
      if (hasAnyNeedle(text, ['рк', 'директ', 'кампани'])) score += 1
      break
    case 'direct-rsya-sites-minusation':
      if (hasAnyNeedle(text, ['рся', 'сетях', 'сети'])) score += 4
      if (hasAnyNeedle(text, ['площад', 'сайт', 'прилож', 'источник'])) score += 4
      if (hasAnyNeedle(text, ['минусац', 'мусорн', 'отключ', 'исключ'])) score += 2
      if (hasAnyNeedle(text, ['расход', 'конверс', 'заявк'])) score += 1
      break
    case 'direct-semantics':
      if (hasAnyNeedle(text, ['семантик', 'семантическ', 'ядро'])) score += 6
      if (hasAnyNeedle(text, ['ключев', 'ключи', 'ключевик', 'фраз'])) score += 3
      if (hasAnyNeedle(text, ['собрать', 'расшир', 'подобрать', 'кластер'])) score += 2
      if (hasAnyNeedle(text, ['директ', 'рк', 'кампани'])) score += 1
      break
    case 'direct-cross-minusation':
      if (hasAnyNeedle(text, ['кросс', 'пересеч', 'конкурир', 'конфликт'])) score += 6
      if (hasAnyNeedle(text, ['минусац', 'минус', 'ключев', 'фраз'])) score += 3
      break
    case 'metrika-conversions-audit':
      if (hasAnyNeedle(text, ['аудит', 'провер']) && hasAnyNeedle(text, ['рк', 'кампани', 'директ'])) score += 6
      if (hasAnyNeedle(text, ['недел', 'период', 'месяц'])) score += 2
      if (hasAnyNeedle(text, ['метрик', 'metrika', 'счётчик', 'счетчик'])) score += 4
      if (hasAnyNeedle(text, ['конверс', 'цель', 'цели', 'заявк'])) score += 5
      if (hasAnyNeedle(text, ['расход', 'нет заяв', 'без конверс', 'качество траф'])) score += 2
      break
    case 'direct-campaign-setup':
      if (hasAnyNeedle(text, ['настро', 'созда', 'запуст', 'перенес', 'скопир', 'исправ'])) score += 3
      if (hasAnyNeedle(text, ['рк', 'кампани', 'директ', 'объявлен', 'групп', 'поиск', 'поиске', 'рся'])) score += 4
      if (hasAnyNeedle(text, ['ссылк', 'быстр', 'utm', 'уточнен', 'посадоч'])) score += 3
      break
    case 'client-weekly-report':
      if (hasAnyNeedle(text, ['отчёт', 'отчет', 'сводк', 'что было сделано'])) score += 5
      if (hasAnyNeedle(text, ['недел', 'период', 'клиент', 'руководител'])) score += 3
      break
    default:
      break
  }
  return score
}

function isOperationDomain(domain: SkillDomain): boolean {
  return domain === 'direct-search-minusation' ||
    domain === 'direct-rsya-sites-minusation' ||
    domain === 'direct-semantics' ||
    domain === 'direct-cross-minusation' ||
    domain === 'metrika-conversions-audit' ||
    domain === 'direct-campaign-setup' ||
    domain === 'client-weekly-report'
}

function clientAccountIntentScore(skill: Skill, draft: string): number {
  const text = draft.toLowerCase()
  const ids = [skill.id, skill.slash, skill.name]
    .filter((value): value is string => Boolean(value))
    .map(value => value.toLowerCase())
  if (ids.some(value => value && text.includes(value))) return 3

  const description = (skill.description ?? '').toLowerCase()
  const aliases = new Set<string>()
  for (const token of tokenize(description)) {
    if (/^[a-z0-9-]{4,}$/.test(token)) aliases.add(token)
  }
  if (description.includes('пабг')) aliases.add('пабг')
  if (description.includes('стим')) aliases.add('стим')
  for (const alias of aliases) {
    if (text.includes(alias)) return 3
  }
  return 0
}

function scoreSkillEntry(
  entry: SkillTokenIndex,
  draft: string,
  draftTokens: Set<string>,
  marketingScore: number,
  wordstatScore: number,
  metrikaScore: number
): number {
  let score = 0
  for (const t of draftTokens) {
    if (entry.promptTokens.has(t)) score += 2
    else if (entry.metaTokens.has(t)) score += 1
  }
  const operationScore = operationIntentScore(entry.domain, draft)
  if (operationScore >= 3) score += operationScore + 8
  if (entry.domain === 'wordstat' && wordstatScore >= 3 && hasExplicitWordstatIntent(draft)) score += wordstatScore + 6
  if (entry.domain === 'metrika' && metrikaScore >= 3) score += metrikaScore + 6
  if (entry.domain === 'client-marketing' && marketingScore >= 3) score += marketingScore
  if (entry.domain === 'client-account' && marketingScore >= 2) score += clientAccountIntentScore(entry.skill, draft)
  return score
}

export function buildSkillIndex(skills: Skill[]): SkillTokenIndex[] {
  return skills.map(sk => ({
    skill: sk,
    promptTokens: new Set((sk.suggested_prompts ?? []).flatMap(tokenize)),
    metaTokens: new Set([...tokenize(sk.name ?? ''), ...tokenize(sk.description ?? '')]),
    autoSuggestable: isAutoSuggestableSkill(sk),
    domain: skillDomain(sk),
  }))
}

/** Скоринг черновика против готового индекса (на keystroke токенизируем только draft). */
export function suggestFromIndex(
  draft: string,
  index: SkillTokenIndex[],
  activeSkillId: string | null,
  excludedSkillIds: ReadonlySet<string> = new Set()
): Skill | null {
  return suggestManyFromIndex(draft, index, activeSkillId, excludedSkillIds, 1)[0] ?? null
}

export function suggestManyFromIndex(
  draft: string,
  index: SkillTokenIndex[],
  activeSkillId: string | null,
  excludedSkillIds: ReadonlySet<string> = new Set(),
  limit = 4
): Skill[] {
  const draftTokens = new Set(tokenize(draft))
  if (draftTokens.size === 0) return []
  const marketingScore = marketingIntentScore(draft, draftTokens)
  const wordstatScore = wordstatIntentScore(draft)
  const metrikaScore = metrikaIntentScore(draft)

  const scored: ScoredSkillSuggestion[] = []
  for (const entry of index) {
    if (!entry.autoSuggestable) continue
    if (entry.skill.id === activeSkillId) continue
    if (excludedSkillIds.has(entry.skill.id)) continue
    const score = scoreSkillEntry(entry, draft, draftTokens, marketingScore, wordstatScore, metrikaScore)
    if (score >= SUGGEST_THRESHOLD) scored.push({ entry, score })
  }
  const hasOperationSuggestion = scored.some(item => isOperationDomain(item.entry.domain))
  return scored
    .filter(item => !(hasOperationSuggestion && item.entry.domain === 'client-marketing'))
    .sort((a, b) => b.score - a.score || a.entry.skill.id.localeCompare(b.entry.skill.id))
    .slice(0, Math.max(1, limit))
    .map(item => item.entry.skill)
}

/**
 * Наиболее релевантный скилл к черновику или null. Скоринг по пересечению токенов:
 * suggested_prompts (вес 2) + name/description (вес 1). Активный скилл исключён.
 * Удобная обёртка (строит индекс + скорит) — для разовых вызовов и тестов.
 */
export function suggestSkill(draft: string, skills: Skill[], activeSkillId: string | null): Skill | null {
  return suggestFromIndex(draft, buildSkillIndex(skills), activeSkillId)
}

export function suggestSkills(draft: string, skills: Skill[], activeSkillId: string | null, limit = 4): Skill[] {
  return suggestManyFromIndex(draft, buildSkillIndex(skills), activeSkillId, new Set(), limit)
}
