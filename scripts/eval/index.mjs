#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PROVIDER,
  RUNNER_VERSION,
  fixtureHash,
  fixtureManifestEntry,
  getVerstakCommit,
  hasSecretLikeText,
  helpText,
  parseArgs,
  redactSecrets,
  safeBaseUrl,
  selectModelSpecs,
} from './contracts.mjs'
import { changedFiles, diffLines, materializeFixture, runVerify, snapshot } from './fixtures/helpers.mjs'
import { selectFixtures } from './fixtures/index.mjs'
import { buildRecommendations, writeReports } from './report.mjs'
import { extractUsage, publicProbe, resolveModel, runVerstakCli } from './runners/verstak.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(ROOT, 'scripts', 'verstak-cli.mjs')

export async function runEval(argv, env = process.env) {
  const args = parseArgs(argv, ROOT, env)
  if (args.help) return { help: true, text: helpText() }

  const apiKey = env.VERSTAK_GATEWAY_API_KEY || ''
  const fixtures = selectFixtures(args.suite, args.tasks)
  const modelSpecs = selectModelSpecs(args.models)
  if (!modelSpecs.length) throw new Error('No models selected')
  if (!args.dryRun && !args.probeOnly && !apiKey) throw new Error('VERSTAK_GATEWAY_API_KEY is missing')

  const startedAt = args.runDate ?? new Date().toISOString()
  const rows = []
  const resolvedModels = []

  runLoop: for (const spec of modelSpecs) {
    const modelInfo = await resolveModel(spec, args, apiKey)
    resolvedModels.push({ id: modelInfo.id, selected: modelInfo.selected, probe: publicProbe(modelInfo.probe) })
    process.stderr.write(
      redactSecrets(
        `${spec.id}: ${modelInfo.probe.ok ? `available as ${modelInfo.selected}` : `not tested: ${modelInfo.probe.status}`}\n`,
        [apiKey],
      ),
    )

    for (const fixture of fixtures) {
      for (let repeat = 1; repeat <= args.repeat; repeat++) {
        if (args.limit !== null && rows.length >= args.limit) break runLoop
        process.stderr.write(redactSecrets(`run: ${spec.id} / ${fixture.id} / repeat ${repeat}\n`, [apiKey]))
        rows.push(await runOne({ fixture, modelInfo, args, apiKey, repeat, runDate: startedAt }))
      }
    }
  }

  const recommendations = buildRecommendations(rows)
  const meta = {
    runnerVersion: RUNNER_VERSION,
    verstakCommit: getVerstakCommit(ROOT),
    runDate: startedAt,
    startedAt,
    finishedAt: args.dryRun ? startedAt : new Date().toISOString(),
    provider: DEFAULT_PROVIDER,
    suite: args.suite,
    repeat: args.repeat,
    models: modelSpecs.map(spec => spec.id),
    fixtureManifest: fixtures.map(fixtureManifestEntry),
    keyPresent: Boolean(apiKey),
    dryRun: args.dryRun,
    probeOnly: args.probeOnly,
    baseUrl: safeBaseUrl(args.baseUrl, [apiKey]),
    resolvedModels,
  }
  const payload = { meta, rows, recommendations }
  writeReports({ markdownPath: args.out, jsonPath: args.jsonOut, payload, explicitSecrets: [apiKey] })

  return {
    ok: rows.every(row => !row.traceSecretLeak),
    report: args.out,
    json: args.jsonOut,
    rows: rows.length,
    keyPresent: Boolean(apiKey),
    recommendations,
    secretLeaks: rows.filter(row => row.traceSecretLeak).length,
  }
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  try {
    const result = await runEval(argv, env)
    if (result.help) {
      process.stdout.write(result.text)
      return
    }
    if (result.secretLeaks > 0) process.exitCode = 2
    process.stdout.write(redactSecrets(JSON.stringify(result, null, 2) + '\n', [env.VERSTAK_GATEWAY_API_KEY || '']))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      JSON.stringify(
        {
          ok: false,
          message: redactSecrets(message, [env.VERSTAK_GATEWAY_API_KEY || '']),
        },
        null,
        2,
      ) + '\n',
    )
    process.exitCode = 1
  }
}

async function runOne({ fixture, modelInfo, args, apiKey, repeat, runDate }) {
  const shouldExecute = !args.dryRun && !args.probeOnly && modelInfo.probe.ok
  const shouldMaterialize = shouldExecute || args.keepWorkspaces
  const deterministicOnly = !shouldExecute
  let workspace = null
  let before = new Map()
  let cli = {
    status: modelInfo.probe.ok ? 0 : 1,
    stdout: '',
    stderr: args.dryRun ? 'dry-run' : `not tested: ${modelInfo.probe.status}`,
  }
  let parsed = null
  let parseError = null
  let verifyRuns = []
  const started = deterministicOnly ? 0 : Date.now()

  try {
    if (shouldMaterialize) {
      workspace = mkdtempSync(join(tmpdir(), `verstak-eval-${fixture.id}-${safeName(modelInfo.id)}-`))
      materializeFixture(workspace, fixture)
      before = snapshot(workspace)
    }
    if (shouldExecute) {
      cli = runVerstakCli({
        root: workspace,
        repoRoot: ROOT,
        cliPath: CLI,
        fixture,
        model: modelInfo.selected,
        maxTurns: args.maxTurns ?? fixture.maxTurns,
      })
      try {
        parsed = JSON.parse(cli.stdout || '{}')
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error)
      }
      verifyRuns = runVerify(workspace, fixture.verify)
    }

    const after = workspace && existsSync(workspace) ? snapshot(workspace) : new Map()
    const changed = changedFiles(before, after)
    const trace = parsed?.trace ?? null
    const verifyPass = verifyRuns.length > 0 && verifyRuns.every(result => result.exitCode === 0)
    const reviewGate = trace?.reviewGate ?? (fixture.requiresReview ? 'not-called' : 'n/a')
    const unrelatedTouched = fixture.unrelatedFiles.some(file => changed.includes(file))
    const expectedTouched = fixture.expectedFiles.filter(file => changed.includes(file))
    const unexpectedTouched = changed.filter(
      file => !fixture.expectedFiles.includes(file) && !fixture.unrelatedFiles.includes(file),
    )
    const rawRuntimeOutput = `${cli.stdout ?? ''}\n${cli.stderr ?? ''}\n${JSON.stringify(trace ?? {})}`
    const secretLeak = (Boolean(apiKey) && rawRuntimeOutput.includes(apiKey)) || hasSecretLikeText(rawRuntimeOutput)
    const malformedToolCalls =
      /tool|function|json|parse/i.test(`${parseError ?? ''}\n${cli.stderr ?? ''}\n${trace?.failureReason ?? ''}`) &&
      cli.status !== 0
    const runtimeError =
      Boolean(parseError) ||
      Boolean(cli.error) ||
      /api_key_not_found|Provider config|ENOENT|spawn failed|timeout/i.test(
        `${cli.stderr ?? ''}\n${trace?.failureReason ?? ''}`,
      )
    const status = classifyStatus({
      args,
      modelInfo,
      cli,
      verifyPass,
      reviewGate,
      fixture,
      unrelatedTouched,
      expectedTouched,
      unexpectedTouched,
      secretLeak,
    })
    const usage = extractUsage(parsed)

    return {
      runnerVersion: RUNNER_VERSION,
      runDate,
      provider: DEFAULT_PROVIDER,
      model: modelInfo.id,
      selectedModel: modelInfo.selected,
      fixtureId: fixture.id,
      fixtureHash: fixtureHash(fixture),
      repeat,
      recipe: fixture.recipe,
      result: status.result,
      exitCode: cli.status ?? 1,
      turnsUsed: maxTurn(trace),
      toolCallsCount: trace?.toolCalls?.length ?? 0,
      firstMutatingTool: trace?.firstMutatingTool ?? null,
      baselineTaken: Boolean(trace?.baselineTaken),
      verifyPass,
      reviewGate,
      diffSize: diffLines(before, after, changed),
      changedFiles: changed,
      unrelatedFilesTouched: unrelatedTouched,
      malformedToolCalls,
      fallbackTriggered: /fallback/i.test(`${cli.stdout ?? ''}\n${cli.stderr ?? ''}\n${trace?.failureReason ?? ''}`),
      errorClass: runtimeError ? 'runtime error' : cli.status === 0 ? null : 'model error',
      failureMode: status.failureMode,
      passFailReason: status.failureMode,
      spawnError: cli.error?.message ?? null,
      traceSecretLeak: secretLeak,
      durationMs: deterministicOnly ? 0 : Date.now() - started,
      tokens: usage.tokens,
      estimatedCost: usage.estimatedCost,
      approximateCost: usage.estimatedCost,
      workspace: args.keepWorkspaces ? workspace : null,
      probe: publicProbe(modelInfo.probe),
      verifyRuns: verifyRuns.map(result => ({ command: result.command, exitCode: result.exitCode })),
      recommendation: status.recommendation,
      stdoutTail: redactSecrets(String(cli.stdout ?? '').slice(-1200), [apiKey]),
      stderrTail: redactSecrets(String(cli.stderr ?? '').slice(-1200), [apiKey]),
    }
  } finally {
    if (workspace && !args.keepWorkspaces) rmSync(workspace, { recursive: true, force: true })
  }
}

function classifyStatus({
  args,
  modelInfo,
  cli,
  verifyPass,
  reviewGate,
  fixture,
  unrelatedTouched,
  expectedTouched,
  unexpectedTouched,
  secretLeak,
}) {
  if (args.dryRun) return { result: 'dry-run', failureMode: 'not executed', recommendation: 'not scored' }
  if (args.probeOnly)
    return {
      result: modelInfo.probe.ok ? 'available' : 'not tested',
      failureMode: modelInfo.probe.status,
      recommendation: 'probe only',
    }
  if (!modelInfo.probe.ok)
    return {
      result: 'not tested',
      failureMode: `unavailable: ${modelInfo.probe.status}`,
      recommendation: 'not tested: unavailable',
    }
  if (secretLeak)
    return { result: 'fail', failureMode: 'secret leak in trace/output', recommendation: 'block for agent mode' }
  if (cli.error)
    return {
      result: 'fail',
      failureMode: `runner spawn failed: ${cli.error.message}`,
      recommendation: 'fix eval runner/runtime',
    }
  if (cli.status !== 0)
    return { result: 'fail', failureMode: 'non-zero exit', recommendation: 'do not use for this recipe yet' }
  if (!verifyPass)
    return { result: 'fail', failureMode: 'verify failed after run', recommendation: 'do not use for this recipe yet' }
  if (fixture.expectedFiles.length && expectedTouched.length === 0)
    return {
      result: 'fail',
      failureMode: 'expected file not changed',
      recommendation: 'do not use for patch recipes yet',
    }
  if (unrelatedTouched)
    return { result: 'fail', failureMode: 'unrelated file touched', recommendation: 'not suitable for agent mode' }
  if (unexpectedTouched.length > 0)
    return {
      result: 'warn',
      failureMode: `unexpected files changed: ${unexpectedTouched.join(', ')}`,
      recommendation: 'fallback only',
    }
  if (fixture.requiresReview && reviewGate !== 'pass')
    return {
      result: 'fail',
      failureMode: 'review gate not passed',
      recommendation: 'do not use for required-review recipes',
    }
  return { result: 'pass', failureMode: '', recommendation: 'candidate' }
}

function maxTurn(trace) {
  const turns = (trace?.toolCalls ?? []).map(call => Number(call.turn)).filter(Number.isFinite)
  return turns.length ? Math.max(...turns) + 1 : 0
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, '-')
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) await runCli()
