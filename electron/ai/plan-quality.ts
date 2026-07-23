import type {
  PlanQualityV1,
  PlanStepSpecV1,
  TaskContractV1,
} from '../../shared/contracts/outcome'

function overlaps(a: string[], b: string[]): string | null {
  const right = new Set(b.map(v => v.replace(/\\/g, '/').toLowerCase()))
  return a.find(v => right.has(v.replace(/\\/g, '/').toLowerCase())) ?? null
}

function hasCycle(steps: PlanStepSpecV1[]): boolean {
  const graph = new Map(steps.map(step => [step.key, step.dependsOn]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true
    if (visited.has(key)) return false
    visiting.add(key)
    for (const dep of graph.get(key) ?? []) {
      if (graph.has(dep) && visit(dep)) return true
    }
    visiting.delete(key)
    visited.add(key)
    return false
  }
  return steps.some(step => visit(step.key))
}

function isGeneric(step: PlanStepSpecV1): boolean {
  const text = `${step.title} ${step.intent} ${step.actions.join(' ')}`.toLowerCase()
  return step.intent.length < 24
    || /^(улучшить|оптимизировать|починить|доработать|рефакторить)\s+(модуль|код|проект|систему)?\.?$/i.test(step.intent.trim())
    || (!step.files.length && !step.symbols.length && !/[./\\]/.test(text))
}

export function scorePlanQuality(
  contract: TaskContractV1,
  steps: PlanStepSpecV1[],
  checkedAt = Date.now(),
): PlanQualityV1 {
  const hardErrors: string[] = []
  const warnings: string[] = []
  if (contract.blockingQuestions.length > 0) {
    hardErrors.push('Task Contract содержит нерешённые blocking questions')
  }
  if (steps.length === 0) hardErrors.push('План не содержит шагов')

  const keys = new Set<string>()
  const criterionIds = new Set(contract.successCriteria.map(item => item.id))
  for (const step of steps) {
    if (keys.has(step.key)) hardErrors.push(`Повтор ключа шага: ${step.key}`)
    keys.add(step.key)
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!keys.has(dep)) hardErrors.push(`${step.key}: неизвестная dependency ${dep}`)
    }
    if (step.actions.length > 0 && step.writeScope.length === 0 && step.role === 'executor') {
      hardErrors.push(`${step.key}: write-задача без writeScope`)
    }
    if (step.acceptanceCriterionIds.length === 0) {
      hardErrors.push(`${step.key}: не связан с критерием готовности`)
    }
    for (const criterionId of step.acceptanceCriterionIds) {
      if (!criterionIds.has(criterionId)) hardErrors.push(`${step.key}: неизвестный criterion ${criterionId}`)
    }
    if (step.expectedEvidence.length === 0) hardErrors.push(`${step.key}: не задан expectedEvidence`)
    if (step.risk === 'high' && (!step.rollback || step.verification.length === 0)) {
      hardErrors.push(`${step.key}: high-risk шаг требует rollback и verification`)
    }
    if (isGeneric(step)) hardErrors.push(`${step.key}: действие сформулировано слишком общо`)
    if (step.verification.length === 0) warnings.push(`${step.key}: нет команды или ручной проверки`)
  }
  if (hasCycle(steps)) hardErrors.push('Plan DAG содержит цикл')

  const parallel = steps.filter(step => step.execution === 'parallel-candidate' && step.writeScope.length > 0)
  for (let i = 0; i < parallel.length; i++) {
    for (let j = i + 1; j < parallel.length; j++) {
      const path = overlaps(parallel[i].writeScope, parallel[j].writeScope)
      if (path) hardErrors.push(`Параллельные writer-шаги ${parallel[i].key}/${parallel[j].key} пересекаются: ${path}`)
    }
  }

  const allFiles = [...new Set(steps.flatMap(step => step.files))]
  if (allFiles.length > 1 && contract.repoEvidence.length > 0) {
    const evidencePaths = new Set(contract.repoEvidence.map(item => item.path.replace(/\\/g, '/').toLowerCase()))
    if (!allFiles.some(path => evidencePaths.has(path.replace(/\\/g, '/').toLowerCase()))) {
      hardErrors.push('Multi-file план не связан с прочитанным repoEvidence')
    }
  } else if (allFiles.length > 1 && contract.repoEvidence.length === 0) {
    hardErrors.push('Multi-file план не содержит repoEvidence')
  }

  const covered = new Set(steps.flatMap(step => step.acceptanceCriterionIds))
  for (const criterion of contract.successCriteria) {
    if (!covered.has(criterion.id)) hardErrors.push(`Критерий ${criterion.id} не покрыт ни одним шагом`)
  }

  const score = Math.max(0, 100 - hardErrors.length * 15 - warnings.length * 5)
  return {
    score,
    status: hardErrors.length > 0 ? 'block' : warnings.length > 0 ? 'revise' : 'pass',
    hardErrors: [...new Set(hardErrors)],
    warnings: [...new Set(warnings)],
    checkedAt,
  }
}
