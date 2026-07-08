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
    env: { ...process.env, VERSTAK_GATEWAY_API_KEY: '', ...env },
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
        '--models', 'deepseek-chat',
        '--tasks', 'small-edit,bugfix',
        '--out', outPath,
        '--json-out', jsonPath,
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
        '--models', 'deepseek-chat',
        '--tasks', 'small-edit',
        '--out', join(dir, 'report.md'),
        '--json-out', join(dir, 'report.json'),
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
