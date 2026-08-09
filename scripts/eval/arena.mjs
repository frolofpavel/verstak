#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArenaSummary, writeArenaReports } from './arena-report.mjs'
import { analyzeSelfCheck } from './self-check.mjs'
import { getVerstakCommit, scanRunnerOutputForSecretLeak, splitList } from './contracts.mjs'
import { changedFiles, materializeFixture, runVerify, snapshot } from './fixtures/helpers.mjs'
import { selectFixtures } from './fixtures/index.mjs'
import { codexRunner, runCodex } from './runners/codex.mjs'
import { opencodeRunner, runOpenCode } from './runners/opencode.mjs'
import { probeVersion } from './runners/process.mjs'
import { runVerstakArena, verstakArenaRunner } from './runners/arena-verstak.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUNNERS = Object.freeze({
  verstak: { ...verstakArenaRunner, run: runVerstakArena },
  codex: { ...codexRunner, run: runCodex },
  opencode: { ...opencodeRunner, run: runOpenCode },
})

export async function runArena(argv, env = process.env) {
  const args = parseArenaArgs(argv)
  const fixtures = selectFixtures(args.suite, args.tasks)
  const selectedRunners = args.runners.map(id => {
    const runner = RUNNERS[id]
    if (!runner) throw new Error(`Unknown Arena runner: ${id}`)
    return runner
  })
  const probes = Object.fromEntries(selectedRunners.map(runner => [runner.id, runnerProbe(runner, args, env)]))
  const rows = []
  for (const runner of selectedRunners) {
    for (const fixture of fixtures) {
      for (let repeat = 1; repeat <= args.repeat; repeat++) {
        rows.push(await runOne({ runner, probe: probes[runner.id], fixture, repeat, args, env }))
      }
    }
  }
  const runDate = args.runDate ?? new Date().toISOString()
  const reproduceCommand = [
    'npm run eval:arena --',
    `--runners ${args.runners.join(',')}`,
    `--provider ${args.provider}`,
    `--models ${args.models.join(',')}`,
    `--suite ${args.suite}`,
    `--repeat ${args.repeat}`,
  ].join(' ')
  const payload = {
    meta: {
      arenaVersion: 'model-gym-arena-v1',
      verstakCommit: getVerstakCommit(ROOT),
      runDate,
      suite: args.suite,
      repeat: args.repeat,
      models: args.models,
      provider: args.provider,
      runners: args.runners,
      dryRun: args.dryRun,
      probes,
      reproduceCommand,
    },
    rows,
    summary: buildArenaSummary(rows, args.repeat),
  }
  writeArenaReports({ markdownPath: args.out, jsonPath: args.jsonOut, payload })
  return { ok: rows.every(row => !row.traceSecretLeak), report: args.out, json: args.jsonOut, rows: rows.length }
}

async function runOne({ runner, probe, fixture, repeat, args, env }) {
  // Не использовать общий test-prefix `verstak-`: teardown любого параллельного
  // Vitest-прогона удаляет такие каталоги и способен разрушить живой Arena run.
  const workspace = mkdtempSync(join(tmpdir(), `model-gym-arena-${runner.id}-${fixture.id}-`))
  try {
    materializeFixture(workspace, fixture)
    const before = snapshot(workspace)
    const model = args.models[0]
    const comparableBeforeRun = probe.available && args.models.length === 1
    let comparabilityReason = !probe.available
      ? `${runner.label} unavailable`
      : args.models.length !== 1
        ? 'Arena requires one identical model id for all runners'
        : ''
    const execution = args.dryRun
      ? { status: 0, stdout: '', stderr: '', error: null, durationMs: 0 }
      : comparableBeforeRun
        ? runner.run({
            repoRoot: ROOT,
            workspace,
            model,
            task: fixture.task,
            fixture,
            maxTurns: fixture.maxTurns,
            provider: args.provider,
            env,
          })
        : { status: 1, stdout: '', stderr: comparabilityReason, error: null, durationMs: 0 }
    const raw = `${execution.stdout}\n${execution.stderr}`
    const modelUnavailable =
      !args.dryRun &&
      /model.{0,40}(not found|unknown|unavailable|unsupported|invalid)|unknown model|invalid model/i.test(raw)
    const comparable = comparableBeforeRun && !modelUnavailable
    if (modelUnavailable) comparabilityReason = `model "${model}" is unavailable in ${runner.label}`
    // Трейс агента (метрики §5 V2: шаги · вызовы · ошибки · была ли проверка).
    // Отдаёт его только verstak-cli (--trace-json в stdout-JSON); у конкурентов
    // и в dry-run парс не удаётся, и метрики честно уходят в null/no-trace.
    let agentTrace = null
    try { agentTrace = JSON.parse(execution.stdout || '')?.trace ?? null } catch { /* нет JSON-вывода */ }
    const selfCheck = analyzeSelfCheck(agentTrace)
    const verifyRuns = !args.dryRun && comparable ? runVerify(workspace, fixture.verify) : []
    const after = existsSync(workspace) ? snapshot(workspace) : new Map()
    const changed = changedFiles(before, after)
    const verifyPass = verifyRuns.length > 0 && verifyRuns.every(result => result.exitCode === 0)
    const expectedTouched = fixture.expectedFiles.filter(file => changed.includes(file))
    const unrelatedTouched = fixture.unrelatedFiles.some(file => changed.includes(file))
    const traceSecretLeak = scanRunnerOutputForSecretLeak(raw)
    const result = classify({
      dryRun: args.dryRun,
      comparable,
      execution,
      verifyPass,
      expectedTouched,
      unrelatedTouched,
      traceSecretLeak,
    })
    return {
      runnerId: runner.id,
      runnerLabel: runner.label,
      runnerVersion: probe.version,
      model,
      fixtureId: fixture.id,
      repeat,
      result: result.result,
      failureMode: result.failureMode,
      verifyPass,
      changedFiles: changed,
      unrelatedFilesTouched: unrelatedTouched,
      durationMs: execution.durationMs,
      estimatedCost: null,
      interventions: countInterventions(raw),
      agentTurns: agentTrace?.turnsUsed ?? null,
      agentToolCalls: agentTrace?.toolCallsCount ?? agentTrace?.toolCalls?.length ?? null,
      agentErrors: agentTrace ? Boolean(agentTrace.runtimeError || agentTrace.modelError) : null,
      selfCheck: selfCheck.status,
      selfCheckEvidence: selfCheck.evidence,
      comparable,
      comparabilityReason,
      traceSecretLeak,
      exitCode: execution.status,
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function classify({ dryRun, comparable, execution, verifyPass, expectedTouched, unrelatedTouched, traceSecretLeak }) {
  if (dryRun) return { result: 'dry-run', failureMode: 'not executed' }
  if (!comparable) return { result: 'not comparable', failureMode: 'runner/model/permissions mismatch' }
  if (traceSecretLeak) return { result: 'fail', failureMode: 'secret leak in runner output' }
  if (execution.error || execution.status !== 0) return { result: 'fail', failureMode: 'runner failed' }
  if (!verifyPass) return { result: 'fail', failureMode: 'verify failed' }
  if (unrelatedTouched) return { result: 'fail', failureMode: 'unrelated file touched' }
  if (expectedTouched.length === 0) return { result: 'fail', failureMode: 'expected file not changed' }
  return { result: 'pass', failureMode: '' }
}

function parseArenaArgs(argv) {
  const args = {
    runners: ['verstak', 'codex', 'opencode'],
    models: [],
    tasks: null,
    // Провайдер verstak-раннера. Ключ берётся ИЗ ОКРУЖЕНИЯ по имени провайдера
    // (PROVIDER_ENV_KEYS) — в код и отчёты значения ключей не попадают.
    provider: 'verstak-gateway',
    suite: 'core',
    repeat: 3,
    runDate: null,
    dryRun: false,
    out: join(ROOT, '.verstak-data', 'model-gym', 'arena-latest.md'),
    jsonOut: join(ROOT, '.verstak-data', 'model-gym', 'arena-latest.json'),
  }
  const valueAt = (index, name) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--runners') args.runners = splitList(valueAt(i++, arg))
    else if (arg === '--provider') args.provider = valueAt(i++, arg)
    else if (arg === '--models') args.models = splitList(valueAt(i++, arg))
    else if (arg === '--tasks') args.tasks = splitList(valueAt(i++, arg))
    else if (arg === '--suite') args.suite = valueAt(i++, arg)
    else if (arg === '--repeat') args.repeat = positiveInteger(valueAt(i++, arg), arg)
    else if (arg === '--run-date') args.runDate = new Date(valueAt(i++, arg)).toISOString()
    else if (arg === '--out') args.out = resolve(valueAt(i++, arg))
    else if (arg === '--json-out') args.jsonOut = resolve(valueAt(i++, arg))
    else if (arg === '--dry-run') args.dryRun = true
    else throw new Error(`Unknown Arena argument: ${arg}`)
  }
  if (args.models.length !== 1) throw new Error('--models must contain exactly one shared model id')
  if (!args.runners.length) throw new Error('--runners must contain at least one runner')
  return args
}

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error(`${name} must be 1..100`)
  return parsed
}

function countInterventions(text) {
  return (String(text).match(/approval|confirm|intervention|permission denied|retry/gi) ?? []).length
}

function dryProbe(runner) {
  return { available: true, version: `${runner.id}-dry-run`, error: null }
}

// Env-ключ на провайдера — зеркало ENV_KEYS из scripts/verstak-cli.mjs для
// провайдеров, которыми реально гоняют Arena. Значение ключа никогда не читается
// дальше Boolean(): в отчёт попадает только имя недостающей переменной.
const PROVIDER_ENV_KEYS = Object.freeze({
  'verstak-gateway': 'VERSTAK_GATEWAY_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
})

function runnerProbe(runner, args, env) {
  if (args.dryRun) return dryProbe(runner)
  if (runner.id === 'verstak') {
    const envKey = PROVIDER_ENV_KEYS[args.provider]
    if (!envKey) {
      return {
        available: false,
        version: `verstak-${getVerstakCommit(ROOT).slice(0, 12)}`,
        error: `Arena does not know the env key for provider "${args.provider}"`,
      }
    }
    return {
      available: Boolean(env[envKey]),
      version: `verstak-${getVerstakCommit(ROOT).slice(0, 12)}`,
      error: env[envKey] ? null : `${envKey} is missing`,
    }
  }
  return probeVersion(runner, env)
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) {
  try {
    const result = await runArena(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
