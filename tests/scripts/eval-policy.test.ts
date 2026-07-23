import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = resolve(__dirname, '../../scripts/eval/policy.mjs')
const ROLE_FIXTURES = [
  'task-refinement', 'plan-grounding', 'dependency-dag', 'assumption-invalidation',
  'small-edit', 'bugfix', 'typescript-error', 'test-fix', 'failed-verify-recovery',
  'review-before-commit', 'proof-completeness', 'high-risk-rollback',
  'unrelated-change-resistance', 'lsp-navigation', 'onec-read-only', 'bitrix24-read-only',
  'unknown-model-recovery', 'rate-limit-account-rotation', 'crash-resume',
  'secret-safety', 'scope-discipline',
]

function rows(model: string, result = 'pass') {
  return ROLE_FIXTURES.flatMap(fixtureId => [1, 2, 3].map(repeat => ({
    model,
    fixtureId,
    repeat,
    result,
    durationMs: model === 'fast-model' ? 100 : 200,
    estimatedCost: model === 'fast-model' ? 0.01 : 0.02,
    traceSecretLeak: false,
    unrelatedFilesTouched: false,
  })))
}

function runPolicy(payload: unknown, now = '2026-07-23T00:00:00.000Z') {
  const dir = mkdtempSync(join(tmpdir(), 'verstak-eval-policy-'))
  try {
    const input = join(dir, 'report.json')
    const out = join(dir, 'candidate.json')
    writeFileSync(input, JSON.stringify(payload), 'utf8')
    const run = spawnSync('node', [SCRIPT, '--input', input, '--out', out, '--now', now], { encoding: 'utf8' })
    return { run, candidate: run.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Model Gym policy candidate', () => {
  it('builds a candidate for six roles after 3 repeats and safety passes', () => {
    const { run, candidate } = runPolicy({
      meta: { runDate: '2026-07-22T00:00:00.000Z', verstakCommit: 'a'.repeat(40), repeat: 3 },
      rows: [...rows('steady-model'), ...rows('fast-model')],
    })
    expect(run.status).toBe(0)
    expect(candidate.status).toBe('candidate')
    expect(candidate.autoApplied).toBe(false)
    expect(Object.keys(candidate.roles)).toEqual(['planner', 'executor', 'reviewer', 'verifier', 'cheap-read', 'fallback'])
    expect(candidate.roles.executor.model).toBe('fast-model')
    expect(candidate.roles.executor.evidence.repeats).toBe(3)
  })

  it('does not promote stale results or fewer than 3 repeats', () => {
    const stale = runPolicy({
      meta: { runDate: '2026-01-01T00:00:00.000Z', verstakCommit: 'b'.repeat(40), repeat: 3 },
      rows: rows('model'),
    }).candidate
    expect(stale.status).toBe('insufficient')
    expect(stale.reasons).toContain('report is stale')

    const sparseRows = rows('model').filter(row => row.repeat < 3)
    const sparse = runPolicy({
      meta: { runDate: '2026-07-22T00:00:00.000Z', verstakCommit: 'c'.repeat(40), repeat: 2 },
      rows: sparseRows,
    }).candidate
    expect(sparse.status).toBe('insufficient')
    expect(sparse.reasons).toContain('minimum 3 repeats not met')
  })

  it('blocks every role when a safety fixture fails', () => {
    const unsafeRows = rows('model').map(row => row.fixtureId === 'secret-safety' ? { ...row, result: 'fail' } : row)
    const { candidate } = runPolicy({
      meta: { runDate: '2026-07-22T00:00:00.000Z', verstakCommit: 'd'.repeat(40), repeat: 3 },
      rows: unsafeRows,
    })
    expect(candidate.status).toBe('insufficient')
    expect(candidate.reasons).toContain('safety fixtures failed')
    expect(candidate.roles).toEqual({})
  })
})
