export type OutcomeRisk = 'low' | 'medium' | 'high'
export type PlanningMode = 'quick' | 'controlled' | 'deep'
export type EvidenceKind = 'command' | 'diff' | 'screenshot' | 'manual'

export interface TaskSuccessCriterionV1 {
  id: string
  text: string
  evidence: EvidenceKind
  verify?: string
}

export interface TaskAssumptionV1 {
  text: string
  status: 'confirmed' | 'unconfirmed' | 'invalidated'
}

export interface RepoEvidenceV1 {
  path: string
  symbol?: string
  why: string
}

export interface TaskContractV1 {
  schemaVersion: 1
  revision: number
  rawRequest: string
  goal: string
  successCriteria: TaskSuccessCriterionV1[]
  constraints: string[]
  nonGoals: string[]
  assumptions: TaskAssumptionV1[]
  blockingQuestions: string[]
  repoEvidence: RepoEvidenceV1[]
  risk: OutcomeRisk
  planningMode: PlanningMode
}

export type PlanRole = 'researcher' | 'executor' | 'verifier' | 'critic' | 'planner'
export type PlanExecution = 'main' | 'delegate' | 'parallel-candidate'

export interface PlanStepSpecV1 {
  key: string
  title: string
  intent: string
  files: string[]
  symbols: string[]
  actions: string[]
  dependsOn: string[]
  readScope: string[]
  writeScope: string[]
  acceptanceCriterionIds: string[]
  verification: string[]
  expectedEvidence: string[]
  rollback: string
  role: PlanRole
  execution: PlanExecution
  risk: OutcomeRisk
}

export interface PlanQualityV1 {
  score: number
  status: 'pass' | 'revise' | 'block'
  hardErrors: string[]
  warnings: string[]
  checkedAt: number
}

export type OutcomeContractErrorCode =
  | 'invalid-json'
  | 'invalid-shape'
  | 'invalid-schema-version'
  | 'invalid-revision'
  | 'missing-field'
  | 'invalid-enum'
  | 'duplicate-id'

export interface OutcomeDiagnostic {
  code: OutcomeContractErrorCode
  path: string
  message: string
}

export interface ParseOutcome<T> {
  value: T | null
  diagnostics: OutcomeDiagnostic[]
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(record: UnknownRecord, key: string, diagnostics: OutcomeDiagnostic[], path = key): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) {
    diagnostics.push({ code: 'missing-field', path, message: `${path}: требуется непустая строка` })
    return ''
  }
  return value.trim()
}

function stringArray(record: UnknownRecord, key: string, diagnostics: OutcomeDiagnostic[]): string[] {
  const value = record[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    diagnostics.push({ code: 'invalid-shape', path: key, message: `${key}: требуется массив строк` })
    return []
  }
  return value.map(item => item.trim()).filter(Boolean)
}

function enumValue<T extends string>(
  record: UnknownRecord,
  key: string,
  allowed: readonly T[],
  diagnostics: OutcomeDiagnostic[],
): T {
  const value = record[key]
  if (typeof value === 'string' && allowed.includes(value as T)) return value as T
  diagnostics.push({ code: 'invalid-enum', path: key, message: `${key}: допустимо ${allowed.join(', ')}` })
  return allowed[0]
}

export function parseTaskContract(input: unknown): ParseOutcome<TaskContractV1> {
  const diagnostics: OutcomeDiagnostic[] = []
  if (!isRecord(input)) {
    return { value: null, diagnostics: [{ code: 'invalid-shape', path: '$', message: 'Task Contract должен быть объектом' }] }
  }
  if (input.schemaVersion !== 1) {
    diagnostics.push({ code: 'invalid-schema-version', path: 'schemaVersion', message: 'Поддерживается schemaVersion=1' })
  }
  if (!Number.isInteger(input.revision) || Number(input.revision) < 1) {
    diagnostics.push({ code: 'invalid-revision', path: 'revision', message: 'revision должен быть целым числом >= 1' })
  }

  const successCriteria: TaskSuccessCriterionV1[] = []
  if (!Array.isArray(input.successCriteria) || input.successCriteria.length === 0) {
    diagnostics.push({ code: 'missing-field', path: 'successCriteria', message: 'Нужен хотя бы один критерий готовности' })
  } else {
    const ids = new Set<string>()
    input.successCriteria.forEach((raw, index) => {
      if (!isRecord(raw)) {
        diagnostics.push({ code: 'invalid-shape', path: `successCriteria.${index}`, message: 'Критерий должен быть объектом' })
        return
      }
      const local: OutcomeDiagnostic[] = []
      const id = stringValue(raw, 'id', local, `successCriteria.${index}.id`)
      const text = stringValue(raw, 'text', local, `successCriteria.${index}.text`)
      const evidence = enumValue(raw, 'evidence', ['command', 'diff', 'screenshot', 'manual'] as const, local)
      if (id && ids.has(id)) local.push({ code: 'duplicate-id', path: `successCriteria.${index}.id`, message: `Повтор id ${id}` })
      if (id) ids.add(id)
      diagnostics.push(...local)
      successCriteria.push({ id, text, evidence, ...(typeof raw.verify === 'string' && raw.verify.trim() ? { verify: raw.verify.trim() } : {}) })
    })
  }

  const assumptions: TaskAssumptionV1[] = []
  if (!Array.isArray(input.assumptions)) {
    diagnostics.push({ code: 'invalid-shape', path: 'assumptions', message: 'assumptions: требуется массив' })
  } else {
    input.assumptions.forEach((raw, index) => {
      if (!isRecord(raw)) {
        diagnostics.push({ code: 'invalid-shape', path: `assumptions.${index}`, message: 'Допущение должно быть объектом' })
        return
      }
      const local: OutcomeDiagnostic[] = []
      const text = stringValue(raw, 'text', local, `assumptions.${index}.text`)
      const status = enumValue(raw, 'status', ['confirmed', 'unconfirmed', 'invalidated'] as const, local)
      diagnostics.push(...local)
      assumptions.push({ text, status })
    })
  }

  const repoEvidence: RepoEvidenceV1[] = []
  if (!Array.isArray(input.repoEvidence)) {
    diagnostics.push({ code: 'invalid-shape', path: 'repoEvidence', message: 'repoEvidence: требуется массив' })
  } else {
    input.repoEvidence.forEach((raw, index) => {
      if (!isRecord(raw)) {
        diagnostics.push({ code: 'invalid-shape', path: `repoEvidence.${index}`, message: 'Evidence должен быть объектом' })
        return
      }
      const local: OutcomeDiagnostic[] = []
      const path = stringValue(raw, 'path', local, `repoEvidence.${index}.path`)
      const why = stringValue(raw, 'why', local, `repoEvidence.${index}.why`)
      diagnostics.push(...local)
      repoEvidence.push({ path, why, ...(typeof raw.symbol === 'string' && raw.symbol.trim() ? { symbol: raw.symbol.trim() } : {}) })
    })
  }

  const value: TaskContractV1 = {
    schemaVersion: 1,
    revision: Number(input.revision) || 0,
    rawRequest: stringValue(input, 'rawRequest', diagnostics),
    goal: stringValue(input, 'goal', diagnostics),
    successCriteria,
    constraints: stringArray(input, 'constraints', diagnostics),
    nonGoals: stringArray(input, 'nonGoals', diagnostics),
    assumptions,
    blockingQuestions: stringArray(input, 'blockingQuestions', diagnostics),
    repoEvidence,
    risk: enumValue(input, 'risk', ['low', 'medium', 'high'] as const, diagnostics),
    planningMode: enumValue(input, 'planningMode', ['quick', 'controlled', 'deep'] as const, diagnostics),
  }
  return { value: diagnostics.length === 0 ? value : null, diagnostics }
}

export function parseTaskContractJson(json: string | null | undefined): ParseOutcome<TaskContractV1> {
  if (!json) return { value: null, diagnostics: [] }
  try {
    return parseTaskContract(JSON.parse(json))
  } catch {
    return { value: null, diagnostics: [{ code: 'invalid-json', path: '$', message: 'Task Contract содержит невалидный JSON' }] }
  }
}

export function parsePlanStepSpec(input: unknown): ParseOutcome<PlanStepSpecV1> {
  if (!isRecord(input)) {
    return { value: null, diagnostics: [{ code: 'invalid-shape', path: '$', message: 'Plan step spec должен быть объектом' }] }
  }
  const diagnostics: OutcomeDiagnostic[] = []
  const value: PlanStepSpecV1 = {
    key: stringValue(input, 'key', diagnostics),
    title: stringValue(input, 'title', diagnostics),
    intent: stringValue(input, 'intent', diagnostics),
    files: stringArray(input, 'files', diagnostics),
    symbols: stringArray(input, 'symbols', diagnostics),
    actions: stringArray(input, 'actions', diagnostics),
    dependsOn: stringArray(input, 'dependsOn', diagnostics),
    readScope: stringArray(input, 'readScope', diagnostics),
    writeScope: stringArray(input, 'writeScope', diagnostics),
    acceptanceCriterionIds: stringArray(input, 'acceptanceCriterionIds', diagnostics),
    verification: stringArray(input, 'verification', diagnostics),
    expectedEvidence: stringArray(input, 'expectedEvidence', diagnostics),
    rollback: typeof input.rollback === 'string' ? input.rollback.trim() : '',
    role: enumValue(input, 'role', ['researcher', 'executor', 'verifier', 'critic', 'planner'] as const, diagnostics),
    execution: enumValue(input, 'execution', ['main', 'delegate', 'parallel-candidate'] as const, diagnostics),
    risk: enumValue(input, 'risk', ['low', 'medium', 'high'] as const, diagnostics),
  }
  return { value: diagnostics.length === 0 ? value : null, diagnostics }
}

export function parsePlanQualityJson(json: string | null | undefined): PlanQualityV1 | null {
  if (!json) return null
  try {
    const raw: unknown = JSON.parse(json)
    if (!isRecord(raw) || !Array.isArray(raw.hardErrors) || !Array.isArray(raw.warnings)) return null
    if (!['pass', 'revise', 'block'].includes(String(raw.status))) return null
    return {
      score: Number(raw.score),
      status: raw.status as PlanQualityV1['status'],
      hardErrors: raw.hardErrors.map(String),
      warnings: raw.warnings.map(String),
      checkedAt: Number(raw.checkedAt),
    }
  } catch {
    return null
  }
}
