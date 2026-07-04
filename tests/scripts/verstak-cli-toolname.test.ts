import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Регрессия для бага verstak-cli.mjs: имя tool-call аккумулировалось через +=,
// а DeepSeek/Qwen/др. шлют полное имя в КАЖДОМ streaming-delta → «read_fileread_file»
// → tool отвергался как неизвестный. Мокаем ollama-эндпоинт (ключ не нужен),
// отдаём имя в двух delta и проверяем, что записанное имя НЕ удвоено.

const CLI = resolve(__dirname, '../../scripts/verstak-cli.mjs')
const PORT = 11434 // ollama baseUrl захардкожен на localhost:11434/v1

let server: http.Server | null = null
let canBind = false
let projectDir = ''
let reqCount = 0
let recipePassReqCount = 0
let recipeFailReqCount = 0
let recipeDangerReqCount = 0

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'verstak-cli-test-'))
  writeFileSync(join(projectDir, 'sample.txt'), 'hello', 'utf8')
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: {
      type: 'node --check sum.mjs',
      'test:fast': 'node --test sum.test.mjs'
    }
  }), 'utf8')
  writeFileSync(join(projectDir, 'sum.mjs'), 'export function sum(a, b) { return a - b }\n', 'utf8')
  writeFileSync(join(projectDir, 'sum.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { sum } from './sum.mjs'\n\ntest('sum adds numbers', () => {\n  assert.equal(sum(1, 2), 3)\n})\n", 'utf8')

  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      const allText = JSON.stringify(parsed.messages ?? [])
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (allText.includes('recipe-danger')) {
        recipeDangerReqCount++
        if (recipeDangerReqCount === 1) {
          res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_danger', function: { name: 'review_before_commit', arguments: '' } }] } }] }))
          res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'review_before_commit', arguments: JSON.stringify({
            task_brief: 'try dangerous verify',
            verify_commands: ['rm should-not-delete.txt']
          }) } }] } }] }))
          res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
        } else {
          res.write(sse({ choices: [{ delta: { content: 'done despite failed dangerous gate' } }] }))
          res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
        }
      } else if (allText.includes('recipe-pass')) {
        recipePassReqCount++
        if (recipePassReqCount === 1) {
          res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_patch', function: { name: 'apply_patch', arguments: '' } }] } }] }))
          res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'apply_patch', arguments: JSON.stringify({
            path: 'sum.mjs',
            diff: '<<<<<<< SEARCH\nexport function sum(a, b) { return a - b }\n=======\nexport function sum(a, b) { return a + b }\n>>>>>>> REPLACE'
          }) } }] } }] }))
          res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
        } else if (recipePassReqCount === 2) {
          res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_review', function: { name: 'review_before_commit', arguments: '' } }] } }] }))
          res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'review_before_commit', arguments: JSON.stringify({
            task_brief: 'recipe-pass fixed sum',
            verify_commands: ['npm run type', 'npm run test:fast']
          }) } }] } }] }))
          res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
        } else {
          res.write(sse({ choices: [{ delta: { content: 'готово после gate' } }] }))
          res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
        }
      } else if (allText.includes('recipe-fail')) {
        recipeFailReqCount++
        res.write(sse({ choices: [{ delta: { content: recipeFailReqCount === 1 ? 'готово без gate' : 'всё равно готово без gate' } }] }))
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
      } else {
        reqCount++
        // Имя приходит ДВАЖДЫ (полное) — воспроизводит поведение DeepSeek.
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } }] }))
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"path":"sample.txt"}' } }] } }] }))
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((res) => {
    server!.once('error', () => { canBind = false; res() })
    server!.listen(PORT, '127.0.0.1', () => { canBind = true; res() })
  })
})

afterAll(() => {
  server?.close()
  if (projectDir) { try { rmSync(projectDir, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('verstak-cli streaming tool-call name aggregation', () => {
  it('записывает имя tool-call без удвоения когда provider шлёт имя в каждом delta', () => {
    if (!canBind) {
      // Порт 11434 занят (напр. запущен реальный ollama) — пропускаем.
      return
    }
    const out = spawnSync('node', [
      CLI, '-p', 'ollama', '-m', 'llama3.2', '--json', '--mode', 'auto',
      '--project', projectDir, 'прочитай sample.txt'
    ], { encoding: 'utf8', timeout: 30000 })

    const stdout = out.stdout || ''
    const start = stdout.indexOf('{')
    expect(start).toBeGreaterThanOrEqual(0)
    const parsed = JSON.parse(stdout.slice(start))
    expect(reqCount, 'мок-эндпоинт должен получить запрос от CLI').toBeGreaterThan(0)
    const withCalls = (parsed.messages || []).find(
      (m: any) => Array.isArray(m.toolCalls) && m.toolCalls.length
    )
    expect(withCalls, 'должно быть assistant-сообщение с tool-call').toBeTruthy()
    expect(withCalls.toolCalls[0].name).toBe('read_file')
  })
})

describe('verstak-cli headless recipe enforcement', () => {
  it('fail-closes reviewer.required recipe when the model finishes without review_before_commit', () => {
    if (!canBind) return
    const out = spawnSync('node', [
      CLI, 'recipe', 'run', '--recipe', 'bugfix', '-p', 'ollama', '-m', 'llama3.2',
      '--json', '--mode', 'auto', '--max-turns', '3',
      '--project', projectDir, '--task', 'recipe-fail: pretend to fix without gate'
    ], { encoding: 'utf8', timeout: 30000 })

    expect(out.status).toBe(1)
    const parsed = JSON.parse(out.stderr)
    expect(parsed.ok).toBe(false)
    expect(parsed.trace.finalStatus).toBe('failed')
    expect(parsed.trace.failureReason).toContain('review_before_commit')
    expect(parsed.trace.toolCalls.some((c: any) => c.name === 'review-gate-nudge')).toBe(true)
  })

  it('takes baseline before first mutation and allows final only after review gate pass', () => {
    if (!canBind) return
    writeFileSync(join(projectDir, 'sum.mjs'), 'export function sum(a, b) { return a - b }\n', 'utf8')

    const out = spawnSync('node', [
      CLI, 'recipe', 'run', '--recipe', 'bugfix', '-p', 'ollama', '-m', 'llama3.2',
      '--json', '--trace-json', '--mode', 'auto', '--max-turns', '6',
      '--project', projectDir, '--task', 'recipe-pass: fix sum implementation'
    ], { encoding: 'utf8', timeout: 120000 })

    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout)
    expect(parsed.trace.baselineTaken).toBe(true)
    expect(parsed.trace.firstMutatingTool).toBe('apply_patch')
    expect(parsed.trace.baseline.some((r: any) => r.command === 'npm run test:fast' && r.exitCode !== 0)).toBe(true)
    expect(parsed.trace.reviewGate).toBe('pass')
    expect(parsed.trace.finalStatus).toBe('success')
    expect(readFileSync(join(projectDir, 'sum.mjs'), 'utf8')).toContain('return a + b')
  })

  it('blocks dangerous verify commands inside review_before_commit', () => {
    if (!canBind) return
    const badFile = join(projectDir, 'should-not-delete.txt')
    writeFileSync(badFile, 'keep', 'utf8')
    const out = spawnSync('node', [
      CLI, 'recipe', 'run', '--recipe', 'bugfix', '-p', 'ollama', '-m', 'llama3.2',
      '--json', '--mode', 'auto', '--max-turns', '4',
      '--project', projectDir, '--task', 'recipe-danger: call review gate with rm'
    ], { encoding: 'utf8', timeout: 120000 })

    expect(out.status).toBe(1)
    const parsed = JSON.parse(out.stderr)
    expect(parsed.trace.reviewGate).toBe('fail')
    expect(parsed.trace.failureReason).toContain('allowlist')
    expect(existsSync(badFile)).toBe(true)
  })
})
