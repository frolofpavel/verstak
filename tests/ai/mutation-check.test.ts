// C2 (P6, пакет 2.5.0): мутация фикса — «тест не декоративный».
//
// ПРИЁМКА ПОСТАНОВКИ — контрольная пара на НАСТОЯЩЕМ git-репозитории:
// декоративный тест отвергнут, настоящий пропущен. Плюс три ограничения,
// которые главнее фичи: изоляция (рабочее дерево не тронуто ни байтом, копия
// видит мир БЕЗ фикса), граница узкого прогона (scope: 'narrow' в вердикте),
// бюджет (таймаут — 'error', не вердикт) и выключатель ('skipped', ничего не
// исполняется).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMutationCheck, type MutationCheckRunner } from '../../electron/ai/mutation-check'

const BUGGY = 'exports.add = (a, b) => a - b\n'
const FIXED = 'exports.add = (a, b) => a + b\n'

describe('mutation-check — мутация фикса в изолированном worktree', () => {
  let repo: string

  // Раннер исполняет тест НАСТОЯЩИМ node в переданном cwd — то, что prod-раннер
  // делает vitest-ом; форма прогона та же: exitCode 0/1 из процесса.
  const nodeRunner: MutationCheckRunner = async ({ cwd, testFile }) => {
    try {
      execFileSync(process.execPath, [testFile], { cwd, stdio: 'pipe' })
      return { exitCode: 0, timedOut: false, output: '' }
    } catch {
      return { exitCode: 1, timedOut: false, output: 'assert failed' }
    }
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'verstak-mutcheck-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    execFileSync('git', ['init', repo], { stdio: 'pipe' })
    git('config', 'user.email', 'test@verstak')
    git('config', 'user.name', 'verstak-test')
    // HEAD: багованный код. Фикс — ТОЛЬКО в рабочем дереве (незакоммичен).
    writeFileSync(join(repo, 'calc.cjs'), BUGGY)
    git('add', 'calc.cjs')
    git('commit', '-m', 'buggy add')
    writeFileSync(join(repo, 'calc.cjs'), FIXED)
    // Настоящий тест: красный на баге, зелёный на фиксе.
    writeFileSync(join(repo, 'real.test.cjs'),
      "const { add } = require('./calc.cjs')\nif (add(2, 3) !== 5) process.exit(1)\n")
    // Декоративный: зелёный всегда — ничего не стережёт.
    writeFileSync(join(repo, 'decorative.test.cjs'), 'process.exit(0)\n')
  })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('ПРИЁМКА: настоящий тест краснеет без фикса → real; декоративный зелен → отвергнут', async () => {
    const real = await runMutationCheck({ projectRoot: repo, testFile: 'real.test.cjs', runner: nodeRunner })
    expect(real.verdict).toBe('real')
    expect((real as { scope: string }).scope).toBe('narrow')  // граница объявлена в вердикте

    const dec = await runMutationCheck({ projectRoot: repo, testFile: 'decorative.test.cjs', runner: nodeRunner })
    expect(dec.verdict).toBe('decorative')
    expect((dec as { reason: string }).reason).toContain('не ловит')
  })

  it('ИЗОЛЯЦИЯ: копия видит мир БЕЗ фикса, рабочее дерево не тронуто ни байтом', async () => {
    let seenInCopy = ''
    const spyRunner: MutationCheckRunner = async ({ cwd }) => {
      seenInCopy = readFileSync(join(cwd, 'calc.cjs'), 'utf8')
      expect(cwd, 'проверка исполнялась В РАБОЧЕМ ДЕРЕВЕ — запрещено постановкой').not.toBe(repo)
      return { exitCode: 1, timedOut: false, output: '' }
    }
    await runMutationCheck({ projectRoot: repo, testFile: 'real.test.cjs', runner: spyRunner })
    // git на Windows может выдать CRLF при checkout — сравниваем содержание, не EOL.
    expect(seenInCopy.replace(/\r/g, ''), 'копия обязана быть HEAD — миром без фикса').toBe(BUGGY)
    expect(readFileSync(join(repo, 'calc.cjs'), 'utf8'), 'фикс в рабочем дереве пропал').toBe(FIXED)
    // Временный worktree убран за собой.
    const list = execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' })
    expect(list.trim().split('\n').length).toBe(1)
  })

  it('ВЫКЛЮЧАТЕЛЬ: enabled=false → skipped, исполнение не запускается вовсе', async () => {
    const runner = vi.fn<MutationCheckRunner>()
    const r = await runMutationCheck({ projectRoot: repo, testFile: 'real.test.cjs', runner, enabled: false })
    expect(r.verdict).toBe('skipped')
    expect(runner).not.toHaveBeenCalled()
  })

  it('БЮДЖЕТ: таймаут — error без вердикта (таймаут не отличает настоящий от декоративного)', async () => {
    const slow: MutationCheckRunner = async () => ({ exitCode: null, timedOut: true, output: '' })
    const r = await runMutationCheck({ projectRoot: repo, testFile: 'real.test.cjs', runner: slow, timeoutMs: 10 })
    expect(r.verdict).toBe('error')
    expect(r.reason).toContain('Бюджет')
  })

  it('путь с .. или отсутствующий тест → error, worktree не создаётся', async () => {
    const runner = vi.fn<MutationCheckRunner>()
    expect((await runMutationCheck({ projectRoot: repo, testFile: '../evil.test.js', runner })).verdict).toBe('error')
    expect((await runMutationCheck({ projectRoot: repo, testFile: 'missing.test.js', runner })).verdict).toBe('error')
    expect(runner).not.toHaveBeenCalled()
  })
})
