import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { join } from 'path'

/**
 * F14 (claw-code parity): bounded local commands verstak doctor/status/models
 * должны работать БЕЗ запуска провайдера и не зависать. --json даёт
 * machine-readable вывод; ошибки — typed error envelope.
 *
 * Тест spawn'ит реальный CLI без ключей (env очищен) — провайдер не вызывается.
 */
const CLI = join(__dirname, '..', 'scripts', 'verstak-cli.mjs')

// env без провайдерских ключей — чтобы doctor показал «не настроено», а не лез в API.
function runCli(args: string[]) {
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!/API_KEY|ANTHROPIC|XAI|OPENAI|DEEPSEEK|MISTRAL|GROQ|GIGACHAT|YANDEXGPT|OPENROUTER|GEMINI/.test(k) && v != null) {
      cleanEnv[k] = v
    }
  }
  return spawnSync('node', [CLI, ...args], { encoding: 'utf-8', env: cleanEnv, timeout: 15000 })
}

describe('verstak-cli bounded commands (F14)', () => {
  it('doctor --json: валидный JSON со списком провайдеров, exit 0, провайдер не запущен', () => {
    const r = runCli(['doctor', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.ok).toBe(true)
    expect(out.command).toBe('doctor')
    expect(out.providersTotal).toBeGreaterThan(0)
    expect(Array.isArray(out.providers)).toBe(true)
    // без ключей в env ничего не «configured via env»
    expect(out.providers.every((p: { source: string }) => p.source !== 'env')).toBe(true)
  })

  it('status — алиас doctor (exit 0)', () => {
    const r = runCli(['status', '--json'])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).command).toBe('status')
  })

  it('models --json: перечисляет провайдеров с env-переменными', () => {
    const r = runCli(['models', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.providers.find((p: { provider: string }) => p.provider === 'gemini-api')).toBeTruthy()
  })

  it('typed JSON error при отсутствии ключа (--json, без провайдера)', () => {
    const r = runCli(['--json', '-p', 'claude', 'привет'])
    expect(r.status).toBe(1)
    const err = JSON.parse(r.stderr)
    expect(err.ok).toBe(false)
    expect(err.error_code).toBe('api_key_not_found')
  })
})
