import { describe, it, expect } from 'vitest'
import { pickReviewProvider, buildCrossVerifyPrompt, getConfiguredApiProviders } from '../../electron/ai/cross-verify'
import type { ProviderId } from '../../electron/ai/registry'

describe('pickReviewProvider — выбор ДРУГОГО провайдера для кросс-ревью (1.9.8 покрытие)', () => {
  it('берёт первого по приоритету, исключая текущего', () => {
    expect(pickReviewProvider('claude', ['claude', 'gemini-api', 'openai'])).toBe('gemini-api')
    expect(pickReviewProvider('gemini-api', ['claude', 'gemini-api'])).toBe('claude')
  })
  it('null если единственный сконфигурированный = текущий', () => {
    expect(pickReviewProvider('claude', ['claude'])).toBeNull()
    expect(pickReviewProvider('claude', [])).toBeNull()
  })
  it('FALLBACK: без priority-4 берёт любой другой API-провайдер (раньше был null)', () => {
    // Только не-priority провайдеры (DeepSeek/Qwen) — cross-verify всё равно доступен.
    const got = pickReviewProvider('deepseek' as ProviderId, ['deepseek', 'qwen'] as ProviderId[])
    expect(got).toBe('qwen')
  })
  it('текущий-CLI + priority сконфигурирован → priority', () => {
    expect(pickReviewProvider('claude-cli' as ProviderId, ['claude', 'gemini-api'])).toBe('claude')
  })
})

describe('buildCrossVerifyPrompt — сборка промпта ревью', () => {
  it('включает файлы, обрезает контент до 3KB, максимум 5 файлов', () => {
    const changes = Array.from({ length: 8 }, (_, i) => ({ file: `f${i}.ts`, type: 'write' as const, content: 'x'.repeat(5000) }))
    const prompt = buildCrossVerifyPrompt(changes)
    // Максимум 5 файлов.
    expect((prompt.match(/### f\d\.ts/g) ?? []).length).toBe(5)
    // f5..f7 не вошли.
    expect(prompt).not.toContain('### f5.ts')
    // Контент обрезан (5000 → ≤3000 в блоке).
    const block = prompt.split('```')[1]
    expect(block.replace(/\s/g, '').length).toBeLessThanOrEqual(3000)
  })
  it('просит только критические проблемы, не стиль', () => {
    const prompt = buildCrossVerifyPrompt([{ file: 'a.ts', type: 'write', content: 'code' }])
    expect(prompt).toContain('КРИТИЧЕСКИЕ')
    expect(prompt).toContain('Не комментируй стиль')
  })
})

describe('getConfiguredApiProviders — только API-провайдеры с ключами', () => {
  it('возвращает провайдеров, у которых есть ключ; CLI и без-ключа отсекает', () => {
    // Ключ есть только у claude и gemini-api (оба API).
    const keys: Record<string, string> = { anthropic_api_key: 'k1', gemini_api_key: 'k2' }
    const got = getConfiguredApiProviders((k) => keys[k] ?? null)
    expect(got).toContain('claude')
    expect(got).toContain('gemini-api')
    // CLI-провайдеры (claude-cli/codex-cli) не попадают (transport !== API).
    expect(got.some(id => id.endsWith('-cli'))).toBe(false)
  })
  it('нет ключей → пусто', () => {
    expect(getConfiguredApiProviders(() => null)).toEqual([])
  })
})
