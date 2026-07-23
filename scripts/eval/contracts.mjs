import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

export const RUNNER_VERSION = 'model-gym-v0'
export const DEFAULT_PROVIDER = 'verstak-gateway'

export const DEFAULT_MODEL_SPECS = Object.freeze([
  { id: 'deepseek-chat', aliases: ['deepseek-chat'] },
  { id: 'deepseek-reasoner', aliases: ['deepseek-reasoner'] },
  { id: 'qwen3-coder', aliases: ['qwen3-coder', 'qwen/qwen3-coder'] },
  { id: 'kimi-k2.7-code', aliases: ['kimi-k2.7-code', 'moonshotai-kimi-k2', 'moonshotai/kimi-k2'] },
  { id: 'z-ai/glm-4.6', aliases: ['z-ai/glm-4.6', 'glm-4.6', 'zai-org/glm-4.6'] },
  { id: 'minimax-m1', aliases: ['minimax-m1', 'minimax/minimax-m1'] },
  { id: 'verstak/coder', aliases: ['verstak/coder'] },
  { id: 'verstak/coder/fast', aliases: ['verstak/coder/fast', 'verstak/fast'] },
  { id: 'verstak/coder/balanced', aliases: ['verstak/coder/balanced', 'verstak/balanced'] },
])

const SECRET_PATTERNS = [
  /vsk_live_[A-Za-z0-9._-]+/,
  /sk-[A-Za-z0-9._-]{16,}/,
  /(?:ghp|github_pat)_[A-Za-z0-9_]{16,}/,
  /xox[baprs]-[A-Za-z0-9-]{12,}/,
  /AKIA[0-9A-Z]{16}/,
  /Bearer\s+[A-Za-z0-9._~+\/-]{16,}/i,
]

export function parseArgs(argv, root, env = process.env) {
  const args = {
    models: null,
    tasks: null,
    suite: 'core',
    repeat: 1,
    runDate: null,
    out: join(root, 'docs', 'cheap-model-eval-2026-07-04.md'),
    jsonOut: join(root, 'docs', 'cheap-model-eval-2026-07-04.json'),
    maxTurns: null,
    dryRun: false,
    probeOnly: false,
    keepWorkspaces: false,
    skipProbe: false,
    limit: null,
    help: false,
    baseUrl: env.VERSTAK_GATEWAY_BASEURL || 'https://api-ru.agi-iri.ru/v1',
  }

  const valueAt = (index, name) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    return value
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--models') args.models = splitList(valueAt(i++, arg))
    else if (arg === '--tasks') args.tasks = splitList(valueAt(i++, arg))
    else if (arg === '--suite') args.suite = valueAt(i++, arg)
    else if (arg === '--repeat') args.repeat = parsePositiveInteger(valueAt(i++, arg), arg, 100)
    else if (arg === '--run-date') args.runDate = parseRunDate(valueAt(i++, arg))
    else if (arg === '--out') args.out = resolve(valueAt(i++, arg))
    else if (arg === '--json-out') args.jsonOut = resolve(valueAt(i++, arg))
    else if (arg === '--max-turns') args.maxTurns = parsePositiveInteger(valueAt(i++, arg), arg, 100)
    else if (arg === '--limit') args.limit = parsePositiveInteger(valueAt(i++, arg), arg, 100_000)
    else if (arg === '--base-url') args.baseUrl = valueAt(i++, arg)
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--probe-only') args.probeOnly = true
    else if (arg === '--keep-workspaces') args.keepWorkspaces = true
    else if (arg === '--skip-probe') args.skipProbe = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

export function helpText() {
  return `Usage: node scripts/eval/index.mjs [options]

Runs deterministic Model Gym fixtures through the Verstak runner.

Options:
  --suite name        Fixture suite. Default: core
  --models a,b        Model ids. Known ids use aliases; arbitrary ids are allowed.
  --tasks a,b         Optional fixture ids/recipes within the suite.
  --repeat n          Repeats per model/fixture. Default: 1
  --run-date iso      Stable ISO timestamp for reproducible reports.
  --out path          Markdown report path.
  --json-out path     JSON report path.
  --max-turns n       Override per-fixture max turns.
  --limit n           Stop after n rows.
  --base-url url      Gateway base URL for availability probes.
  --dry-run           Build deterministic rows without providers or credentials.
  --probe-only        Probe model availability without recipe execution.
  --skip-probe        Run model ids directly without availability probes.
  --keep-workspaces   Keep temporary live-run workspaces.
`
}

export function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

export function selectModelSpecs(requested) {
  if (!requested) return DEFAULT_MODEL_SPECS.map(cloneModelSpec)

  const selected = []
  const seen = new Set()
  for (const model of requested) {
    const known = DEFAULT_MODEL_SPECS.find(spec => spec.id === model || spec.aliases.includes(model))
    const spec = known ? cloneModelSpec(known) : { id: model, aliases: [model] }
    if (!seen.has(spec.id)) {
      selected.push(spec)
      seen.add(spec.id)
    }
  }
  return selected
}

export function fixtureHash(fixture) {
  return createHash('sha256')
    .update(stableStringify(fixtureContract(fixture)))
    .digest('hex')
}

export function fixtureManifestEntry(fixture) {
  return {
    id: fixture.id,
    category: fixture.category,
    recipe: fixture.recipe,
    expectedFiles: [...fixture.expectedFiles],
    unrelatedFiles: [...fixture.unrelatedFiles],
    verify: [...fixture.verify],
    requiresReview: fixture.requiresReview,
    fixtureHash: fixtureHash(fixture),
  }
}

export function validateFixture(fixture) {
  if (!fixture || typeof fixture !== 'object') throw new Error('Fixture must be an object')
  for (const field of ['id', 'recipe', 'task']) {
    if (!fixture[field] || typeof fixture[field] !== 'string') throw new Error(`Fixture ${field} is required`)
  }
  for (const field of ['expectedFiles', 'unrelatedFiles', 'verify']) {
    if (!Array.isArray(fixture[field])) throw new Error(`Fixture ${fixture.id}.${field} must be an array`)
  }
  if (!fixture.scripts || !fixture.files) throw new Error(`Fixture ${fixture.id} must declare scripts and files`)
  assertNoSecretLikeText(stableStringify(fixtureContract(fixture)), `fixture ${fixture.id}`)
  return fixture
}

export function redactSecrets(value, explicitSecrets = []) {
  let text = String(value ?? '')
  for (const secret of explicitSecrets.filter(Boolean)) text = text.split(secret).join('[REDACTED:explicit-secret]')
  text = text.replace(/vsk_live_[A-Za-z0-9._-]+/g, '[REDACTED:gateway-key]')
  text = text.replace(/sk-[A-Za-z0-9._-]{16,}/g, '[REDACTED:api-key]')
  text = text.replace(/(?:ghp|github_pat)_[A-Za-z0-9_]{16,}/g, '[REDACTED:github-token]')
  text = text.replace(/xox[baprs]-[A-Za-z0-9-]{12,}/g, '[REDACTED:slack-token]')
  text = text.replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws-key]')
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, 'Bearer [REDACTED:token]')
  return text
}

export function hasSecretLikeText(value) {
  const text = String(value ?? '')
  return SECRET_PATTERNS.some(pattern => pattern.test(text))
}

export function assertNoSecretLikeText(value, label) {
  if (hasSecretLikeText(value)) throw new Error(`${label} contains a secret-like value`)
}

export function safeBaseUrl(value, explicitSecrets = []) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '')
  } catch {
    return redactSecrets(value, explicitSecrets)
  }
}

export function getVerstakCommit(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: cleanGitEnvironment(),
  })
  const commit = String(result.stdout ?? '').trim()
  return result.status === 0 && /^[a-f0-9]{40}$/.test(commit) ? commit : 'unknown'
}

export function cleanGitEnvironment(env = process.env) {
  const clean = { ...env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
    'GIT_NAMESPACE',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) {
    delete clean[key]
  }
  return clean
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value))
}

function parsePositiveInteger(value, name, max) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`)
  }
  return parsed
}

function parseRunDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('--run-date must be a valid ISO date')
  return date.toISOString()
}

function cloneModelSpec(spec) {
  return { id: spec.id, aliases: [...spec.aliases] }
}

function fixtureContract(fixture) {
  return {
    id: fixture.id,
    fixtureVersion: fixture.fixtureVersion,
    suite: fixture.suite,
    category: fixture.category,
    recipe: fixture.recipe,
    maxTurns: fixture.maxTurns,
    expectedFiles: fixture.expectedFiles,
    unrelatedFiles: fixture.unrelatedFiles,
    verify: fixture.verify,
    requiresReview: fixture.requiresReview,
    task: fixture.task,
    scripts: fixture.scripts,
    files: fixture.files,
    afterBaselineFiles: fixture.afterBaselineFiles ?? {},
  }
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, sortValue(value[key])]),
    )
  }
  return value
}
