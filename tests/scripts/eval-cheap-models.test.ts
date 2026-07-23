import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = resolve(__dirname, '../../scripts/eval-cheap-models.mjs')

function runEval(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      VERSTAK_GATEWAY_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ...env,
    },
  })
}

describe('cheap model eval runner', () => {
  it('generates dry-run matrix artifacts without requiring secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-cheap-eval-test-'))
    try {
      const outPath = join(dir, 'report.md')
      const jsonPath = join(dir, 'report.json')
      const out = runEval([
        '--dry-run',
        '--suite',
        'v0',
        '--models',
        'deepseek-chat',
        '--tasks',
        'small-edit,bugfix',
        '--out',
        outPath,
        '--json-out',
        jsonPath,
      ])

      expect(out.status).toBe(0)
      expect(out.stdout).not.toContain('vsk_live_')
      expect(out.stderr).not.toContain('vsk_live_')
      expect(existsSync(outPath)).toBe(true)
      expect(existsSync(jsonPath)).toBe(true)

      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'))
      expect(parsed.meta.keyPresent).toBe(false)
      expect(parsed.rows).toHaveLength(2)
      expect(parsed.rows.map((r: any) => r.recipe)).toEqual(['small-edit', 'bugfix'])
      expect(readFileSync(outPath, 'utf8')).toContain('Cheap Model Eval Matrix')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('fails clearly before live runs when the gateway key is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-cheap-eval-test-'))
    try {
      const out = runEval([
        '--models',
        'deepseek-chat',
        '--tasks',
        'small-edit',
        '--out',
        join(dir, 'report.md'),
        '--json-out',
        join(dir, 'report.json'),
      ])

      expect(out.status).toBe(1)
      const parsed = JSON.parse(out.stderr)
      expect(parsed.ok).toBe(false)
      expect(parsed.message).toContain('VERSTAK_GATEWAY_API_KEY is missing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cheap model eval V0 contract', () => {
  it('freezes the five V0 fixtures and their deterministic contracts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-cheap-eval-v0-'))
    try {
      const jsonPath = join(dir, 'report.json')
      const out = runEval([
        '--dry-run',
        '--suite',
        'v0',
        '--models',
        'deepseek-chat',
        '--run-date',
        '2026-07-17T00:00:00.000Z',
        '--out',
        join(dir, 'report.md'),
        '--json-out',
        jsonPath,
      ])

      expect(out.status).toBe(0)
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'))
      expect(parsed.meta.fixtureManifest).toEqual([
        {
          id: 'small-edit',
          category: 'small-edit',
          recipe: 'small-edit',
          expectedFiles: ['README.md'],
          unrelatedFiles: ['unrelated.md'],
          verify: ['npm run type'],
          requiresReview: false,
          fixtureHash: '8efea7553a33c3bc9b7aa6f795d513e6754ec1edd41cf381c1c85aa795b89f97',
        },
        {
          id: 'bugfix',
          category: 'bugfix',
          recipe: 'bugfix',
          expectedFiles: ['calc.mjs'],
          unrelatedFiles: ['unrelated.mjs'],
          verify: ['npm run type', 'npm run test:fast'],
          requiresReview: true,
          fixtureHash: '2e150199c5ce8061c800b7b537587bae01aa169e1dc051ef845051fd00906ddf',
        },
        {
          id: 'typescript-error',
          category: 'typescript-error',
          recipe: 'typescript-error',
          expectedFiles: ['src/value.ts'],
          unrelatedFiles: ['src/unrelated.ts'],
          verify: ['npm run type'],
          requiresReview: false,
          fixtureHash: 'b1583d632564b070d1dbed88fb8b9dc44b45c981decf1c8ca3e516155ffec63e',
        },
        {
          id: 'test-fix',
          category: 'test-fix',
          recipe: 'test-fix',
          expectedFiles: ['math.mjs'],
          unrelatedFiles: ['math.test.mjs', 'unrelated.mjs'],
          verify: ['npm run test:fast'],
          requiresReview: false,
          fixtureHash: '672ad7d71abae8a56f498df2ad3d74d1b989c2c5efcab5dbd9c81413bed15631',
        },
        {
          id: 'review-before-commit',
          category: 'review-gate',
          recipe: 'review-before-commit',
          expectedFiles: [],
          unrelatedFiles: ['unrelated.mjs'],
          verify: ['npm run type', 'npm run test:fast'],
          requiresReview: true,
          fixtureHash: 'cba5f8072a023bf63af806d9ba4fdb45e9abf4ed1b5d0606f60e646e8b2a4157',
        },
      ])
      expect(parsed.rows.map((row: { recipe: string }) => row.recipe)).toEqual([
        'small-edit',
        'bugfix',
        'typescript-error',
        'test-fix',
        'review-before-commit',
      ])
      expect(parsed.recommendations.defaultCodingModel).toBe('not enough data')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('never writes provider secrets to dry-run artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-cheap-eval-secret-'))
    const fakeKey = 'vsk_live_MODEL_GYM_MUST_NOT_LEAK_123456'
    try {
      const outPath = join(dir, 'report.md')
      const jsonPath = join(dir, 'report.json')
      const out = runEval(
        [
          '--dry-run',
          '--models',
          'deepseek-chat',
          '--tasks',
          'small-edit',
          '--base-url',
          `https://example.invalid/v1?token=${fakeKey}`,
          '--out',
          outPath,
          '--json-out',
          jsonPath,
        ],
        { VERSTAK_GATEWAY_API_KEY: fakeKey },
      )

      expect(out.status).toBe(0)
      const combined = [out.stdout, out.stderr, readFileSync(outPath, 'utf8'), readFileSync(jsonPath, 'utf8')].join(
        '\n',
      )
      expect(combined).not.toContain(fakeKey)
      expect(combined).not.toMatch(/vsk_live_[A-Za-z0-9._-]+/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
