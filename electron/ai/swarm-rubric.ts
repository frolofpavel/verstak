export interface SwarmVariantInput {
  id: string
  result: string
}

export interface SwarmVariantScore {
  id: string
  coverage: number
  verification: number
  scopeCompliance: number
  diffQuality: number
  riskRollback: number
  confidence: number
  total: number
  objections: string[]
}

export interface SwarmRubricDecision {
  scores: SwarmVariantScore[]
  recommendedId: string | null
  needsUserDecision: boolean
  reason: string
}

function contains(text: string, pattern: RegExp): boolean {
  return pattern.test(text.toLowerCase())
}

export function scoreSwarmVariant(variant: SwarmVariantInput): SwarmVariantScore {
  const text = variant.result
  const diffLines = (text.match(/^[+-](?![+-])/gm) ?? []).length
  const objections: string[] = []
  const coverage = contains(text, /(сделал|результат|implemented|готово)/) ? 2 : 1
  const verification = contains(text, /(pass|green|провер|тест|type-check|lint)/) ? 2 : 0
  const scopeCompliance = contains(text, /(out.of.scope|вне.*scope|unrelated)/) ? 0 : 2
  const diffQuality = diffLines === 0 ? 1 : diffLines <= 500 ? 2 : 0
  const riskRollback = contains(text, /(rollback|откат|риск|risk)/) ? 2 : 1
  if (scopeCompliance === 0) objections.push('Есть признак изменения вне write scope.')
  if (diffQuality === 0) objections.push('Слишком большой diff для автоматического выбора.')
  if (verification === 0) objections.push('Нет подтверждённой проверки результата.')
  const total = coverage + verification + scopeCompliance + diffQuality + riskRollback
  const confidence = Math.max(0, Math.min(1, total / 10))
  return { id: variant.id, coverage, verification, scopeCompliance, diffQuality, riskRollback, confidence, total, objections }
}

export function decideSwarmRubric(variants: SwarmVariantInput[]): SwarmRubricDecision {
  const scores = variants.map(scoreSwarmVariant).sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))
  if (scores.length === 0) return { scores, recommendedId: null, needsUserDecision: true, reason: 'Нет вариантов для выбора.' }
  const top = scores[0]
  const tie = scores.length > 1 && scores[1].total === top.total
  const risky = top.scopeCompliance === 0 || top.diffQuality === 0
  const lowConfidence = top.confidence < 0.7
  const needsUserDecision = tie || risky || lowConfidence
  return {
    scores,
    recommendedId: needsUserDecision ? null : top.id,
    needsUserDecision,
    reason: tie
      ? 'Ничья по rubric.'
      : risky
        ? 'Лучший вариант имеет высокий риск или нарушение scope.'
        : lowConfidence
          ? 'Недостаточно доказательств для уверенного выбора.'
          : `Рекомендован ${top.id}: лучший подтверждённый score.`,
  }
}
