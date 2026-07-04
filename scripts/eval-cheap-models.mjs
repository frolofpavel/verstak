#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'scripts', 'verstak-cli.mjs')
const DEFAULT_OUT = join(ROOT, 'docs', 'cheap-model-eval-2026-07-04.md')
const DEFAULT_JSON_OUT = join(ROOT, 'docs', 'cheap-model-eval-2026-07-04.json')

const MODEL_SPECS = [
  { id: 'deepseek-chat', aliases: ['deepseek-chat'] },
  { id: 'deepseek-reasoner', aliases: ['deepseek-reasoner'] },
  { id: 'qwen3-coder', aliases: ['qwen3-coder', 'qwen/qwen3-coder'] },
  { id: 'kimi-k2.7-code', aliases: ['kimi-k2.7-code', 'moonshotai-kimi-k2', 'moonshotai/kimi-k2'] },
  { id: 'z-ai/glm-4.6', aliases: ['z-ai/glm-4.6', 'glm-4.6', 'zai-org/glm-4.6'] },
  { id: 'minimax-m1', aliases: ['minimax-m1', 'minimax/minimax-m1'] },
  { id: 'verstak/coder', aliases: ['verstak/coder'] },
  { id: 'verstak/coder/fast', aliases: ['verstak/coder/fast', 'verstak/fast'] },
  { id: 'verstak/coder/balanced', aliases: ['verstak/coder/balanced', 'verstak/balanced'] },
]

const VERIFY_BY_RECIPE = {
  'small-edit': ['npm run type'],
  'typescript-error': ['npm run type'],
  'bugfix': ['npm run type', 'npm run test:fast'],
  'test-fix': ['npm run test:fast'],
  'review-before-commit': ['npm run type', 'npm run test:fast'],
}

const TASKS = [
  {
    id: 'small-edit',
    recipe: 'small-edit',
    maxTurns: 7,
    expectedFiles: ['README.md'],
    unrelatedFiles: ['unrelated.md'],
    task: [
      'Make the smallest possible edit in README.md:',
      'replace "helo" with "hello".',
      'Do not touch unrelated.md. Run npm run type and finish only after it passes.',
    ].join(' '),
    setup(root) {
      writePackage(root, {
        type: 'node verify-type.mjs',
        'test:fast': 'node verify-type.mjs',
        test: 'node verify-type.mjs',
      })
      write(root, 'README.md', '# Fixture\n\nThis file says helo to Verstak.\n')
      write(root, 'unrelated.md', 'do-not-touch\n')
      write(root, 'verify-type.mjs', [
        "import { readFileSync } from 'node:fs';",
        "const text = readFileSync('README.md', 'utf8');",
        "if (!text.includes('hello to Verstak')) throw new Error('README.md still has typo');",
        "if (readFileSync('unrelated.md', 'utf8') !== 'do-not-touch\\n') throw new Error('unrelated.md changed');",
        "console.log('type ok');",
        '',
      ].join('\n'))
    },
  },
  {
    id: 'bugfix',
    recipe: 'bugfix',
    maxTurns: 9,
    expectedFiles: ['calc.mjs'],
    unrelatedFiles: ['unrelated.mjs'],
    task: [
      'Fix the failing add() implementation with the smallest diff.',
      'calc.mjs currently returns a - b, but add(2, 3) must return 5.',
      'Do not touch unrelated.mjs. Run npm run type and npm run test:fast.',
      'Because this recipe requires review, call review_before_commit before final answer.',
    ].join(' '),
    setup(root) {
      writePackage(root, {
        type: 'node test.mjs',
        'test:fast': 'node test.mjs',
        test: 'node test.mjs',
      })
      write(root, 'calc.mjs', 'export function add(a, b) {\n  return a - b\n}\n')
      write(root, 'test.mjs', [
        "import { strict as assert } from 'node:assert';",
        "import { add } from './calc.mjs';",
        'assert.equal(add(2, 3), 5);',
        "console.log('tests ok');",
        '',
      ].join('\n'))
      write(root, 'unrelated.mjs', 'export const marker = 42\n')
    },
  },
  {
    id: 'typescript-error',
    recipe: 'typescript-error',
    maxTurns: 8,
    expectedFiles: ['src/value.ts'],
    unrelatedFiles: ['src/unrelated.ts'],
    task: [
      'Fix the TypeScript type error in src/value.ts with the smallest diff.',
      'The exported count must stay a number.',
      'Do not touch src/unrelated.ts. Run npm run type.',
    ].join(' '),
    setup(root) {
      writePackage(root, {
        type: 'node typecheck.mjs',
        'test:fast': 'node typecheck.mjs',
        test: 'node typecheck.mjs',
      })
      write(root, 'tsconfig.json', JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext' },
        include: ['src/**/*.ts'],
      }, null, 2) + '\n')
      write(root, 'src/value.ts', 'export const count: number = "3"\n')
      write(root, 'src/unrelated.ts', 'export const untouched = true\n')
      write(root, 'typecheck.mjs', [
        "import { readFileSync } from 'node:fs';",
        "const value = readFileSync('src/value.ts', 'utf8');",
        "if (!/count:\\s*number\\s*=\\s*3\\b/.test(value)) throw new Error('src/value.ts still assigns a string');",
        "if (readFileSync('src/unrelated.ts', 'utf8') !== 'export const untouched = true\\n') throw new Error('src/unrelated.ts changed');",
        "console.log('type ok');",
        '',
      ].join('\n'))
    },
  },
  {
    id: 'test-fix',
    recipe: 'test-fix',
    maxTurns: 8,
    expectedFiles: ['math.mjs'],
    unrelatedFiles: ['math.test.mjs', 'unrelated.mjs'],
    task: [
      'Fix the implementation, not the test.',
      'math.test.mjs expects multiply(3, 4) to equal 12.',
      'Keep the diff minimal, do not edit math.test.mjs or unrelated.mjs.',
      'Run npm run test:fast.',
    ].join(' '),
    setup(root) {
      writePackage(root, {
        type: 'node math.test.mjs',
        'test:fast': 'node math.test.mjs',
        test: 'node math.test.mjs',
      })
      write(root, 'math.mjs', 'export function multiply(a, b) {\n  return a + b\n}\n')
      write(root, 'math.test.mjs', [
        "import { strict as assert } from 'node:assert';",
        "import { multiply } from './math.mjs';",
        'assert.equal(multiply(3, 4), 12);',
        "console.log('tests ok');",
        '',
      ].join('\n'))
      write(root, 'unrelated.mjs', 'export const marker = "stable"\n')
    },
  },
  {
    id: 'review-before-commit',
    recipe: 'review-before-commit',
    maxTurns: 7,
    expectedFiles: [],
    unrelatedFiles: ['unrelated.mjs'],
    task: [
      'Review the existing change already present in the workspace.',
      'Do not edit files. Run npm run type and npm run test:fast, then call review_before_commit.',
      'Only finish after the review gate passes.',
    ].join(' '),
    setup(root) {
      writePackage(root, {
        type: 'node test.mjs',
        'test:fast': 'node test.mjs',
        test: 'node test.mjs',
      })
      write(root, 'calc.mjs', 'export function add(a, b) {\n  return a - b\n}\n')
      write(root, 'test.mjs', [
        "import { strict as assert } from 'node:assert';",
        "import { add } from './calc.mjs';",
        'assert.equal(add(2, 3), 5);',
        "console.log('tests ok');",
        '',
      ].join('\n'))
      write(root, 'unrelated.mjs', 'export const marker = 42\n')
      runGit(root, ['init'])
      runGit(root, ['config', 'user.email', 'eval@example.local'])
      runGit(root, ['config', 'user.name', 'Verstak Eval'])
      runGit(root, ['add', '.'])
      runGit(root, ['commit', '-m', 'baseline'])
      write(root, 'calc.mjs', 'export function add(a, b) {\n  return a + b\n}\n')
    },
  },
]

function parseArgs(argv) {
  const args = {
    models: null,
    tasks: null,
    out: DEFAULT_OUT,
    jsonOut: DEFAULT_JSON_OUT,
    maxTurns: null,
    dryRun: false,
    probeOnly: false,
    keepWorkspaces: false,
    skipProbe: false,
    limit: null,
    baseUrl: process.env.VERSTAK_GATEWAY_BASEURL || 'https://api-ru.agi-iri.ru/v1',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--models') args.models = splitList(argv[++i])
    else if (a === '--tasks') args.tasks = splitList(argv[++i])
    else if (a === '--out') args.out = resolve(argv[++i])
    else if (a === '--json-out') args.jsonOut = resolve(argv[++i])
    else if (a === '--max-turns') args.maxTurns = Number(argv[++i])
    else if (a === '--limit') args.limit = Number(argv[++i])
    else if (a === '--base-url') args.baseUrl = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--probe-only') args.probeOnly = true
    else if (a === '--keep-workspaces') args.keepWorkspaces = true
    else if (a === '--skip-probe') args.skipProbe = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }
  return args
}

function printHelp() {
  console.log(`Usage: node scripts/eval-cheap-models.mjs [options]

Runs cheap model evals through the existing headless recipe runner.

Options:
  --models a,b       Model ids to run. Defaults to the Stage 11 model list.
  --tasks a,b        Task ids to run. Defaults to all five eval tasks.
  --out path         Markdown report path. Default: docs/cheap-model-eval-2026-07-04.md
  --json-out path    JSON summary path. Default: docs/cheap-model-eval-2026-07-04.json
  --max-turns n      Override per-task max turns.
  --limit n          Stop after n model/task runs.
  --base-url url     Gateway base URL for availability probes.
  --dry-run          Generate fixtures/report without calling providers.
  --probe-only       Probe model availability and write report, no recipe runs.
  --skip-probe       Run aliases directly without availability probe.
  --keep-workspaces  Do not remove temp workspaces.
`)
}

function splitList(value) {
  return String(value ?? '').split(',').map(v => v.trim()).filter(Boolean)
}

function write(root, file, content) {
  const target = join(root, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function writePackage(root, scripts) {
  write(root, 'package.json', JSON.stringify({
    name: `verstak-eval-${basename(root).replace(/[^a-z0-9-]/gi, '-')}`,
    private: true,
    type: 'module',
    scripts,
  }, null, 2) + '\n')
}

function runGit(root, args) {
  const out = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 })
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr || out.stdout}`)
}

function initGitBaseline(root) {
  runGit(root, ['init'])
  runGit(root, ['config', 'user.email', 'eval@example.local'])
  runGit(root, ['config', 'user.name', 'Verstak Eval'])
  runGit(root, ['add', '.'])
  runGit(root, ['commit', '-m', 'baseline'])
}

function snapshot(root) {
  const files = new Map()
  walk(root, root, files)
  return files
}

function walk(root, dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.verstak') continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(root, abs, files)
    } else if (entry.isFile()) {
      const rel = relative(root, abs).replace(/\\/g, '/')
      files.set(rel, readFileSync(abs, 'utf8'))
    }
  }
}

function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()])
  return [...names].filter(name => before.get(name) !== after.get(name)).sort()
}

function diffLines(before, after, files) {
  let count = 0
  for (const file of files) {
    const a = (before.get(file) ?? '').split(/\r?\n/)
    const b = (after.get(file) ?? '').split(/\r?\n/)
    const max = Math.max(a.length, b.length)
    for (let i = 0; i < max; i++) {
      if (a[i] !== b[i]) count++
    }
  }
  return count
}

function runVerify(root, commands) {
  return commands.map(command => {
    const out = spawnSync(command, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 6 * 1024 * 1024,
    })
    return { command, exitCode: out.status ?? 1, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.slice(0, 4000) }
  })
}

function runCli(root, task, model, maxTurns) {
  return spawnSync(process.execPath, [
    CLI,
    'recipe', 'run',
    '--provider', 'verstak-gateway',
    '--model', model,
    '--recipe', task.recipe,
    '--workspace', root,
    '--task', task.task,
    '--json',
    '--trace-json',
    '--max-turns', String(maxTurns),
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 420_000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  })
}

async function probeAlias(alias, apiKey, baseUrl) {
  if (!apiKey) return { ok: false, status: 'missing-key', alias }
  const url = new URL(baseUrl.replace(/\/$/, '') + '/chat/completions')
  const payload = JSON.stringify({
    model: alias,
    messages: [{ role: 'user', content: 'Return exactly: ok' }],
    max_tokens: 8,
    stream: false,
  })
  return new Promise(resolveProbe => {
    const req = httpsRequest(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: 45_000,
    }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        resolveProbe({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: String(res.statusCode ?? 'unknown'),
          alias,
          message: redact(body.slice(0, 500), apiKey),
        })
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', err => {
      resolveProbe({ ok: false, status: 'network-error', alias, message: redact(err.message, apiKey) })
    })
    req.write(payload)
    req.end()
  })
}

async function resolveModel(spec, args, apiKey) {
  if (args.dryRun || args.skipProbe) return { ...spec, selected: spec.aliases[0], probe: { ok: true, status: args.dryRun ? 'dry-run' : 'skipped' } }
  const probes = []
  for (const alias of spec.aliases) {
    const probe = await probeAlias(alias, apiKey, args.baseUrl)
    probes.push(probe)
    if (probe.ok) return { ...spec, selected: alias, probe, probes }
  }
  return { ...spec, selected: spec.aliases[0], probe: probes.at(-1) ?? { ok: false, status: 'not-probed' }, probes }
}

async function runOne(task, modelInfo, args, apiKey) {
  const root = mkdtempSync(join(tmpdir(), `verstak-eval-${task.id}-${safeName(modelInfo.id)}-`))
  task.setup(root)
  if (!existsSync(join(root, '.git'))) initGitBaseline(root)
  const before = snapshot(root)
  const started = Date.now()
  const shouldExecute = !args.dryRun && !args.probeOnly && modelInfo.probe.ok

  let cli = null
  let parsed = null
  let parseError = null
  if (!shouldExecute) {
    cli = { status: modelInfo.probe.ok ? 0 : 1, stdout: '', stderr: modelInfo.probe.ok ? 'dry-run' : `not tested: ${modelInfo.probe.status}` }
  } else {
    cli = runCli(root, task, modelInfo.selected, args.maxTurns ?? task.maxTurns)
    try {
      parsed = JSON.parse(cli.stdout || '{}')
    } catch (e) {
      parseError = e.message
    }
  }

  const after = snapshot(root)
  const changed = changedFiles(before, after)
  const verifyRuns = shouldExecute ? runVerify(root, VERIFY_BY_RECIPE[task.recipe] ?? []) : []
  const durationMs = Date.now() - started
  const trace = parsed?.trace ?? null
  const verifyPass = verifyRuns.length > 0 && verifyRuns.every(r => r.exitCode === 0)
  const reviewGate = trace?.reviewGate ?? (task.recipe.includes('review') || task.recipe === 'bugfix' ? 'not-called' : 'n/a')
  const unrelatedTouched = task.unrelatedFiles.some(file => changed.includes(file))
  const expectedTouched = task.expectedFiles.filter(file => changed.includes(file))
  const unexpectedTouched = changed.filter(file => !task.expectedFiles.includes(file) && !task.unrelatedFiles.includes(file))
  const diffSize = diffLines(before, after, changed)
  const secretLeak = Boolean(apiKey) && (String(cli.stdout ?? '').includes(apiKey) || String(cli.stderr ?? '').includes(apiKey) || JSON.stringify(trace ?? {}).includes(apiKey))
  const malformedToolCalls = /tool|function|json|parse/i.test(`${parseError ?? ''}\n${cli.stderr ?? ''}\n${trace?.failureReason ?? ''}`) && cli.status !== 0
  const runtimeError = Boolean(parseError) || Boolean(cli.error) || /api_key_not_found|Provider config|ENOENT|spawn failed|timeout/i.test(`${cli.stderr ?? ''}\n${trace?.failureReason ?? ''}`)
  const status = classifyStatus({ args, modelInfo, cli, verifyPass, reviewGate, task, unrelatedTouched, expectedTouched, unexpectedTouched, secretLeak })

  const row = {
    provider: 'verstak-gateway',
    model: modelInfo.id,
    selectedModel: modelInfo.selected,
    recipe: task.recipe,
    result: status.result,
    exitCode: cli.status,
    turnsUsed: maxTurn(trace),
    toolCallsCount: trace?.toolCalls?.length ?? 0,
    firstMutatingTool: trace?.firstMutatingTool ?? null,
    baselineTaken: Boolean(trace?.baselineTaken),
    verifyPass,
    reviewGate,
    diffSize,
    changedFiles: changed,
    unrelatedFilesTouched: unrelatedTouched,
    malformedToolCalls,
    fallbackTriggered: /fallback/i.test(`${cli.stdout ?? ''}\n${cli.stderr ?? ''}\n${trace?.failureReason ?? ''}`),
    errorClass: runtimeError ? 'runtime error' : (cli.status === 0 ? null : 'model error'),
    failureMode: status.failureMode,
    spawnError: cli.error?.message ?? null,
    traceSecretLeak: secretLeak,
    durationMs,
    approximateCost: null,
    workspace: args.keepWorkspaces ? root : null,
    probe: modelInfo.probe,
    verifyRuns: verifyRuns.map(r => ({ command: r.command, exitCode: r.exitCode })),
    recommendation: status.recommendation,
    stdoutTail: redact(String(cli.stdout ?? '').slice(-1200), apiKey),
    stderrTail: redact(String(cli.stderr ?? '').slice(-1200), apiKey),
  }

  if (!args.keepWorkspaces) rmSync(root, { recursive: true, force: true })
  return row
}

function classifyStatus({ args, modelInfo, cli, verifyPass, reviewGate, task, unrelatedTouched, expectedTouched, unexpectedTouched, secretLeak }) {
  if (args.dryRun) return { result: 'dry-run', failureMode: 'not executed', recommendation: 'not scored' }
  if (args.probeOnly) return { result: modelInfo.probe.ok ? 'available' : 'not tested', failureMode: modelInfo.probe.status, recommendation: 'probe only' }
  if (!modelInfo.probe.ok) return { result: 'not tested', failureMode: `unavailable: ${modelInfo.probe.status}`, recommendation: 'not tested: unavailable' }
  if (secretLeak) return { result: 'fail', failureMode: 'secret leak in trace/output', recommendation: 'block for agent mode' }
  if (cli.error) return { result: 'fail', failureMode: `runner spawn failed: ${cli.error.message}`, recommendation: 'fix eval runner/runtime' }
  if (cli.status !== 0) return { result: 'fail', failureMode: 'non-zero exit', recommendation: 'do not use for this recipe yet' }
  if (!verifyPass) return { result: 'fail', failureMode: 'verify failed after run', recommendation: 'do not use for this recipe yet' }
  if (task.expectedFiles.length && expectedTouched.length === 0) return { result: 'fail', failureMode: 'expected file not changed', recommendation: 'do not use for patch recipes yet' }
  if (unrelatedTouched) return { result: 'fail', failureMode: 'unrelated file touched', recommendation: 'not suitable for agent mode' }
  if (unexpectedTouched.length > 0) return { result: 'warn', failureMode: `unexpected files changed: ${unexpectedTouched.join(', ')}`, recommendation: 'fallback only' }
  if ((task.recipe === 'bugfix' || task.recipe === 'review-before-commit') && reviewGate !== 'pass') {
    return { result: 'fail', failureMode: 'review gate not passed', recommendation: 'do not use for required-review recipes' }
  }
  return { result: 'pass', failureMode: '', recommendation: 'candidate' }
}

function maxTurn(trace) {
  const turns = (trace?.toolCalls ?? []).map(c => Number(c.turn)).filter(n => Number.isFinite(n))
  return turns.length ? Math.max(...turns) + 1 : 0
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, '-')
}

function redact(text, apiKey) {
  let out = String(text ?? '')
  if (apiKey) out = out.split(apiKey).join('[REDACTED:gateway-key]')
  out = out.replace(/vsk_live_[A-Za-z0-9._-]+/g, '[REDACTED:gateway-key]')
  out = out.replace(/sk-[A-Za-z0-9._-]{16,}/g, '[REDACTED:api-key]')
  return out
}

function buildRecommendations(rows) {
  const live = rows.filter(r => !['dry-run', 'not tested', 'available'].includes(r.result))
  const byModel = new Map()
  for (const row of live) {
    const current = byModel.get(row.model) ?? { model: row.model, pass: 0, warn: 0, fail: 0, strict: 0, recipes: new Map() }
    if (row.result === 'pass') current.pass++
    else if (row.result === 'warn') current.warn++
    else current.fail++
    if (row.result === 'pass' && !row.unrelatedFilesTouched && !row.malformedToolCalls && row.traceSecretLeak === false) current.strict++
    current.recipes.set(row.recipe, row)
    byModel.set(row.model, current)
  }
  const ranked = [...byModel.values()].sort((a, b) =>
    b.strict - a.strict ||
    b.pass - a.pass ||
    a.fail - b.fail ||
    preference(a.model) - preference(b.model)
  )
  const best = ranked.find(r => r.recipes.get('bugfix')?.result === 'pass'
    && r.recipes.get('test-fix')?.result === 'pass'
    && r.recipes.get('typescript-error')?.result === 'pass'
    && r.recipes.get('review-before-commit')?.result === 'pass')?.model
    ?? ranked[0]?.model
    ?? 'not enough data'
  const fallback = ranked.find(r => r.model !== best
    && r.recipes.get('bugfix')?.result === 'pass'
    && r.recipes.get('test-fix')?.result === 'pass'
    && r.recipes.get('typescript-error')?.result === 'pass')?.model
    ?? ranked.find(r => r.model !== best)?.model
    ?? best
  const review = ranked.find(r => r.recipes.get('review-before-commit')?.result === 'pass'
    && r.recipes.get('bugfix')?.reviewGate === 'pass')?.model
    ?? ranked.find(r => r.recipes.get('review-before-commit')?.result === 'pass')?.model
    ?? ranked.find(r => r.recipes.get('bugfix')?.reviewGate === 'pass')?.model
    ?? best
  const planner = ranked.find(r =>
    ['small-edit', 'typescript-error'].every(recipe => r.recipes.get(recipe)?.result === 'pass')
  )?.model ?? best
  const map = {}
  for (const recipe of ['bugfix', 'test-fix', 'typescript-error', 'review-before-commit']) {
    map[recipe] = ranked.find(r => r.recipes.get(recipe)?.result === 'pass')?.model ?? 'manual/stronger model'
  }
  const notForAgent = ranked.filter(r => r.fail >= Math.max(2, r.pass + r.warn)).map(r => r.model)
  return {
    defaultCodingModel: best,
    defaultFallbackModel: fallback,
    defaultReviewerModel: review,
    defaultPlannerModel: planner,
    recipeMap: map,
    presets: {
      'verstak/coder/fast': fallback,
      'verstak/coder/balanced': best,
    },
    notForAgentMode: notForAgent,
    ranked,
  }
}

function preference(model) {
  const order = [
    'qwen3-coder',
    'deepseek-chat',
    'kimi-k2.7-code',
    'verstak/coder',
    'verstak/coder/fast',
    'verstak/coder/balanced',
    'z-ai/glm-4.6',
    'deepseek-reasoner',
    'minimax-m1',
  ]
  const idx = order.indexOf(model)
  return idx === -1 ? 999 : idx
}

function renderMarkdown(rows, recommendations, meta) {
  const lines = []
  lines.push('# Cheap Model Eval Matrix - 2026-07-04')
  lines.push('')
  lines.push('Scope: headless recipe runner through Verstak Gateway, temporary workspaces only, no secrets written to report.')
  lines.push('')
  lines.push('## Run Metadata')
  lines.push('')
  lines.push(`- Provider: verstak-gateway`)
  lines.push(`- Gateway base URL for probes: ${meta.baseUrl}`)
  lines.push(`- Key present: ${meta.keyPresent ? 'yes' : 'no'}`)
  lines.push(`- Dry run: ${meta.dryRun ? 'yes' : 'no'}`)
  lines.push(`- Probe only: ${meta.probeOnly ? 'yes' : 'no'}`)
  lines.push(`- Started: ${meta.startedAt}`)
  lines.push(`- Finished: ${meta.finishedAt}`)
  lines.push('')
  lines.push('## Recommendations')
  lines.push('')
  lines.push(`1. Default coding model: ${recommendations.defaultCodingModel}`)
  lines.push(`2. Default fallback model: ${recommendations.defaultFallbackModel}`)
  lines.push(`3. Default reviewer model: ${recommendations.defaultReviewerModel}`)
  lines.push(`4. Default planner model: ${recommendations.defaultPlannerModel}`)
  lines.push(`5. bugfix -> ${recommendations.recipeMap['bugfix']}`)
  lines.push(`6. test-fix -> ${recommendations.recipeMap['test-fix']}`)
  lines.push(`7. typescript-error -> ${recommendations.recipeMap['typescript-error']}`)
  lines.push(`8. review-before-commit -> ${recommendations.recipeMap['review-before-commit']}`)
  lines.push(`9. verstak/coder/fast preset -> ${recommendations.presets['verstak/coder/fast']}`)
  lines.push(`10. verstak/coder/balanced preset -> ${recommendations.presets['verstak/coder/balanced']}`)
  lines.push(`11. Do not use in agent mode: ${recommendations.notForAgentMode.length ? recommendations.notForAgentMode.join(', ') : 'none from this run'}`)
  lines.push('')
  lines.push('## Matrix')
  lines.push('')
  lines.push('| model | recipe | result | tool discipline | diff discipline | verify | review gate | turns | failure mode | recommendation |')
  lines.push('|---|---|---:|---|---|---|---|---:|---|---|')
  for (const r of rows) {
    const toolDiscipline = [
      `calls ${r.toolCallsCount}`,
      r.firstMutatingTool ? `first mutating ${r.firstMutatingTool}` : 'no mutation',
      r.malformedToolCalls ? 'malformed yes' : 'malformed no',
      r.baselineTaken ? 'baseline yes' : 'baseline no',
    ].join('; ')
    const diffDiscipline = [
      `${r.diffSize} lines`,
      r.changedFiles.length ? r.changedFiles.join(', ') : 'no changed files',
      r.unrelatedFilesTouched ? 'unrelated yes' : 'unrelated no',
    ].join('; ')
    lines.push(`| ${esc(r.model)} | ${esc(r.recipe)} | ${esc(r.result)} | ${esc(toolDiscipline)} | ${esc(diffDiscipline)} | ${r.verifyPass ? 'pass' : 'fail'} | ${esc(String(r.reviewGate))} | ${r.turnsUsed} | ${esc(r.failureMode || '')} | ${esc(r.recommendation)} |`)
  }
  lines.push('')
  lines.push('## Blocking Runtime Bugs')
  lines.push('')
  const runtimeBugs = rows.filter(r => r.errorClass === 'runtime error' || r.traceSecretLeak)
  if (runtimeBugs.length) {
    for (const r of runtimeBugs) lines.push(`- ${r.model} / ${r.recipe}: ${r.failureMode || r.errorClass}`)
  } else {
    lines.push('- None found in this run.')
  }
  lines.push('')
  lines.push('## Raw Summary')
  lines.push('')
  for (const r of rows) {
    lines.push(`- ${r.model} / ${r.recipe}: result=${r.result}, exit=${r.exitCode}, selected=${r.selectedModel}, duration=${Math.round(r.durationMs / 1000)}s, secretLeak=${r.traceSecretLeak ? 'yes' : 'no'}`)
  }
  lines.push('')
  return lines.join('\n')
}

function esc(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()
  const apiKey = process.env.VERSTAK_GATEWAY_API_KEY || ''
  const selectedSpecs = MODEL_SPECS.filter(s => !args.models || args.models.includes(s.id) || s.aliases.some(a => args.models.includes(a)))
  const selectedTasks = TASKS.filter(t => !args.tasks || args.tasks.includes(t.id) || args.tasks.includes(t.recipe))
  if (!selectedSpecs.length) throw new Error('No models selected')
  if (!selectedTasks.length) throw new Error('No tasks selected')
  if (!args.dryRun && !args.probeOnly && !apiKey) throw new Error('VERSTAK_GATEWAY_API_KEY is missing')

  const rows = []
  const resolved = []
  for (const spec of selectedSpecs) {
    const modelInfo = await resolveModel(spec, args, apiKey)
    resolved.push(modelInfo)
    process.stderr.write(`${spec.id}: ${modelInfo.probe.ok ? `available as ${modelInfo.selected}` : `not tested: ${modelInfo.probe.status}`}\n`)
    if (args.probeOnly) {
      for (const task of selectedTasks) rows.push(await runOne(task, modelInfo, args, apiKey))
      continue
    }
    for (const task of selectedTasks) {
      if (args.limit !== null && rows.length >= args.limit) break
      process.stderr.write(`run: ${spec.id} / ${task.id}\n`)
      rows.push(await runOne(task, modelInfo, args, apiKey))
    }
    if (args.limit !== null && rows.length >= args.limit) break
  }

  const recommendations = buildRecommendations(rows)
  const meta = {
    startedAt,
    finishedAt: new Date().toISOString(),
    keyPresent: Boolean(apiKey),
    dryRun: args.dryRun,
    probeOnly: args.probeOnly,
    baseUrl: args.baseUrl,
    resolvedModels: resolved.map(r => ({ id: r.id, selected: r.selected, probe: r.probe })),
  }

  mkdirSync(dirname(args.out), { recursive: true })
  mkdirSync(dirname(args.jsonOut), { recursive: true })
  const markdown = renderMarkdown(rows, recommendations, meta)
  writeFileSync(args.out, redact(markdown, apiKey), 'utf8')
  writeFileSync(args.jsonOut, redact(JSON.stringify({ meta, rows, recommendations }, null, 2), apiKey), 'utf8')

  const leaks = rows.filter(r => r.traceSecretLeak)
  if (leaks.length) {
    console.error(`secret leak detected in ${leaks.length} run(s)`)
    process.exitCode = 2
  }
  console.log(JSON.stringify({
    ok: leaks.length === 0,
    report: args.out,
    json: args.jsonOut,
    rows: rows.length,
    keyPresent: Boolean(apiKey),
    recommendations,
  }, null, 2))
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, message: redact(err.message, process.env.VERSTAK_GATEWAY_API_KEY || '') }, null, 2))
  process.exit(1)
})
