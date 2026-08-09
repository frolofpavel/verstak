import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ARENA = resolve(__dirname, '../../scripts/eval/arena.mjs')

// Baseline Arena снимается на DeepSeek (ключ шлюза отсутствует), а раннер verstak
// звал провайдера жёстко. Флаг --provider выбирает провайдера verstak-cli; ключ
// по-прежнему берётся из окружения по имени провайдера и в отчёт не попадает.
// Бюджет как у соседнего Arena-теста: дочерний node под конкуренцией (см. его шапку).
const ARENA_DRY_RUN_TIMEOUT_MS = 90_000

function dryRun(dir: string, extra: string[]) {
  return spawnSync(
    'node',
    [
      ARENA, '--dry-run', '--runners', 'verstak', '--models', 'deepseek-chat',
      '--tasks', 'small-edit', '--repeat', '1',
      '--run-date', '2026-08-09T00:00:00.000Z',
      '--out', join(dir, 'arena.md'), '--json-out', join(dir, 'arena.json'),
      ...extra,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  )
}

describe('Arena --provider', () => {
  it('--provider deepseek попадает в meta и в команду воспроизведения', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-arena-provider-'))
    try {
      const result = dryRun(dir, ['--provider', 'deepseek'])
      expect(result.status).toBe(0)
      const report = JSON.parse(readFileSync(join(dir, 'arena.json'), 'utf8'))
      expect(report.meta.provider).toBe('deepseek')
      expect(report.meta.reproduceCommand).toContain('--provider deepseek')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, ARENA_DRY_RUN_TIMEOUT_MS)

  it('КОНТРОЛЬ: без флага провайдер остаётся verstak-gateway (прежнее поведение)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-arena-provider-def-'))
    try {
      const result = dryRun(dir, [])
      expect(result.status).toBe(0)
      const report = JSON.parse(readFileSync(join(dir, 'arena.json'), 'utf8'))
      expect(report.meta.provider).toBe('verstak-gateway')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, ARENA_DRY_RUN_TIMEOUT_MS)
})
