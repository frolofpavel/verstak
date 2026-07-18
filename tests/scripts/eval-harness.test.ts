import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const HARNESS = resolve(__dirname, '../../scripts/eval/index.mjs')
const LEGACY = resolve(__dirname, '../../scripts/eval-cheap-models.mjs')
const PACKAGE = resolve(__dirname, '../../package.json')

function runScript(script: string, args: string[]) {
  return spawnSync('node', [script, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      VERSTAK_GATEWAY_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
  })
}

function dryRunArgs(dir: string) {
  return [
    '--dry-run',
    '--suite',
    'core',
    '--models',
    'a,b',
    '--repeat',
    '3',
    '--run-date',
    '2026-07-17T00:00:00.000Z',
    '--out',
    join(dir, 'report.md'),
    '--json-out',
    join(dir, 'report.json'),
  ]
}

describe('modular model eval harness', () => {
  it('exposes the documented npm entry point', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8'))
    expect(pkg.scripts['eval:models']).toBe('node scripts/eval/index.mjs')
  })

  it('runs the core suite for arbitrary model ids and repeats with complete metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-eval-harness-'))
    try {
      const out = runScript(HARNESS, dryRunArgs(dir))
      expect(out.status).toBe(0)

      const parsed = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
      expect(parsed.meta).toMatchObject({
        runnerVersion: 'model-gym-v0',
        suite: 'core',
        repeat: 3,
        runDate: '2026-07-17T00:00:00.000Z',
      })
      expect(parsed.meta.verstakCommit).toMatch(/^[a-f0-9]{40}$/)
      expect(parsed.rows).toHaveLength(30)

      for (const row of parsed.rows) {
        expect(row.provider).toBe('verstak-gateway')
        expect(['a', 'b']).toContain(row.model)
        expect(row.selectedModel).toBe(row.model)
        expect(row.fixtureHash).toMatch(/^[a-f0-9]{64}$/)
        expect(row.repeat).toBeGreaterThanOrEqual(1)
        expect(row.repeat).toBeLessThanOrEqual(3)
        expect(row.durationMs).toBe(0)
        expect(row.tokens).toEqual({ input: null, output: null, total: null })
        expect(row.estimatedCost).toBeNull()
        expect(row.passFailReason).toBe('not executed')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('produces byte-identical dry-run reports for the same command and run date', () => {
    const first = mkdtempSync(join(tmpdir(), 'verstak-eval-repro-a-'))
    const second = mkdtempSync(join(tmpdir(), 'verstak-eval-repro-b-'))
    try {
      expect(runScript(HARNESS, dryRunArgs(first)).status).toBe(0)
      expect(runScript(HARNESS, dryRunArgs(second)).status).toBe(0)
      expect(readFileSync(join(first, 'report.json'), 'utf8')).toBe(readFileSync(join(second, 'report.json'), 'utf8'))
      expect(readFileSync(join(first, 'report.md'), 'utf8')).toBe(readFileSync(join(second, 'report.md'), 'utf8'))
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps the legacy wrapper compatible with the modular entry point', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'verstak-eval-legacy-'))
    const modularDir = mkdtempSync(join(tmpdir(), 'verstak-eval-modular-'))
    const common = [
      '--dry-run',
      '--models',
      'deepseek-chat',
      '--tasks',
      'small-edit,bugfix',
      '--run-date',
      '2026-07-17T00:00:00.000Z',
    ]
    try {
      const legacy = runScript(LEGACY, [
        ...common,
        '--out',
        join(legacyDir, 'report.md'),
        '--json-out',
        join(legacyDir, 'report.json'),
      ])
      const modular = runScript(HARNESS, [
        ...common,
        '--out',
        join(modularDir, 'report.md'),
        '--json-out',
        join(modularDir, 'report.json'),
      ])
      expect(legacy.status).toBe(0)
      expect(modular.status).toBe(0)
      expect(readFileSync(join(legacyDir, 'report.json'), 'utf8')).toBe(
        readFileSync(join(modularDir, 'report.json'), 'utf8'),
      )
      expect(readFileSync(join(legacyDir, 'report.md'), 'utf8')).toBe(
        readFileSync(join(modularDir, 'report.md'), 'utf8'),
      )
    } finally {
      rmSync(legacyDir, { recursive: true, force: true })
      rmSync(modularDir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('legacy fixture workspace behavior', () => {
  it('materializes and keeps a dry-run workspace when explicitly requested', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-eval-keep-workspace-'))
    let workspace: string | null = null
    try {
      const jsonPath = join(dir, 'report.json')
      const out = runScript(LEGACY, [
        '--dry-run',
        '--keep-workspaces',
        '--models',
        'deepseek-chat',
        '--tasks',
        'small-edit',
        '--run-date',
        '2026-07-17T00:00:00.000Z',
        '--out',
        join(dir, 'report.md'),
        '--json-out',
        jsonPath,
      ])
      expect(out.status).toBe(0)
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'))
      workspace = parsed.rows[0].workspace
      expect(workspace).toBeTruthy()
      expect(existsSync(join(workspace!, '.git'))).toBe(true)
      expect(readFileSync(join(workspace!, 'README.md'), 'utf8')).toContain('helo to Verstak')
      expect(readFileSync(join(workspace!, 'unrelated.md'), 'utf8')).toBe('do-not-touch\n')
    } finally {
      if (workspace) rmSync(workspace, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
