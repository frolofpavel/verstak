import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const CLI = resolve(__dirname, '../../scripts/verstak-cli.mjs')
const TEST_SECRET = 'gateway_secret_for_test_123'

let server: http.Server
let baseUrl = ''
let projectDir = ''
let seenModel = ''
let seenAuth = ''

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env },
  })
}

function runCliAsync(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null, stdout: string, stderr: string }>((resolveRun, rejectRun) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectRun(new Error('CLI timed out'))
    }, 30000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', err => {
      clearTimeout(timer)
      rejectRun(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolveRun({ status: code, stdout, stderr })
    })
  })
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'verstak-cli-provider-'))

  server = http.createServer((req, res) => {
    let body = ''
    seenAuth = String(req.headers.authorization ?? '')
    req.on('data', c => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      seenModel = parsed.model
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done through gateway' }, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') rejectListen(new Error('missing server address'))
      else {
        baseUrl = `http://127.0.0.1:${address.port}/v1`
        resolveListen()
      }
    })
  })

  mkdirSync(join(projectDir, '.verstak'), { recursive: true })
  writeFileSync(join(projectDir, '.verstak', 'settings.json'), JSON.stringify({
    verstak_gateway_api_key: TEST_SECRET,
    verstak_gateway_baseurl: baseUrl,
    model_verstak_gateway: 'verstak/fast',
    provider_configs: {
      default: {
        provider: 'verstak-gateway',
        model: 'qwen/qwen3-coder',
        apiKey: TEST_SECRET,
        baseUrl,
      },
    },
  }, null, 2), 'utf8')
})

beforeEach(() => {
  seenAuth = ''
  seenModel = ''
})

afterAll(() => {
  server?.close()
  if (projectDir) rmSync(projectDir, { recursive: true, force: true })
})

describe('verstak-cli gateway provider config resolution', () => {
  it('shows gateway/provider-config path in help', () => {
    const out = runCli(['--help'])

    expect(out.status).toBe(0)
    expect(out.stdout).toContain('verstak-gateway')
    expect(out.stdout).toContain('--provider-config')
    expect(out.stdout).toContain('VERSTAK_GATEWAY_API_KEY')
  })

  it('uses named provider config for recipe runner without leaking secrets', async () => {
    const out = await runCliAsync([
      'recipe', 'run',
      '--provider-config', 'default',
      '--recipe', 'small-edit',
      '--workspace', projectDir,
      '--task', 'return a tiny final answer',
      '--json',
      '--trace-json',
      '--max-turns', '2',
    ])

    expect(out.status).toBe(0)
    expect(seenModel).toBe('qwen/qwen3-coder')
    expect(seenAuth).toBe(`Bearer ${TEST_SECRET}`)
    expect(out.stdout).not.toContain(TEST_SECRET)
    expect(out.stderr).not.toContain(TEST_SECRET)
    const parsed = JSON.parse(out.stdout)
    expect(parsed.provider).toBe('verstak-gateway')
    expect(parsed.model).toBe('qwen/qwen3-coder')
    expect(parsed.trace.provider).toBe('verstak-gateway')
    expect(parsed.trace.model).toBe('qwen/qwen3-coder')
    expect(JSON.stringify(parsed.trace)).not.toContain(TEST_SECRET)
  })

  it('uses the shared agent policy when recipe provider/model are omitted', async () => {
    const out = await runCliAsync([
      'recipe', 'run',
      '--recipe', 'small-edit',
      '--workspace', projectDir,
      '--task', 'return a tiny final answer',
      '--json',
      '--trace-json',
      '--max-turns', '2',
    ])

    expect(out.status).toBe(0)
    expect(seenModel).toBe('kimi-k2.7-code')
    expect(seenAuth).toBe(`Bearer ${TEST_SECRET}`)
    expect(out.stdout).not.toContain(TEST_SECRET)
    expect(out.stderr).not.toContain(TEST_SECRET)
    const parsed = JSON.parse(out.stdout)
    expect(parsed.provider).toBe('verstak-gateway')
    expect(parsed.model).toBe('kimi-k2.7-code')
    expect(parsed.trace.provider).toBe('verstak-gateway')
    expect(parsed.trace.model).toBe('kimi-k2.7-code')
    expect(JSON.stringify(parsed.trace)).not.toContain(TEST_SECRET)
  })

  it('keeps explicit model selection over the shared policy', () => {
    const out = runCli([
      'recipe', 'run',
      '--provider', 'verstak-gateway',
      '--model', 'qwen3-coder',
      '--recipe', 'small-edit',
      '--workspace', projectDir,
      '--task', 'dry only',
      '--json',
      '--trace-json',
      '--dry-run',
    ])

    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout)
    expect(parsed.trace.provider).toBe('verstak-gateway')
    expect(parsed.trace.model).toBe('qwen3-coder')
  })

  it('does not use the not-recommended fast preset as a recipe default', () => {
    const out = runCli([
      'recipe', 'run',
      '--recipe', 'small-edit',
      '--workspace', projectDir,
      '--task', 'dry only',
      '--json',
      '--trace-json',
      '--dry-run',
    ])

    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout)
    expect(parsed.trace.provider).toBe('verstak-gateway')
    expect(parsed.trace.model).toBe('kimi-k2.7-code')
    expect(parsed.trace.model).not.toBe('verstak/fast')
    expect(parsed.trace.model).not.toBe('verstak/coder/fast')
  })

  it('lets explicit provider/model args win over provider config', () => {
    const out = runCli([
      'recipe', 'run',
      '--provider-config', 'default',
      '--provider', 'ollama',
      '--model', 'llama3.2',
      '--recipe', 'small-edit',
      '--workspace', projectDir,
      '--task', 'dry only',
      '--json',
      '--dry-run',
    ])

    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout)
    expect(parsed.trace.provider).toBe('ollama')
    expect(parsed.trace.model).toBe('llama3.2')
    expect(parsed.providerConfig.found).toBe(true)
  })

  it('fails clearly when requested provider config is missing', () => {
    const out = runCli([
      'recipe', 'run',
      '--provider-config', 'missing',
      '--recipe', 'small-edit',
      '--workspace', projectDir,
      '--task', 'dry only',
      '--json',
      '--dry-run',
    ])

    expect(out.status).toBe(1)
    const parsed = JSON.parse(out.stderr)
    expect(parsed.ok).toBe(false)
    expect(parsed.message).toContain('Provider config "missing" not found')
  })

  it('keeps old env-provider path working without printing the key', () => {
    const envSecret = 'deepseek_secret_for_test_456'
    const out = runCli(['doctor', '--json', '--project', projectDir], {
      DEEPSEEK_API_KEY: envSecret,
    })

    expect(out.status).toBe(0)
    expect(out.stdout).not.toContain(envSecret)
    const parsed = JSON.parse(out.stdout)
    const deepseek = parsed.providers.find((p: any) => p.provider === 'deepseek')
    expect(deepseek.configured).toBe(true)
    expect(deepseek.source).toBe('env')
  })

  it('reports missing gateway configuration with a headless-specific error', () => {
    const emptyProject = mkdtempSync(join(tmpdir(), 'verstak-cli-empty-provider-'))
    try {
      const out = runCli([
        'recipe', 'run',
        '--provider', 'verstak-gateway',
        '--recipe', 'small-edit',
        '--workspace', emptyProject,
        '--task', 'needs gateway',
        '--json',
        '--max-turns', '1',
      ], { VERSTAK_GATEWAY_API_KEY: '' })

      expect(out.status).toBe(1)
      const parsed = JSON.parse(out.stderr)
      expect(parsed.error_code).toBe('api_key_not_found')
      expect(parsed.message).toContain('Provider "verstak-gateway" is not configured for headless CLI')
    } finally {
      rmSync(emptyProject, { recursive: true, force: true })
    }
  })
})
