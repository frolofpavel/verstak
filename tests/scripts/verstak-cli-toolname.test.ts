import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'verstak-cli-test-'))
  writeFileSync(join(projectDir, 'sample.txt'), 'hello', 'utf8')

  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      reqCount++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (reqCount === 1) {
        // Имя приходит ДВАЖДЫ (полное) — воспроизводит поведение DeepSeek.
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } }] }))
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"path":"sample.txt"}' } }] } }] }))
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
      } else {
        res.write(sse({ choices: [{ delta: { content: 'готово' } }] }))
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
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
