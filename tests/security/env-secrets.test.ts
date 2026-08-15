import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import {
  ENV_KEYS_FLAG,
  ENV_SECRET_MAP,
  envKeysAllowed,
  envSecretKeys,
  resolveSecret,
} from '../../electron/env-secrets'

/**
 * Враждебное ревью 2.6.4 §2. В свежем профиле не было ни одного секрета,
 * индикатор горел «не подключён» — а первая задача ушла в Google и вернула
 * живой 403. Ключ подхватывался из `GEMINI_API_KEY` молча; у разработчика с
 * Claude Code в окружении так же лежит `ANTHROPIC_API_KEY`, и продукт начал бы
 * платить чужими деньгами. Решение штаба: без явного флага окружение не
 * читается вовсе; с флагом — читается и ВИДНО в интерфейсе.
 */
describe('ключи из окружения (§2 ревью)', () => {
  const noStore = () => null
  const withKey = { GEMINI_API_KEY: 'AIza-живой-ключ', ANTHROPIC_API_KEY: 'sk-ant-живой' }

  it('без флага ключ из окружения НЕ используется', () => {
    const env = { ...withKey } as NodeJS.ProcessEnv
    expect(envKeysAllowed(env)).toBe(false)
    expect(resolveSecret('gemini_api_key', null, env)).toEqual({ value: null, source: null })
    expect(resolveSecret('anthropic_api_key', null, env)).toEqual({ value: null, source: null })
    expect(envSecretKeys(noStore, env)).toEqual([])
  })

  it('контроль: с флагом ключ используется и назван источником env', () => {
    const env = { ...withKey, [ENV_KEYS_FLAG]: '1' } as NodeJS.ProcessEnv
    expect(envKeysAllowed(env)).toBe(true)
    expect(resolveSecret('gemini_api_key', null, env)).toEqual({ value: 'AIza-живой-ключ', source: 'env' })
    expect(envSecretKeys(noStore, env).sort()).toEqual(['anthropic_api_key', 'gemini_api_key'])
  })

  it('флаг с мусорным значением не включает подхват', () => {
    for (const raw of ['0', '', 'нет', 'false', 'off']) {
      const env = { ...withKey, [ENV_KEYS_FLAG]: raw } as NodeJS.ProcessEnv
      expect(envKeysAllowed(env)).toBe(false)
      expect(resolveSecret('gemini_api_key', null, env).value).toBe(null)
    }
  })

  it('введённый человеком ключ сильнее окружения — платит он, а не владелец env', () => {
    const env = { ...withKey, [ENV_KEYS_FLAG]: '1' } as NodeJS.ProcessEnv
    expect(resolveSecret('gemini_api_key', 'мой-собственный', env))
      .toEqual({ value: 'мой-собственный', source: 'stored' })
    // Ключ, введённый в настройках, в списке «из окружения» не значится —
    // иначе интерфейс повесил бы чужую метку на собственный ключ человека.
    const stored = (k: string) => (k === 'gemini_api_key' ? 'мой-собственный' : null)
    expect(envSecretKeys(stored, env)).toEqual(['anthropic_api_key'])
  })

  /**
   * Анти-дрейф: имя переменной окружения провайдера упоминается ровно в одном
   * файле. Второй реестр — это второй источник правды, который однажды разойдётся
   * с флагом и с показом источника в интерфейсе, и снова начнёт молчать.
   *
   * Форму пина подбирали по ПРОДОВОМУ вхождению, а не по удобному (§3.1):
   * первая редакция искала `process.env.X_API_KEY` и была бы ЗЕЛЁНОЙ на 2.6.4 —
   * там стояло `process.env[ENV_MAP[key] ?? '']`, косвенное обращение через
   * реестр `{ gemini_api_key: 'GEMINI_API_KEY', … }`. Ловим сам реестр:
   * имя в кавычках. Комментарии и имена TS-полей (claude-cli.ts, codex-oauth)
   * — законные и под пин не попадают.
   */
  const ENV_NAME_LITERAL = /['"](?:GEMINI|ANTHROPIC|OPENAI|GROQ|XAI)_API_KEY['"]/

  it('контроль: пин ловит ПРОДОВУЮ форму 2.6.4, а не только прямое обращение', () => {
    expect(ENV_NAME_LITERAL.test("  gemini_api_key: 'GEMINI_API_KEY',")).toBe(true)
    expect(ENV_NAME_LITERAL.test('const k = process.env["ANTHROPIC_API_KEY"]')).toBe(true)
    // Законные вхождения остаются законными.
    expect(ENV_NAME_LITERAL.test('   *  ни ANTHROPIC_API_KEY env, ни subscription token.')).toBe(false)
    expect(ENV_NAME_LITERAL.test('  OPENAI_API_KEY?: string | null')).toBe(false)
  })

  it('реестр переменных окружения живёт ТОЛЬКО в env-secrets.ts', () => {
    const root = join(__dirname, '..', '..', 'electron')
    const allowed = join(root, 'env-secrets.ts')
    const offenders: string[] = []

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) { walk(abs); continue }
        if (!entry.name.endsWith('.ts')) continue
        if (abs === allowed) continue
        if (ENV_NAME_LITERAL.test(readFileSync(abs, 'utf8'))) offenders.push(relative(root, abs))
      }
    }
    walk(root)

    expect(offenders).toEqual([])
  })

  it('наружу уходят только ИМЕНА ключей, значений в списке нет', () => {
    const env = { ...withKey, [ENV_KEYS_FLAG]: '1' } as NodeJS.ProcessEnv
    const names = envSecretKeys(noStore, env)
    for (const name of names) {
      expect(Object.keys(ENV_SECRET_MAP)).toContain(name)
      expect(name).not.toContain('AIza')
      expect(name).not.toContain('sk-ant')
    }
  })
})
