import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-expect-error Eval report builder is an executable JavaScript module.
import { buildArenaSummary } from '../../scripts/eval/arena-report.mjs'

const ARENA = resolve(__dirname, '../../scripts/eval/arena.mjs')
const PACKAGE = resolve(__dirname, '../../package.json')

// Ревизия ambient-лимитов, добор 28.07. Кейс запускает ДОЧЕРНИЙ node
// (spawnSync scripts/eval/arena.mjs), и прежний бюджет 20_000 совпадал с
// глобальным testTimeout — то есть запаса над самим собой у него не было.
// Измерено: соло 3.3 с (два прогона подряд), под полным параллельным прогоном
// 9.6 с в лучшем наблюдении, а 28.07 кейс упёрся в 20 с и упал. Класс тот же,
// что лечили в 2fe6c2c (verstak-cli) и 136eba9: дочерний процесс под
// конкуренцией за CPU и диск. Логика теста не тронута — только бюджет, и он
// именованный, чтобы следующий не гадал, на что он выдан.
const ARENA_DRY_RUN_TIMEOUT_MS = 90_000

describe('Model Gym Arena', () => {
  it('exposes a reproducible dry-run command and keeps competitors separate', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8'))
    expect(pkg.scripts['eval:arena']).toBe('node scripts/eval/arena.mjs')

    const dir = mkdtempSync(join(tmpdir(), 'verstak-arena-test-'))
    try {
      const result = spawnSync(
        'node',
        [
          ARENA,
          '--dry-run',
          '--runners',
          'verstak,codex,opencode',
          '--models',
          'same/model',
          '--tasks',
          'small-edit',
          '--repeat',
          '3',
          '--run-date',
          '2026-07-25T00:00:00.000Z',
          '--out',
          join(dir, 'arena.md'),
          '--json-out',
          join(dir, 'arena.json'),
        ],
        { encoding: 'utf8', timeout: 60_000 },
      )
      expect(result.status).toBe(0)
      const report = JSON.parse(readFileSync(join(dir, 'arena.json'), 'utf8'))
      expect(report.meta).toMatchObject({
        arenaVersion: 'model-gym-arena-v1',
        repeat: 3,
        models: ['same/model'],
        runners: ['verstak', 'codex', 'opencode'],
      })
      expect(report.rows).toHaveLength(9)
      expect(new Set(report.rows.map((row: { runnerId: string }) => row.runnerId))).toEqual(
        new Set(['verstak', 'codex', 'opencode']),
      )
      expect(report.rows.every((row: { result: string; comparable: boolean }) => row.result === 'dry-run' && row.comparable)).toBe(true)
      expect(report.summary.every((item: { productionRecommendationEligible: boolean }) => !item.productionRecommendationEligible)).toBe(true)
      expect(readFileSync(join(dir, 'arena.md'), 'utf8')).toContain('Несопоставимые запуски не ранжируются')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, ARENA_DRY_RUN_TIMEOUT_MS)

  it('requires three repeats and full comparability before a production recommendation', () => {
    const rows = [
      row({ repeat: 1, comparable: true, result: 'pass', durationMs: 30 }),
      row({ repeat: 2, comparable: false, result: 'not comparable', durationMs: 10 }),
    ]
    const [summary] = buildArenaSummary(rows, 2)
    expect(summary.passRate).toBe(1)
    expect(summary.medianDurationMs).toBe(30)
    expect(summary.comparable).toBe(false)
    expect(summary.productionRecommendationEligible).toBe(false)
  })

  it('requires executed rows, not only a repeat count from dry-run', () => {
    const dryRows = [1, 2, 3].map(repeat => row({
      repeat,
      comparable: true,
      result: 'dry-run',
      verifyPass: false,
    }))
    const liveRows = [1, 2, 3].map(repeat => row({
      repeat,
      comparable: true,
      result: 'pass',
      verifyPass: true,
    }))

    expect(buildArenaSummary(dryRows, 3)[0].productionRecommendationEligible).toBe(false)
    expect(buildArenaSummary(liveRows, 3)[0].productionRecommendationEligible).toBe(true)
  })
})

function row(overrides: Record<string, unknown>) {
  return {
    runnerId: 'codex',
    runnerLabel: 'Codex CLI',
    runnerVersion: 'codex 1',
    model: 'same/model',
    repeat: 1,
    result: 'pass',
    comparable: true,
    durationMs: 0,
    estimatedCost: null,
    interventions: 0,
    ...overrides,
  }
}
